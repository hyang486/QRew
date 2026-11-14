// Run: node --test supabase/functions/face-match/   (Node 24 strips types; no AWS, no network)
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import test from 'node:test';

import { DETECT_TTL_MS, detectObjectPath, isDetectObjectName, staleDetectObjects } from '../_shared/detect.ts';
import { MAX_ATTEMPTS, processBatch, type FaceStore, type Job } from './core.ts';
import { FaceProviderError, type FaceProvider } from './provider.ts';
import { classifyAwsError, createRekognitionProvider } from './rekognition.ts';
import { signV4 } from './sigv4.ts';

const bytes = (n: number) => new Uint8Array(n).fill(7);

const ROOM = '11111111-1111-4111-8111-111111111111';
const OTHER_ROOM = '22222222-2222-4222-8222-222222222222';

function makeStore(opts: {
  enrollments?: string[];
  jobs: Job[];
  photos?: Record<string, string>;
  access?: 'ok' | 'room_closed' | 'not_member';
  goneMedia?: string[];
  /** room-media objects by path; when set, only these (plus face-refs) download. */
  objects?: Record<string, Uint8Array>;
  photoRoom?: Record<string, string>;
  removeFails?: boolean;
}) {
  const live = new Set(opts.enrollments ?? ['e1']);
  const saved: { e: string; m: string; sim: number | null; matched: boolean }[] = [];
  const finished: { id: string; status: string; error: string | null }[] = [];
  const removed: string[] = [];
  const downloads: string[] = [];
  const store: FaceStore & { live: Set<string>; saved: typeof saved; finished: typeof finished; removed: string[]; downloads: string[] } = {
    live,
    saved,
    finished,
    removed,
    downloads,
    claimJobs: async () => opts.jobs,
    getEnrollment: async (id) => (live.has(id) ? { id, ref_path: `r/u/${id}.jpg`, room_id: ROOM } : null),
    enrollmentAccess: async () => opts.access ?? 'ok',
    getPhoto: async (m) =>
      opts.goneMedia?.includes(m) ? null : { room_id: opts.photoRoom?.[m] ?? ROOM, fallback_path: opts.photos?.[m] ?? `r/${m}.jpg` },
    download: async (bucket, path) => {
      downloads.push(`${bucket}:${path}`);
      if (bucket === 'face-refs' || !opts.objects) return bytes(10);
      return opts.objects[path] ?? null;
    },
    removeObject: async (_bucket, path) => {
      if (opts.removeFails) throw new Error('storage down');
      removed.push(path);
    },
    saveMatch: async (e, m, r) => {
      if (!live.has(e)) return 'stale';
      saved.push({ e, m, sim: r.similarity, matched: r.matched });
      return 'saved';
    },
    finishJob: async (id, status, error) => {
      finished.push({ id, status, error });
    },
  };
  return store;
}
const job = (id: string, attempts = 0, e = 'e1'): Job => ({ id, enrollment_id: e, media_id: `m-${id}`, attempts });
const fake = (fn: FaceProvider['compare']): FaceProvider & { calls: number } => {
  const p = { calls: 0, compare: async (a: Uint8Array, b: Uint8Array) => { p.calls++; return fn(a, b); } };
  return p;
};

test('match above threshold is saved as matched, below as not matched', async () => {
  const store = makeStore({ jobs: [job('a'), job('b')] });
  const sims = [95, 60];
  const p = fake(async () => ({ similarity: sims.shift()!, targetHadFace: true }));
  const s = await processBatch(store, p, { limit: 10 });
  assert.deepEqual(store.saved.map((x) => x.matched), [true, false]);
  assert.equal(s.done, 2);
  assert.equal(s.matched, 1);
});

test('late-result guard: enrollment gone before the call -> no provider call, nothing written', async () => {
  const store = makeStore({ enrollments: [], jobs: [job('a')] });
  const p = fake(async () => ({ similarity: 99, targetHadFace: true }));
  const s = await processBatch(store, p, { limit: 10 });
  assert.equal(p.calls, 0);
  assert.equal(store.saved.length, 0);
  assert.equal(s.stale, 1);
});

test('late-result guard: enrollment deleted while the provider call is in flight -> result dropped', async () => {
  const store = makeStore({ jobs: [job('a')] });
  const p = fake(async () => {
    store.live.delete('e1'); // member leaves / room ends / re-enrolls mid-call
    return { similarity: 99, targetHadFace: true };
  });
  const s = await processBatch(store, p, { limit: 10 });
  assert.equal(p.calls, 1);
  assert.equal(store.saved.length, 0);
  assert.equal(store.finished.length, 0);
  assert.equal(s.stale, 1);
});

