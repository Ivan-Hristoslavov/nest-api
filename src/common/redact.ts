/**
 * An email address, shortened for a log line.
 *
 * Logs are shipped, kept and read by more people and systems than the database
 * is, and the privacy policy describes the technical journals as holding "IP
 * address, time and path". A full mailing list of every customer, assembled
 * one sign-in at a time, is not that.
 *
 * The domain stays whole and the first character survives, which is what makes
 * a log line useful during a support call: somebody reading "и***@example.com"
 * next to an account id can tell whether it is the person on the phone. Nobody
 * reading the log can collect addresses out of it.
 *
 *   ivan@example.com  ->  i***@example.com
 *   a@example.com     ->  ***@example.com
 */
export function redactEmail(value: string | null | undefined): string {
  if (!value) return '(none)';

  const at = value.lastIndexOf('@');
  if (at <= 0) return '***';

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);

  // One character is no anonymity at all, so a one-character local part keeps
  // nothing rather than everything.
  const head = local.length > 1 ? local[0] : '';

  return `${head}***@${domain}`;
}
