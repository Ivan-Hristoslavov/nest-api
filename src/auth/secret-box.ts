import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encrypting the one secret that cannot be hashed.
 *
 * Everything else this system holds is stored as a digest — API keys, session
 * tokens, sign-in links — because it only ever has to answer "is this the same
 * value". A TOTP secret is different: the server has to *compute* codes from
 * it, so it has to be able to read it back. Storing it in plain text would
 * mean a leaked database hands over every customer's second factor along with
 * everything the second factor was protecting, which defeats the point of
 * having one.
 *
 * So: AES-256-GCM, with the key from the environment rather than the database.
 * The two are separated on purpose — a dump of the table alone is useless
 * without the key, and that is the case the second factor is for.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Turns the configured passphrase into a key.
 *
 * SHA-256 of the passphrase rather than a KDF: this is not a password anybody
 * chose or could guess — the deployment is told to generate 32 random bytes —
 * so stretching buys nothing and only slows every sign-in.
 */
function keyFrom(passphrase: string): Buffer {
  return createHash('sha256').update(passphrase, 'utf8').digest();
}

/** Whether encryption is available at all. */
export function secretsAvailable(passphrase: string | undefined): boolean {
  return typeof passphrase === 'string' && passphrase.trim().length >= 16;
}

/**
 * Sealed as `iv.tag.ciphertext`, base64url, joined by dots.
 *
 * Self-describing so the parts can never be mixed up, and short enough to sit
 * in an ordinary varchar column.
 */
export function seal(plaintext: string, passphrase: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFrom(passphrase), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Opens a sealed value, or returns null.
 *
 * Null rather than a throw for a tampered or truncated value, and for one
 * sealed under a different key — a deployment that rotates the passphrase
 * without re-encrypting should refuse the second factor and say so, not crash
 * every sign-in on the way past.
 */
export function open(sealed: string, passphrase: string): string | null {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 3) return null;

  try {
    const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv(ALGORITHM, keyFrom(passphrase), iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