test('F8: expired/ended room -> no provider call, job failed room_closed, nothing written', async () => {
  const store = makeStore({ access: 'room_closed', jobs: [job('a')] });
  const p = fake(async () => ({ similarity: 99, targetHadFace: true }));
  const s = await processBatch(store, p, { limit: 10 });
  assert.equal(p.calls, 0);
  assert.equal(store.saved.length, 0);
  assert.deepEqual(store.finished, [{ id: 'a', status: 'failed', error: 'room_closed' }]);
  assert.equal(s.stale, 1);
});

test('F8: member no longer in the room -> no provider call', async () => {
  const store = makeStore({ access: 'not_member', jobs: [job('a')] });
  const p = fake(async () => ({ similarity: 99, targetHadFace: true }));
  await processBatch(store, p, { limit: 10 });
  assert.equal(p.calls, 0);
  assert.equal(store.saved.length, 0);
});

test('F8: deleted/not-ready media -> no provider call, job failed photo_unavailable', async () => {
  const store = makeStore({ goneMedia: ['m-a'], jobs: [job('a')] });
  const p = fake(async () => ({ similarity: 99, targetHadFace: true }));
  await processBatch(store, p, { limit: 10 });
  assert.equal(p.calls, 0);
  assert.deepEqual(store.finished, [{ id: 'a', status: 'failed', error: 'photo_unavailable' }]);
});

test('transient errors requeue until MAX_ATTEMPTS, then fail', async () => {
  const p = fake(async () => { throw new FaceProviderError('transient'); });
  let store = makeStore({ jobs: [job('a', 0)] });
  await processBatch(store, p, { limit: 1 });
  assert.deepEqual(store.finished, [{ id: 'a', status: 'queued', error: 'transient' }]);
  store = makeStore({ jobs: [job('a', MAX_ATTEMPTS - 1)] });
  await processBatch(store, p, { limit: 1 });
  assert.deepEqual(store.finished, [{ id: 'a', status: 'failed', error: 'transient' }]);
});

test('auth error aborts the batch and gives remaining jobs back without more calls', async () => {
  const store = makeStore({ jobs: [job('a'), job('b'), job('c')] });
  const p = fake(async () => { throw new FaceProviderError('auth'); });
  const s = await processBatch(store, p, { limit: 10 });
  assert.equal(p.calls, 1);
  assert.equal(s.aborted, true);
  assert.deepEqual(store.finished.map((f) => f.status), ['queued', 'queued', 'queued']);
});

test('no face in reference fails the job permanently; bad target photo records no-match', async () => {
  let store = makeStore({ jobs: [job('a')] });
  await processBatch(store, fake(async () => { throw new FaceProviderError('no_face_in_reference'); }), { limit: 1 });
  assert.deepEqual(store.finished, [{ id: 'a', status: 'failed', error: 'no_face_in_reference' }]);
  store = makeStore({ jobs: [job('a')] });
  await processBatch(store, fake(async () => { throw new FaceProviderError('bad_image'); }), { limit: 1 });
  assert.deepEqual(store.saved, [{ e: 'e1', m: 'm-a', sim: null, matched: false }]);
  assert.deepEqual(store.finished, [{ id: 'a', status: 'done', error: 'bad_image' }]);
});

test('logs carry job ids and error kinds only', async () => {
  const lines: string[] = [];
  const store = makeStore({ jobs: [job('a')] });
  await processBatch(store, fake(async () => { throw new FaceProviderError('throttled'); }), {
    limit: 1,
    log: (event, f) => lines.push(`${event} ${JSON.stringify(f)}`),
  });
  assert.deepEqual(lines, ['detect_fallback {"job":"a","reason":"bad_path"}', 'provider_error {"job":"a","kind":"throttled"}']);
});

// FM-Q A′-2: temporary detect copy -----------------------------------------------------------------------
const E = '33333333-3333-4333-8333-333333333333';
const M = '44444444-4444-4444-8444-444444444444';
const DETECT = `${ROOM}/${M}/detect/${E}.jpg`;
const uJob = (attempts = 0): Job => ({ id: 'j1', enrollment_id: E, media_id: M, attempts });
const PREVIEW = `${ROOM}/${M}/preview.jpg`;

