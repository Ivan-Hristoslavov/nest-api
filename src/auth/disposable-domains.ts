/**
 * Mailboxes that exist to be thrown away.
 *
 * Not a security control — the list is never complete and anyone determined
 * enough registers a domain for two euros. It is a speed bump against the
 * cheapest version of the attack: a script pasting mailinator addresses to
 * farm free AI allowances.
 *
 * The real control is that a free account is not usable until somebody opens
 * the mailbox and clicks. This just makes the mailbox cost something.
 */
const DISPOSABLE = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'sharklasers.com',
  '10minutemail.com',
  '10minutemail.net',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'yopmail.com',
  'yopmail.fr',
  'maildrop.cc',
  'mailnesia.com',
  'trashmail.com',
  'trashmail.de',
  'getnada.com',
  'dispostable.com',
  'fakeinbox.com',
  'mytemp.email',
  'moakt.com',
  'emailondeck.com',
  'tempr.email',
  'discard.email',
  'spam4.me',
  'grr.la',
  'mailcatch.com',
  'inboxkitten.com',
  'burnermail.io',
  'anonaddy.me',
  'mailsac.com',
  'harakirimail.com',
  'tempmailo.com',
  '1secmail.com',
]);

/**
 * Addresses reserved by the standards for documentation and testing.
 *
 * RFC 2606 guarantees these can never receive mail, so an account keyed on one
 * can never be verified — refusing at the door says why, rather than letting
 * somebody wait for a link that physically cannot arrive.
 */
const UNROUTABLE = new Set([
  'example.com',
  'example.org',
  'example.net',
  'invalid',
  'test',
  'localhost',
]);

export type EmailVerdict = 'ok' | 'disposable' | 'unroutable';

export function classifyEmail(email: string): EmailVerdict {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  if (!domain) return 'unroutable';

  if (UNROUTABLE.has(domain) || domain.endsWith('.example') || domain.endsWith('.invalid')) {
    return 'unroutable';
  }

  return DISPOSABLE.has(domain) ? 'disposable' : 'ok';
}
