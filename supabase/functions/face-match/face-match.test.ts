// Run: node --test supabase/functions/face-match/   (Node 24 strips types; no AWS, no network)
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import test from 'node:test';

import { MAX_ATTEMPTS, processBatch, type FaceStore, type Job } from './core.ts';
import { FaceProviderError, type FaceProvider } from './provider.ts';
import { classifyAwsError, createRekognitionProvider } from './rekognition.ts';
import { signV4 } from './sigv4.ts';

const bytes = (n: number) => new Uint8Array(n).fill(7);

function makeStore(opts: { enrollments?: string[]; jobs: Job[]; photos?: Record<string, string>; access?: 'ok' | 'room_closed' | 'not_member'; goneMedia?: string[] }) {
  const live = new Set(opts.enrollments ?? ['e1']);
  const saved: { e: string; m: string; sim: number | null; matched: boolean }[] = [];
  const finished: { id: string; status: string; error: string | null }[] = [];
  const store: FaceStore & { live: Set<string>; saved: typeof saved; finished: typeof finished } = {
    live,
    saved,
    finished,
    claimJobs: async () => opts.jobs,
    getEnrollment: async (id) => (live.has(id) ? { id, ref_path: `r/u/${id}.jpg` } : null),
    enrollmentAccess: async () => opts.access ?? 'ok',
    getPhotoPath: async (m) => (opts.goneMedia?.includes(m) ? null : opts.photos?.[m] ?? `r/${m}.jpg`),
    download: async () => bytes(10),
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
  assert.deepEqual(lines, ['provider_error {"job":"a","kind":"throttled"}']);
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
  assert.deepEqual(r, { similarity: 91.5, targetHadFace: true });
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
  assert.deepEqual(await mk(200, { FaceMatches: [], UnmatchedFaces: [{}] }).compare(bytes(1), bytes(1)), { similarity: null, targetHadFace: true });
  assert.deepEqual(await mk(200, { FaceMatches: [], UnmatchedFaces: [] }).compare(bytes(1), bytes(1)), { similarity: null, targetHadFace: false });
  await assert.rejects(mk(200, {}).compare(bytes(1), bytes(5 * 1024 * 1024 + 1)), { kind: 'bad_image' });
  await assert.rejects(mk(400, { __type: 'ThrottlingException' }).compare(bytes(1), bytes(1)), { kind: 'throttled' });
  await assert.rejects(mk(403, { __type: 'AccessDeniedException' }).compare(bytes(1), bytes(1)), { kind: 'auth' });
  await assert.rejects(mk(500, {}).compare(bytes(1), bytes(1)), { kind: 'transient' });
  assert.equal(classifyAwsError(400, 'com.amazon#InvalidParameterException', 'There are no faces in the source image').kind, 'no_face_in_reference');
});
