import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * Written out rather than pulled in, because it is forty lines of HMAC and a
 * dependency in the authentication path is a dependency that can be taken over
 * — and this one would be handed every second factor in the system. The
 * algorithm has not changed since 2011 and is pinned by test vectors in
 * `totp.spec.ts`, which is the whole reason it is safe to own.
 *
 * SHA-1 is not a mistake here: RFC 6238 specifies it, every authenticator app
 * implements it, and the property being relied on is HMAC's, not the hash's
 * collision resistance. An app that cannot read our codes is worth nothing.
 */
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * How many steps either side of now are accepted.
 *
 * One, so a code is good for about ninety seconds. Phones drift, people finish
 * typing late, and the alternative is a support queue of "it says invalid".
 * Widening this further is how a stolen code stays useful.
 */
const DRIFT_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A fresh secret, in the base32 an authenticator app expects. */
export function generateSecret(bytes = 20): string {
  return toBase32(randomBytes(bytes));
}

export function toBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];

  return out;
}

export function fromBase32(secret: string): Buffer {
  const cleaned = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const character of cleaned) {
    const index = BASE32.indexOf(character);
    if (index === -1) continue;

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** The code for one counter step. */
function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  // Written as two 32-bit halves: `writeBigUInt64BE` would need the counter as
  // a BigInt, and the value here is always far inside the safe integer range.
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;

  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code for a moment in time. Exported for the tests and for enrolment. */
export function codeAt(secret: string, atMs: number = Date.now()): string {
  return hotp(fromBase32(secret), Math.floor(atMs / 1000 / PERIOD_SECONDS));
}

/**
 * Whether a typed code is right, allowing for clock drift.
 *
 * Compared in constant time. The window makes a timing attack close to
 * pointless anyway, but "close to" is not a thing to build an authentication
 * check on.
 */
export function verifyCode(secret: string, code: string, atMs: number = Date.now()): boolean {
  const typed = String(code || '').replace(/\D/g, '');
  if (typed.length !== DIGITS) return false;

  const key = fromBase32(secret);
  if (key.length === 0) return false;

  const step = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  const typedBuffer = Buffer.from(typed, 'utf8');

  let matched = false;

  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift += 1) {
    const candidate = Buffer.from(hotp(key, step + drift), 'utf8');
    // `reduce`-style accumulation rather than an early return, so the number of
    // comparisons does not depend on which step matched.
    matched = timingSafeEqual(candidate, typedBuffer) || matched;
  }

  return matched;
}

/**
 * The URI an authenticator app scans.
 *
 * The issuer appears twice — once in the label and once as a parameter —
 * because different apps read different ones, and an entry that shows up as
 * a bare email address among thirty others is an entry nobody can identify.
 */
export function otpauthUrl(secret: string, account: string, issuer = 'Stoclify'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });

  return `otpauth://totp/${label}?${parameters.toString()}`;
}
