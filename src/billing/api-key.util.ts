import { createHash, randomBytes } from 'node:crypto';

/** Bytes of entropy per key. 32 bytes = 256 bits, far beyond brute force. */
const KEY_BYTES = 32;

/** Characters of the key kept in plaintext for identification in a UI. */
const PREFIX_LENGTH = 16;

export interface GeneratedApiKey {
  /** Shown to the customer exactly once. Never persisted. */
  plaintext: string;
  /** SHA-256 digest, hex. This is what the database stores. */
  hash: string;
  /** Leading characters, safe to display and log. */
  prefix: string;
}

/**
 * Hashes an API key for storage and lookup.
 *
 * SHA-256 rather than bcrypt/argon2 on purpose: this runs on *every* API
 * request, and a slow KDF would add tens of milliseconds to each one. A KDF
 * protects low-entropy secrets that humans choose; a 256-bit random key has no
 * dictionary to attack, so a fast digest is the correct trade-off. The security
 * comes from the entropy, not from the cost of the hash.
 */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Generates a fresh key.
 *
 * @param environment `live` or `test`, embedded in the key so a test key can
 * never be mistaken for a production one in a log or a support ticket.
 */
export function generateApiKey(environment: 'live' | 'test' = 'live'): GeneratedApiKey {
  // base64url: URL-safe, no padding, denser than hex.
  const secret = randomBytes(KEY_BYTES).toString('base64url');
  const plaintext = `pk_${environment}_${secret}`;

  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: plaintext.slice(0, PREFIX_LENGTH),
  };
}
