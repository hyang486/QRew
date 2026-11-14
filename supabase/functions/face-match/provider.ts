// Provider boundary for face comparison. The worker (core.ts) only sees this
// interface, so tests run with a fake and nothing here touches the network.

/** Rekognition accepts JPEG/PNG up to 5 MB when bytes are sent inline. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type CompareResult = {
  /** Best similarity (0-100) of any face in the target against the reference face; null if no face matched. */
  similarity: number | null;
  /** True when the target contained at least one face. */
  targetHadFace: boolean;
  /** Diagnostics for the face_compare log only. Never used for the match decision. */
  detail?: CompareDetail;
};

/** Face box size as a fraction of the image (0-1, 3 decimals). No position, landmarks or face IDs. */
export type FaceBoxSize = { w: number; h: number };

export type CompareDetail = {
  /** QualityFilter sent with the request (AUTO today). */
  qualityFilter: string;
  /** SimilarityThreshold sent to the provider; faces under it come back as unmatched with no score. */
  providerFloor: number;
  /** Faces returned at or above providerFloor, in response order. */
  matches: { similarity: number; box: FaceBoxSize | null }[];
  /** Faces detected but under providerFloor, in response order. */
  unmatched: { box: FaceBoxSize | null }[];
};

export type FaceProviderErrorKind =
  | 'no_face_in_reference' // permanent: the enrollment photo has no usable face
  | 'bad_image' // permanent for this target: unsupported format or too large
  | 'throttled' // retry later
  | 'transient' // retry later (5xx, network)
  | 'auth'; // credentials missing/invalid/denied: stop the whole batch

/** Messages must never contain keys or image bytes; only the kind is persisted. */
export class FaceProviderError extends Error {
  readonly kind: FaceProviderErrorKind;
  constructor(kind: FaceProviderErrorKind) {
    super(kind);
    this.name = 'FaceProviderError';
    this.kind = kind;
  }
}

export interface FaceProvider {
  compare(reference: Uint8Array, target: Uint8Array): Promise<CompareResult>;
}
