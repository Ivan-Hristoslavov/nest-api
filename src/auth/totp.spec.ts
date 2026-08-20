import { codeAt, fromBase32, generateSecret, otpauthUrl, toBase32, verifyCode } from './totp';

/**
 * The reason it is safe to own this code rather than depend on a package.
 *
 * RFC 6238 publishes test vectors, so "does our implementation agree with
 * every authenticator app in the world" is a question with an actual answer
 * rather than a hope. If these pass, a customer's phone and this server will
 * produce the same six digits.
 */
describe('TOTP against the RFC 6238 vectors', () => {
  // The RFC's SHA-1 secret is the ASCII string "12345678901234567890".
  const secret = toBase32(Buffer.from('12345678901234567890', 'ascii'));

  // Unix time -> expected code, from the table in RFC 6238 appendix B.
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];

  it.each(vectors)('produces the published code at %i', (seconds, expected) => {
    expect(codeAt(secret, seconds * 1000)).toBe(expected);
  });

  it('round-trips base32 without losing a byte', () => {
    const raw = Buffer.from('12345678901234567890', 'ascii');
    expect(fromBase32(toBase32(raw)).equals(raw)).toBe(true);
  });
});

describe('verifying a typed code', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;

  it('accepts the current code', () => {
    expect(verifyCode(secret, codeAt(secret, now), now)).toBe(true);
  });

  it('accepts one step either side, because phones drift', () => {
    expect(verifyCode(secret, codeAt(secret, now - 30_000), now)).toBe(true);
    expect(verifyCode(secret, codeAt(secret, now + 30_000), now)).toBe(true);
  });

  it('refuses a code two steps old', () => {
    expect(verifyCode(secret, codeAt(secret, now - 90_000), now)).toBe(false);
  });

  it('refuses rubbish without throwing', () => {
    expect(verifyCode(secret, '', now)).toBe(false);
    expect(verifyCode(secret, '12345', now)).toBe(false);
    expect(verifyCode(secret, 'abcdef', now)).toBe(false);
    expect(verifyCode(secret, '1234567', now)).toBe(false);
  });

  it('tolerates a code typed with a space in the middle', () => {
    const code = codeAt(secret, now);
    expect(verifyCode(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true);
  });
});

describe('the enrolment URI', () => {
  it('names the issuer twice, because apps read different ones', () => {
    const url = otpauthUrl('ABCDEFGH', 'kupuvach@example.com');

    expect(url.startsWith('otpauth://totp/Stoclify%3Akupuvach%40example.com?')).toBe(true);
    expect(url).toContain('issuer=Stoclify');
    expect(url).toContain('secret=ABCDEFGH');
  });
});
