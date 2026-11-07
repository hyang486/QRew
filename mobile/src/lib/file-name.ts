/** File names for stored and exported originals. Pure, so it can be unit-tested. */

export const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'video/quicktime': 'mov',
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
};

const EXT_RE = /\.([A-Za-z0-9]{1,8})$/;
const MAX_NAME = 120;

/** File extension for the stored original: from the file name, else from the MIME type. */
export function extensionFor(fileName: string, mimeType: string) {
  const fromName = EXT_RE.exec(fileName)?.[1]?.toLowerCase();
  return fromName ?? EXT_BY_MIME[mimeType] ?? 'bin';
}

/**
 * The name a downloaded original gets on the device, so Save/Share shows the uploader's file name (M-1).
 * Path separators and control characters become "_", leading dots are dropped, an extension is ensured
 * and long names are shortened before the extension. Falls back to `<fallbackId>.<ext>` when nothing
 * usable is left.
 */
export function exportFileName(fileName: string | null | undefined, mimeType: string, fallbackId: string) {
  const ext = extensionFor(fileName ?? '', mimeType);
  let name = (fileName ?? '').normalize('NFC').replace(/[/\\:\u0000-\u001f\u007f]/g, '_').trim();
  name = name.replace(/^\.+/, '').trim();
  let stem = EXT_RE.test(name) ? name.replace(EXT_RE, '') : name;
  stem = stem.replace(/[\s.]+$/, '');
  if (!stem || /^_+$/.test(stem)) return `${fallbackId}.${ext}`;
  const room = MAX_NAME - ext.length - 1;
  if (stem.length > room) stem = Array.from(stem).slice(0, room).join('').replace(/[\s.]+$/, '');
  return `${stem}.${ext}`;
}
