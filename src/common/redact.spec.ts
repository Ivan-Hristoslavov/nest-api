import { redactEmail } from './redact';

/**
 * Logs are shipped and kept for longer than anyone plans. What goes into them
 * should be enough to recognise an account during a support call and not
 * enough to harvest a customer list.
 */
describe('redactEmail', () => {
  it('keeps the domain and the first letter', () => {
    expect(redactEmail('ivan@example.com')).toBe('i***@example.com');
  });

  it('keeps nothing of a one-letter local part, which would be the whole of it', () => {
    expect(redactEmail('a@example.com')).toBe('***@example.com');
  });

  it('handles a plus address without leaking the tag', () => {
    expect(redactEmail('ivan+stoclify@example.com')).toBe('i***@example.com');
  });

  it('says so when there is nothing to redact', () => {
    expect(redactEmail(null)).toBe('(none)');
    expect(redactEmail(undefined)).toBe('(none)');
    expect(redactEmail('')).toBe('(none)');
  });

  it('gives up safely on something that is not an address', () => {
    expect(redactEmail('not-an-email')).toBe('***');
    expect(redactEmail('@example.com')).toBe('***');
  });
});