test('A′-2: compares the detect copy, not the preview, and deletes it after a match', async () => {
  const detect = new Uint8Array(20).fill(1);
  const store = makeStore({ enrollments: [E], jobs: [uJob()], photos: { [M]: PREVIEW }, objects: { [DETECT]: detect, [PREVIEW]: bytes(5) } });
  let seen: Uint8Array | null = null;
  const s = await processBatch(store, fake(async (_r, t) => { seen = t; return { similarity: 99, targetHadFace: true }; }), { limit: 5 });
  assert.equal(seen, detect);
  assert.ok(!store.downloads.includes(`room-media:${PREVIEW}`));
  assert.deepEqual(store.removed, [DETECT]);
  assert.equal(s.matched, 1);
});

for (const [name, compare] of [
  ['no face (bad_image)', async () => { throw new FaceProviderError('bad_image'); }],
  ['Rekognition error', async () => { throw new FaceProviderError('transient'); }],
  ['timeout', async () => { throw new FaceProviderError('transient'); }],
  ['auth abort', async () => { throw new FaceProviderError('auth'); }],
  ['unexpected exception', async () => { throw new Error('boom'); }],
  ['no match', async () => ({ similarity: null, targetHadFace: false })],
] as const) {
  test(`A′-2: detect copy deleted in finally on ${name}`, async () => {
    const store = makeStore({ enrollments: [E], jobs: [uJob()], objects: { [DETECT]: bytes(3) } });
    await processBatch(store, fake(compare as FaceProvider['compare']), { limit: 5 });
    assert.deepEqual(store.removed, [DETECT]);
  });
}

test('A′-2: detect copy deleted when the room closed, the photo is gone, or the rooms differ', async () => {
  for (const o of [{ access: 'room_closed' as const }, { goneMedia: [M] }, { photoRoom: { [M]: OTHER_ROOM } }]) {
    const store = makeStore({ enrollments: [E], jobs: [uJob()], objects: { [DETECT]: bytes(3) }, ...o });
    const p = fake(async () => ({ similarity: 99, targetHadFace: true }));
    await processBatch(store, p, { limit: 5 });
    assert.equal(p.calls, 0);
    assert.deepEqual(store.removed, [DETECT]);
  }
});

test('A′-2: a photo from another room than the enrollment fails room_mismatch without any download', async () => {
  const store = makeStore({ enrollments: [E], jobs: [uJob()], photoRoom: { [M]: OTHER_ROOM }, objects: { [DETECT]: bytes(3) } });
  await processBatch(store, fake(async () => ({ similarity: 99, targetHadFace: true })), { limit: 5 });
  assert.deepEqual(store.finished, [{ id: 'j1', status: 'failed', error: 'room_mismatch' }]);
  assert.ok(!store.downloads.some((d) => d.startsWith('room-media:')));
});

test('A′-2: only the server-built path is read (the enrollment room, the job media, the job enrollment)', async () => {
  const otherUserCopy = `${ROOM}/${M}/detect/55555555-5555-4555-8555-555555555555.jpg`;
  const store = makeStore({ enrollments: [E], jobs: [uJob()], photos: { [M]: PREVIEW }, objects: { [otherUserCopy]: bytes(3), [PREVIEW]: bytes(5) } });
  await processBatch(store, fake(async () => ({ similarity: 10, targetHadFace: true })), { limit: 5 });
  assert.deepEqual(store.downloads.filter((d) => d.startsWith('room-media:')), [`room-media:${DETECT}`, `room-media:${PREVIEW}`]);
  assert.deepEqual(store.removed, [DETECT]); // never another member's copy
});

test('A′-2: missing or over-5MB detect copy falls back to the preview and logs why', async () => {
  for (const [objects, reason] of [
    [{ [PREVIEW]: bytes(5) }, 'missing'],
    [{ [DETECT]: bytes(5 * 1024 * 1024 + 1), [PREVIEW]: bytes(5) }, 'too_large'],
  ] as const) {
    const lines: string[] = [];
    const store = makeStore({ enrollments: [E], jobs: [uJob()], photos: { [M]: PREVIEW }, objects });
    let seen = 0;
    await processBatch(store, fake(async (_r, t) => { seen = t.length; return { similarity: 99, targetHadFace: true }; }), {
      limit: 5,
      log: (event, f) => lines.push(`${event} ${JSON.stringify(f)}`),
    });
    assert.equal(seen, 5);
    assert.deepEqual(lines.filter((l) => !l.startsWith('face_compare ')), [`detect_fallback {"job":"j1","reason":"${reason}"}`]);
    assert.equal(JSON.parse(lines.find((l) => l.startsWith('face_compare '))!.slice(13)).target, 'fallback');
  }
});

