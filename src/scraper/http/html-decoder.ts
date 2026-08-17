import { decode, encodingExists } from 'iconv-lite';

/** Only the first part of the document can hold a charset declaration. */
const META_SCAN_BYTES = 2048;

/**
 * Decodes a fetched page into a string using the character set it actually
 * declares.
 *
 * A large share of Bulgarian retail and classifieds sites — mobile.bg among
 * them — still serve `windows-1251`. Decoding those bytes as UTF-8 does not
 * throw; it silently produces mojibake, the price text stops matching anything,
 * and the listing looks like a site that simply "has no price". This is one of
 * the least obvious ways a scraper can be wrong.
 *
 * Detection order follows the HTML spec's precedence:
 *   1. `charset` in the `Content-Type` response header;
 *   2. `<meta charset>` or `<meta http-equiv="content-type">` in the head;
 *   3. UTF-8, unless the bytes are not valid UTF-8 — in which case
 *      `windows-1251` is the overwhelmingly likely intent for this market.
 */
export function decodeHtml(body: Buffer, contentTypeHeader?: string): string {
  const fromHeader = charsetFrom(contentTypeHeader);
  if (fromHeader && encodingExists(fromHeader)) {
    return decode(body, fromHeader);
  }

  // The meta tag is ASCII-compatible in every encoding we care about, so a
  // latin1 peek at the head is safe and avoids decoding twice.
  const head = body.subarray(0, META_SCAN_BYTES).toString('latin1');
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(head)?.[1] ??
    charsetFrom(/<meta[^>]+content\s*=\s*["']([^"']*charset[^"']*)["']/i.exec(head)?.[1]);

  if (fromMeta && encodingExists(fromMeta)) {
    return decode(body, fromMeta);
  }

  return isValidUtf8(body) ? body.toString('utf8') : decode(body, 'windows-1251');
}

function charsetFrom(value?: string): string | null {
  if (!value) return null;
  const match = /charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(value);
  return match ? match[1].toLowerCase() : null;
}

/**
 * `Buffer.toString('utf8')` never fails — it substitutes U+FFFD — so validity
 * has to be checked by round-tripping through the strict decoder.
 */
function isValidUtf8(body: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}
