import { Injectable, Logger } from '@nestjs/common';

interface RobotsRules {
  /** Path prefixes the agent must not fetch. */
  disallow: string[];
  /** Path prefixes explicitly re-allowed inside a disallowed subtree. */
  allow: string[];
  /** Seconds the host asks callers to wait between requests, if stated. */
  crawlDelaySeconds: number | null;
  fetchedAt: number;
}

/**
 * Minimal `robots.txt` client.
 *
 * Checking robots is not merely polite: ignoring it is the difference between
 * a tolerated crawler and one that gets IP-banned, and in several jurisdictions
 * it is evidence of intent when a site's terms are litigated. The result is
 * cached per host so a sweep costs one extra request per host per day.
 *
 * Fail-open by design: if robots.txt cannot be fetched (404, timeout, 5xx) the
 * host is treated as unrestricted, which is what the standard prescribes.
 */
@Injectable()
export class RobotsService {
  private readonly logger = new Logger(RobotsService.name);
  private readonly cache = new Map<string, RobotsRules>();

  private static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly FETCH_TIMEOUT_MS = 5000;

  /** Rules used when robots.txt is missing or unreachable. */
  private static readonly PERMISSIVE: Omit<RobotsRules, 'fetchedAt'> = {
    disallow: [],
    allow: [],
    crawlDelaySeconds: null,
  };

  /**
   * @returns `true` when `url` may be fetched by `userAgent`.
   */
  async isAllowed(url: string, userAgent: string): Promise<boolean> {
    const rules = await this.rulesFor(url, userAgent);
    if (!rules) return true;

    const path = this.pathOf(url);

    // Longest match wins, and an explicit Allow beats a Disallow of equal or
    // shorter length — the behaviour Google and Bing implement.
    const longestDisallow = this.longestMatch(rules.disallow, path);
    const longestAllow = this.longestMatch(rules.allow, path);

    if (longestDisallow === null) return true;
    if (longestAllow === null) return false;

    return longestAllow >= longestDisallow;
  }

  /** Crawl-delay the host requests, in milliseconds. Null when unspecified. */
  async crawlDelayMs(url: string, userAgent: string): Promise<number | null> {
    const rules = await this.rulesFor(url, userAgent);
    return rules?.crawlDelaySeconds !== null && rules?.crawlDelaySeconds !== undefined
      ? rules.crawlDelaySeconds * 1000
      : null;
  }

  private async rulesFor(url: string, userAgent: string): Promise<RobotsRules | null> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return null;
    }

    const cached = this.cache.get(origin);
    if (cached && Date.now() - cached.fetchedAt < RobotsService.CACHE_TTL_MS) {
      return cached;
    }

    const rules = await this.fetchRules(origin, userAgent);
    this.cache.set(origin, rules);
    return rules;
  }

  private async fetchRules(origin: string, userAgent: string): Promise<RobotsRules> {
    try {
      const response = await fetch(`${origin}/robots.txt`, {
        signal: AbortSignal.timeout(RobotsService.FETCH_TIMEOUT_MS),
        headers: { 'user-agent': userAgent, accept: 'text/plain' },
        redirect: 'follow',
      });

      if (!response.ok) {
        return { ...RobotsService.PERMISSIVE, fetchedAt: Date.now() };
      }

      return { ...this.parse(await response.text(), userAgent), fetchedAt: Date.now() };
    } catch (error) {
      this.logger.debug(
        `robots.txt unreachable for ${origin} (${error instanceof Error ? error.message : 'unknown'}) — treating as unrestricted.`,
      );
      return { ...RobotsService.PERMISSIVE, fetchedAt: Date.now() };
    }
  }

  /**
   * Parses the directives that apply to `userAgent`, falling back to the `*`
   * group. Exposed for unit testing.
   */
  parse(content: string, userAgent: string): Omit<RobotsRules, 'fetchedAt'> {
    const agentToken = userAgent.toLowerCase().split('/')[0];
    const groups = new Map<string, string[]>();
    let currentAgents: string[] = [];
    let previousLineWasAgent = false;

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.split('#')[0].trim();
      if (!line) continue;

      const separatorIndex = line.indexOf(':');
      if (separatorIndex === -1) continue;

      const field = line.slice(0, separatorIndex).trim().toLowerCase();
      const value = line.slice(separatorIndex + 1).trim();

      if (field === 'user-agent') {
        // Consecutive User-agent lines share one group of rules.
        if (!previousLineWasAgent) currentAgents = [];
        currentAgents.push(value.toLowerCase());
        previousLineWasAgent = true;
        continue;
      }

      previousLineWasAgent = false;
      for (const agent of currentAgents) {
        const existing = groups.get(agent) ?? [];
        existing.push(`${field}:${value}`);
        groups.set(agent, existing);
      }
    }

    const directives =
      [...groups.entries()].find(([agent]) => agent !== '*' && agentToken.includes(agent))?.[1] ??
      groups.get('*') ??
      [];

    const rules: Omit<RobotsRules, 'fetchedAt'> = {
      disallow: [],
      allow: [],
      crawlDelaySeconds: null,
    };

    for (const directive of directives) {
      const separatorIndex = directive.indexOf(':');
      const field = directive.slice(0, separatorIndex);
      const value = directive.slice(separatorIndex + 1).trim();

      if (field === 'disallow' && value) rules.disallow.push(value);
      else if (field === 'allow' && value) rules.allow.push(value);
      else if (field === 'crawl-delay') {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed) && parsed >= 0) rules.crawlDelaySeconds = parsed;
      }
    }

    return rules;
  }

  /** Length of the longest rule matching `path`, or null when none matches. */
  private longestMatch(rules: string[], path: string): number | null {
    let longest: number | null = null;

    for (const rule of rules) {
      // "Disallow: /" blocks everything; a bare value never matches.
      if (path.startsWith(rule) && (longest === null || rule.length > longest)) {
        longest = rule.length;
      }
    }

    return longest;
  }

  private pathOf(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return '/';
    }
  }
}