test('A′-2: a failed delete is logged without path or error text and does not fail the job', async () => {
  const lines: string[] = [];
  const store = makeStore({ enrollments: [E], jobs: [uJob()], objects: { [DETECT]: bytes(3) }, removeFails: true });
  const s = await processBatch(store, fake(async () => ({ similarity: 99, targetHadFace: true })), {
    limit: 5,
    log: (event, f) => lines.push(`${event} ${JSON.stringify(f)}`),
  });
  assert.equal(s.done, 1);
  assert.deepEqual(lines.filter((l) => !l.startsWith('face_compare ')), ['detect_delete_failed {"job":"j1"}']);
});

test('A′-2: detectObjectPath and staleDetectObjects', () => {
  assert.equal(detectObjectPath(ROOM, M, E), DETECT);
  assert.equal(detectObjectPath('../x', M, E), null);
  assert.equal(detectObjectPath(ROOM, M, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'), null);
  assert.ok(isDetectObjectName(DETECT));
  for (const n of [`${ROOM}/${M}/preview.jpg`, `${ROOM}/${M}/original.jpg`, `${ROOM}/${M}/detect/${E}.png`, `${ROOM}/${M}/detect/x/${E}.jpg`, `x/${DETECT}`]) {
    assert.ok(!isDetectObjectName(n), n);
  }
  const now = new Date('2026-11-07T12:00:00Z');
  const old = '2026-11-07T11:44:59Z';
  const fresh = '2026-11-07T11:50:00Z';
  const picked = staleDetectObjects(
    [
      { name: DETECT, createdAt: old },
      { name: `${ROOM}/${M}/detect/${'6'.repeat(8)}-6666-4666-8666-${'6'.repeat(12)}.jpg`, createdAt: fresh },
      { name: `${ROOM}/${M}/preview.jpg`, createdAt: old },
      { name: DETECT.replace(E, '77777777-7777-4777-8777-777777777777'), createdAt: 'garbage' },
    ],
    now,
  );
  assert.deepEqual(picked.map((o) => o.name), [DETECT]);
  assert.equal(DETECT_TTL_MS, 15 * 60_000);
});

test('Rekognition: a timed-out call is transient; a 200 with an unreadable body is transient, not "no match"', async () => {
  const cfg = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'x', region: 'us-east-1', similarityThreshold: 80 };
  const hang: typeof fetch = (_u, init) =>
    new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('timeout', 'TimeoutError'))));
  await assert.rejects(createRekognitionProvider({ ...cfg, fetchImpl: hang, timeoutMs: 10 }).compare(bytes(3), bytes(3)), (e) => e instanceof FaceProviderError && e.kind === 'transient');
  const cut: typeof fetch = async () => new Response('{"FaceMat', { status: 200 });
  await assert.rejects(createRekognitionProvider({ ...cfg, fetchImpl: cut }).compare(bytes(3), bytes(3)), (e) => e instanceof FaceProviderError && e.kind === 'transient');
});

