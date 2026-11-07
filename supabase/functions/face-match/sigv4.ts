// Minimal AWS Signature Version 4 signer (Web Crypto only; no SDK, no network).

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

export type SignInput = {
  method: string;
  host: string;
  path: string; // already URI-encoded, e.g. "/"
  query?: string; // canonical query string, "" if none
  /** Headers to sign besides host and x-amz-date. Names are lowercased here. */
  headers: Record<string, string>;
  body: string | Uint8Array;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Request time. Injected so tests are deterministic. */
  now: Date;
};

export type SignOutput = { headers: Record<string, string>; signature: string; stringToSign: string };

export async function signV4(input: SignInput): Promise<SignOutput> {
  const amzDate = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const all: Record<string, string> = { host: input.host, 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(input.headers)) all[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method,
    input.path,
    input.query ?? '',
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(input.body),
  ].join('\n');
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = await hmac(enc.encode(`AWS4${input.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, input.service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));
  return {
    signature,
    stringToSign,
    headers: {
      ...all,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
