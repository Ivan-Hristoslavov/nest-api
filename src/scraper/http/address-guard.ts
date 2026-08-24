import { lookup as dnsLookup, LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import { lookup as dnsLookupAsync } from 'node:dns/promises';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Keeps the scraper on the public internet.
 *
 * Every URL this service fetches was typed in by a customer: the page of a
 * competitor's listing, or a supplier's search template. Nothing about that is
 * unusual for a price comparison — but it means an ordinary signed-up account,
 * on the free plan and without a card, can ask this server to make a request
 * on its behalf. Left unchecked, the address it asks for can be one only this
 * server can reach: another service on the same host, something inside the
 * private network, or the cloud's metadata endpoint, which hands out the
 * machine's own credentials to anything that asks from the inside.
 *
 * Two layers, because one is not enough:
 *
 * 1. {@link assertPublicHttpUrl} rejects the obvious cases at the moment the
 *    customer submits them, so they get a sentence explaining why rather than
 *    a scrape that quietly fails for days.
 *
 * 2. {@link guardedLookup} is the one that actually enforces it. Handed to the
 *    HTTP agent, it runs for *every* connection the client opens — including
 *    the ones a redirect opens, which the first layer never sees, and it
 *    checks the address DNS actually returned rather than the name that was
 *    typed. `evil.example.com` resolving to 127.0.0.1 is a public-looking
 *    hostname and a private address, and only this layer can tell.
 */

/**
 * Ranges no customer-supplied URL has any business reaching.
 *
 * Sources are RFC 1918 (private), RFC 3927 and RFC 4291 (link-local), RFC 6598
 * (carrier NAT) and RFC 4193 (unique local). `169.254.169.254` needs no entry
 * of its own — it lives inside the link-local block, which is why that block
 * matters far more than its name suggests.
 */
const BLOCKED = new BlockList();

BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
BLOCKED.addSubnet('10.0.0.0', 8, 'ipv4'); // private
BLOCKED.addSubnet('100.64.0.0', 10, 'ipv4'); // carrier-grade NAT
BLOCKED.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, incl. cloud metadata
BLOCKED.addSubnet('172.16.0.0', 12, 'ipv4'); // private
BLOCKED.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
BLOCKED.addSubnet('192.168.0.0', 16, 'ipv4'); // private
BLOCKED.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
BLOCKED.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved, incl. broadcast

BLOCKED.addAddress('::', 'ipv6'); // unspecified
BLOCKED.addAddress('::1', 'ipv6'); // loopback
BLOCKED.addSubnet('fc00::', 7, 'ipv6'); // unique local
BLOCKED.addSubnet('fe80::', 10, 'ipv6'); // link-local
BLOCKED.addSubnet('ff00::', 8, 'ipv6'); // multicast

/** Raised when a URL points somewhere only this server can reach. */
export class BlockedAddressError extends Error {
  constructor(readonly host: string) {
    super(
      `"${host}" resolves to an address on this server's own network. ` +
        'Only publicly reachable shops can be checked.',
    );
    this.name = 'BlockedAddressError';
  }
}

/**
 * Is this a literal address the scraper must not open?
 *
 * `::ffff:127.0.0.1` is unwrapped first: it is an IPv4 loopback wearing an
 * IPv6 spelling, and checked as written it matches no IPv6 rule here.
 */
export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const candidate = mapped ? mapped[1] : address;

  const version = isIP(candidate);
  if (version === 0) return false;

  return BLOCKED.check(candidate, version === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Checks a URL a customer typed, before it is stored.
 *
 * Deliberately does no DNS: this runs inside request validation, where a
 * lookup would let anyone use the endpoint to time name resolution. It catches
 * the wrong scheme and the literal addresses, and leaves the rest to
 * {@link guardedLookup}, which sees what the name actually resolves to.
 *
 * @throws BlockedAddressError when the address is one we refuse to open.
 * @throws TypeError when the string is not an http(s) URL at all.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`"${raw}" is not a URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`"${url.protocol}" is not a protocol this service fetches.`);
  }

  // `new URL` keeps the brackets on an IPv6 host; the block list wants it bare.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isBlockedAddress(host)) {
    throw new BlockedAddressError(host);
  }

  return url;
}

/**
 * The DNS lookup an outbound agent should use.
 *
 * Signature matches `dns.lookup`, because that is what `http.Agent` calls. The
 * agent calls it once per connection, so a redirect chain is checked at every
 * hop, and the answer is inspected rather than the question — which is the
 * only way to catch a public name pointing at a private address.
 */
export function guardedLookup(
  hostname: string,
  options: LookupOneOptions | LookupAllOptions | number,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, options as never, (error, address: string | LookupAddress[], family) => {
    if (error) {
      callback(error, address, family);
      return;
    }

    // `{ all: true }` answers with every record; without it, with one string.
    const addresses = Array.isArray(address)
      ? address.map((entry) => entry.address)
      : [address as string];

    const offender = addresses.find((entry) => isBlockedAddress(entry));

    if (offender) {
      const blocked = new BlockedAddressError(hostname) as NodeJS.ErrnoException;
      // A code the agent will surface rather than swallow, and one that reads
      // correctly in a log next to ECONNREFUSED and ENOTFOUND.
      blocked.code = 'EBLOCKEDADDRESS';
      callback(blocked, address, family);
      return;
    }

    callback(null, address, family);
  });
}

/**
 * Agents for an outbound client that fetches customer-supplied addresses.
 *
 * Every axios instance in this service points at somewhere a customer chose,
 * so every one of them gets these. Connections are pooled — a sweep opens many
 * to the same handful of shops — and each new one goes through
 * {@link guardedLookup} on the way out.
 */
export function guardedAgents(): { httpAgent: HttpAgent; httpsAgent: HttpsAgent } {
  return {
    httpAgent: new HttpAgent({ keepAlive: true, lookup: guardedLookup }),
    httpsAgent: new HttpsAgent({ keepAlive: true, lookup: guardedLookup }),
  };
}

/**
 * Resolves a URL and refuses it if any answer is private.
 *
 * For the one caller that uses `fetch` rather than an agent, where
 * {@link guardedLookup} has nothing to hook into. There is a gap between this
 * check and the connection that a determined DNS server could exploit; it is
 * narrow, and the alternative — leaving robots.txt as the single unguarded
 * request in the service — is worse.
 *
 * @throws BlockedAddressError
 */
export async function assertResolvesPublicly(raw: string): Promise<void> {
  const url = assertPublicHttpUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');

  // A literal address has nothing to resolve, and was checked above.
  if (isIP(host) !== 0) return;

  const answers = await dnsLookupAsync(host, { all: true });

  if (answers.some((answer) => isBlockedAddress(answer.address))) {
    throw new BlockedAddressError(host);
  }
}