test('SigV4 matches the AWS documentation vector (iam ListUsers, 20150830)', async () => {
  const out = await signV4({
    method: 'GET',
    host: 'iam.amazonaws.com',
    path: '/',
    query: 'Action=ListUsers&Version=2010-05-08',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: '',
    region: 'us-east-1',
    service: 'iam',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    now: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(out.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
});

test('SigV4 agrees with an independent node:crypto derivation', async () => {
  const secret = 'not-a-real-secret';
  const now = new Date('2026-11-04T12:00:00Z');
  const body = '{"a":1}';
  const out = await signV4({ method: 'POST', host: 'rekognition.us-west-2.amazonaws.com', path: '/', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'RekognitionService.CompareFaces' }, body, region: 'us-west-2', service: 'rekognition', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: secret, now });
  const h = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
  const k = h(h(h(h('AWS4' + secret, '20261104'), 'us-west-2'), 'rekognition'), 'aws4_request');
  assert.equal(out.signature, createHmac('sha256', k).update(out.stringToSign).digest('hex'));
  assert.ok(out.stringToSign.includes(createHash('sha256').update('POST\n/\n\ncontent-type:application/x-amz-json-1.1\nhost:rekognition.us-west-2.amazonaws.com\nx-amz-date:20261104T120000Z\nx-amz-target:RekognitionService.CompareFaces\n\ncontent-type;host;x-amz-date;x-amz-target\n' + createHash('sha256').update(body).digest('hex')).digest('hex')));
});

test('Rekognition provider: request shape, response parsing, no secret in the request, injected fetch only', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const provider = createRekognitionProvider({
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'SECRET-VALUE-XYZ', region: 'us-west-2', similarityThreshold: 80,
    now: () => new Date('2026-11-04T12:00:00Z'),
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ FaceMatches: [{ Similarity: 91.5 }, { Similarity: 88 }], UnmatchedFaces: [] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const r = await provider.compare(bytes(20), bytes(30));
  assert.deepEqual({ similarity: r.similarity, targetHadFace: r.targetHadFace }, { similarity: 91.5, targetHadFace: true });
  assert.equal(JSON.parse(seen[0].init.body as string).QualityFilter, 'AUTO');
  assert.deepEqual(Object.keys(JSON.parse(seen[0].init.body as string)).sort(), ['QualityFilter', 'SimilarityThreshold', 'SourceImage', 'TargetImage']);
  assert.equal(seen[0].url, 'https://rekognition.us-west-2.amazonaws.com/');
  const headers = seen[0].init.headers as Record<string, string>;
  assert.equal(headers['x-amz-target'], 'RekognitionService.CompareFaces');
  assert.ok(headers.authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261104/us-west-2/rekognition/aws4_request'));
  assert.ok(!JSON.stringify(seen[0]).includes('SECRET-VALUE-XYZ'));
  assert.equal(JSON.parse(seen[0].init.body as string).SimilarityThreshold, 80);
});

test('Rekognition provider: empty matches / oversize / HTTP errors map to the right kinds', async () => {
  const mk = (status: number, body: unknown) =>
    createRekognitionProvider({ accessKeyId: 'a', secretAccessKey: 'b', region: 'us-west-2', similarityThreshold: 80, fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch });
  const core = ({ similarity, targetHadFace }: { similarity: number | null; targetHadFace: boolean }) => ({ similarity, targetHadFace });
  assert.deepEqual(core(await mk(200, { FaceMatches: [], UnmatchedFaces: [{}] }).compare(bytes(1), bytes(1))), { similarity: null, targetHadFace: true });
  assert.deepEqual(core(await mk(200, { FaceMatches: [], UnmatchedFaces: [] }).compare(bytes(1), bytes(1))), { similarity: null, targetHadFace: false });
  await assert.rejects(mk(200, {}).compare(bytes(1), bytes(5 * 1024 * 1024 + 1)), { kind: 'bad_image' });
  await assert.rejects(mk(400, { __type: 'ThrottlingException' }).compare(bytes(1), bytes(1)), { kind: 'throttled' });
  await assert.rejects(mk(403, { __type: 'AccessDeniedException' }).compare(bytes(1), bytes(1)), { kind: 'auth' });
  await assert.rejects(mk(500, {}).compare(bytes(1), bytes(1)), { kind: 'transient' });
  assert.equal(classifyAwsError(400, 'com.amazon#InvalidParameterException', 'There are no faces in the source image').kind, 'no_face_in_reference');
});

// Similarity-only logging (item 8) ---------------------------------------------------------------------------
const LOG_KEYS = ['job', 'room', 'media', 'target', 'quality_filter', 'provider_floor', 'threshold', 'best_similarity', 'matched', 'target_had_face', 'outcome', 'faces'].sort();

test('Rekognition detail: box size only (no position, landmarks or face ids), floor and filter recorded', async () => {
  const body = {
    SourceImageFace: { BoundingBox: { Width: 0.3, Height: 0.4, Left: 0.1, Top: 0.2 }, Confidence: 99 },
    FaceMatches: [{ Similarity: 84.27, Face: { BoundingBox: { Width: 0.08612, Height: 0.1013, Left: 0.41, Top: 0.12 }, Confidence: 99.9, Landmarks: [{ X: 0.4, Y: 0.1 }], FaceId: 'leak-id' } }],
    UnmatchedFaces: [{ BoundingBox: { Width: 0.05, Height: 0.06, Left: 0.7, Top: 0.3 }, Landmarks: [{ X: 0.7 }] }, {}],
  };
  const provider = createRekognitionProvider({ accessKeyId: 'a', secretAccessKey: 'b', region: 'us-east-2', similarityThreshold: 80, fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch });
  const r = await provider.compare(bytes(1), bytes(1));
  assert.equal(r.similarity, 84.27);
  assert.equal(r.targetHadFace, true);
  assert.deepEqual(r.detail, {
    qualityFilter: 'AUTO',
    providerFloor: 80,
    matches: [{ similarity: 84.27, box: { w: 0.086, h: 0.101 } }],
    unmatched: [{ box: { w: 0.05, h: 0.06 } }, { box: null }],
  });
  const text = JSON.stringify(r.detail);
  for (const leak of ['Left', 'Top', 'Landmarks', 'leak-id', 'Confidence', '0.41', '0.7']) assert.ok(!text.includes(leak), leak);
});

test('face_compare log: only the allowed fields, no bytes/paths/user or enrollment ids; match rule unchanged', async () => {
  const cases = [
    { sim: 95, had: true, matched: true, outcome: 'matched', detail: { qualityFilter: 'AUTO', providerFloor: 80, matches: [{ similarity: 95.04, box: { w: 0.2, h: 0.25 } }], unmatched: [{ box: { w: 0.1, h: 0.1 } }] } },
    { sim: 89.96, had: true, matched: false, outcome: 'below_threshold', detail: { qualityFilter: 'AUTO', providerFloor: 80, matches: [{ similarity: 89.96, box: { w: 0.09, h: 0.1 } }], unmatched: [] } },
    { sim: 90, had: true, matched: true, outcome: 'matched', detail: undefined },
    { sim: null, had: true, matched: false, outcome: 'below_floor', detail: { qualityFilter: 'AUTO', providerFloor: 80, matches: [], unmatched: [{ box: { w: 0.08, h: 0.1 } }] } },
    { sim: null, had: false, matched: false, outcome: 'no_face_returned', detail: { qualityFilter: 'AUTO', providerFloor: 80, matches: [], unmatched: [] } },
  ];
  for (const c of cases) {
    const logs: { event: string; f: Record<string, unknown> }[] = [];
    const store = makeStore({ enrollments: [E], jobs: [uJob()], photos: { [M]: PREVIEW }, objects: { [DETECT]: bytes(4) } });
    const s = await processBatch(store, fake(async () => ({ similarity: c.sim, targetHadFace: c.had, detail: c.detail })), {
      limit: 1,
      log: (event, f) => logs.push({ event, f }),
    });
    // Match rule and stored result unchanged: >= 90 matches, the raw similarity is saved.
    assert.deepEqual(store.saved.map((x) => [x.sim, x.matched]), [[c.sim, c.matched]]);
    assert.equal(s.matched, c.matched ? 1 : 0);
    const line = logs.filter((l) => l.event === 'face_compare');
    assert.equal(line.length, 1);
    const f = line[0].f;
    assert.deepEqual(Object.keys(f).sort(), LOG_KEYS);
    assert.equal(f.room, ROOM);
    assert.equal(f.media, M);
    assert.equal(f.target, 'detect');
    assert.equal(f.threshold, 90);
    assert.equal(f.matched, c.matched);
    assert.equal(f.outcome, c.outcome);
    assert.equal(f.best_similarity, c.sim === null ? null : Math.round(c.sim * 10) / 10);
    assert.equal(f.quality_filter, c.detail ? 'AUTO' : null);
    for (const face of f.faces as Record<string, unknown>[]) assert.deepEqual(Object.keys(face).sort(), ['box', 'i', 'returned', 'similarity']);
    const text = JSON.stringify(f);
    for (const leak of [E, DETECT, PREVIEW, 'face-refs', 'detect/', 'Left', 'Top']) assert.ok(!text.includes(leak), leak);
  }
});

test('face_compare is not logged when no provider call happens or the call fails', async () => {
  const logs: string[] = [];
  const store = makeStore({ jobs: [job('a')] });
  await processBatch(store, fake(async () => { throw new FaceProviderError('transient'); }), { limit: 1, log: (e) => logs.push(e) });
  const gone = makeStore({ enrollments: [], jobs: [job('b')] });
  await processBatch(gone, fake(async () => ({ similarity: 99, targetHadFace: true })), { limit: 1, log: (e) => logs.push(e) });
  assert.ok(!logs.includes('face_compare'));
});
