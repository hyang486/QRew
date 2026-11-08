import { FaceProviderError, MAX_IMAGE_BYTES, type CompareResult, type FaceProvider } from './provider.ts';
import { signV4 } from './sigv4.ts';

export type RekognitionConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Similarity floor sent to AWS; matches below it are not returned. */
  similarityThreshold: number;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Per-call limit; a timed-out call is 'transient' (retried), so the caller's cleanup still runs. */
  timeoutMs?: number;
};

export const REKOGNITION_TIMEOUT_MS = 20_000;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Maps an AWS error type + HTTP status to a provider error. Message text is never propagated. */
export function classifyAwsError(status: number, type: string | undefined, message: string | undefined): FaceProviderError {
  const t = (type ?? '').split('#').pop() ?? '';
  if (t === 'InvalidParameterException') {
    // CompareFaces reports an undetectable SOURCE face this way.
    return new FaceProviderError(/source/i.test(message ?? '') || /no faces/i.test(message ?? '') ? 'no_face_in_reference' : 'bad_image');
  }
  if (t === 'ImageTooLargeException' || t === 'InvalidImageFormatException') return new FaceProviderError('bad_image');
  if (t === 'ThrottlingException' || t === 'ProvisionedThroughputExceededException' || status === 429) return new FaceProviderError('throttled');
  if (status === 401 || status === 403 || /AccessDenied|UnrecognizedClient|InvalidSignature|ExpiredToken|IncompleteSignature/.test(t)) {
    return new FaceProviderError('auth');
  }
  return new FaceProviderError('transient');
}

export function createRekognitionProvider(cfg: RekognitionConfig): FaceProvider {
  const doFetch = cfg.fetchImpl ?? fetch;
  const now = cfg.now ?? (() => new Date());
  const host = `rekognition.${cfg.region}.amazonaws.com`;
  return {
    async compare(reference, target): Promise<CompareResult> {
      if (reference.length > MAX_IMAGE_BYTES) throw new FaceProviderError('no_face_in_reference');
      if (target.length > MAX_IMAGE_BYTES) throw new FaceProviderError('bad_image');
      const body = JSON.stringify({
        SourceImage: { Bytes: toBase64(reference) },
        TargetImage: { Bytes: toBase64(target) },
        SimilarityThreshold: cfg.similarityThreshold,
        QualityFilter: 'AUTO',
      });
      const signed = await signV4({
        method: 'POST',
        host,
        path: '/',
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'RekognitionService.CompareFaces' },
        body,
        region: cfg.region,
        service: 'rekognition',
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        now: now(),
      });
      let res: Response;
      try {
        res = await doFetch(`https://${host}/`, { method: 'POST', headers: signed.headers, body, signal: AbortSignal.timeout(cfg.timeoutMs ?? REKOGNITION_TIMEOUT_MS) });
      } catch {
        throw new FaceProviderError('transient'); // network error or timeout
      }
      let json: { FaceMatches?: { Similarity?: number }[]; UnmatchedFaces?: unknown[]; __type?: string; message?: string; Message?: string } = {};
      try {
        json = await res.json();
      } catch {
        // A success without a readable body (for example cut off by the timeout) must not become "no match".
        if (res.ok) throw new FaceProviderError('transient');
        // An error without a body falls through and is classified by status.
      }
      if (!res.ok) throw classifyAwsError(res.status, json.__type, json.message ?? json.Message);
      const sims = (json.FaceMatches ?? []).map((m) => m.Similarity ?? 0);
      const unmatched = json.UnmatchedFaces?.length ?? 0;
      return {
        similarity: sims.length ? Math.max(...sims) : null,
        targetHadFace: sims.length > 0 || unmatched > 0,
      };
    },
  };
}
