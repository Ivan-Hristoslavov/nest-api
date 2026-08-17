import { generateApiKey, hashApiKey } from './api-key.util';

describe('api key generation', () => {
  it('produces a prefixed, environment-tagged key', () => {
    const live = generateApiKey('live');
    const test = generateApiKey('test');

    expect(live.plaintext.startsWith('pk_live_')).toBe(true);
    expect(test.plaintext.startsWith('pk_test_')).toBe(true);
  });

  it('never repeats a key', () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKey().plaintext));

    expect(keys.size).toBe(500);
  });

  it('carries at least 256 bits of entropy', () => {
    const secret = generateApiKey().plaintext.replace('pk_live_', '');

    // base64url encodes 6 bits per character; 32 bytes -> 43 characters.
    expect(secret.length).toBeGreaterThanOrEqual(43);
  });

  it('stores a hash that does not reveal the key', () => {
    const generated = generateApiKey();

    expect(generated.hash).toHaveLength(64);
    expect(generated.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.hash).not.toContain(generated.plaintext);
  });

  it('hashes deterministically, so a presented key can be looked up', () => {
    const generated = generateApiKey();

    expect(hashApiKey(generated.plaintext)).toBe(generated.hash);
  });

  it('produces a prefix short enough to display but long enough to identify', () => {
    const generated = generateApiKey();

    expect(generated.prefix).toHaveLength(16);
    expect(generated.plaintext.startsWith(generated.prefix)).toBe(true);
  });
});
