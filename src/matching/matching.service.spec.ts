import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { User, UserPlan } from '../billing/entities/user.entity';
import { AiMatchOutcome, AiMatchRequest, ClaudeService } from './claude.service';
import { MatchCache } from './entities/match-cache.entity';
import { MatchCandidate, MatchingService, fingerprint } from './matching.service';
import { normaliseProductName } from './normalisation';

/**
 * The orchestrator's job is to spend as little as possible and never to let a
 * model overrule arithmetic. These pin both: what reaches the model, and what
 * the model is allowed to do to the answer once it replies.
 */
describe('MatchingService', () => {
  const QUERY = 'Philips LED 12W E27 4000K';

  /**
   * Listings a model can settle and arithmetic cannot: the brand agrees and
   * every specification is encoded rather than stated. "840" is 4000K and 80
   * CRI, and nothing deterministic knows that.
   *
   * A cross-language listing that *states* its specifications — "LED Lampe
   * 12W E27 neutralweiss" — is deliberately not used here: since categories
   * and roles landed, those are settled for nothing, which is the point.
   */
  const ambiguous: MatchCandidate[] = [
    { id: 'a', name: 'Philips CorePro 840 неутрална светлина', supplier: 'Склад А' },
    { id: 'b', name: 'Philips крушка CorePro 840', supplier: 'Склад Б' },
  ];

  async function build(options: {
    aiEnabled?: boolean;
    aiVerdicts?: Array<{ id: string; same: boolean; confidence: number; reason: string }>;
    cached?: Array<Partial<MatchCache>>;
    user?: Partial<User>;
  }) {
    const claude = {
      enabled: options.aiEnabled ?? true,
      activeModel: options.aiEnabled === false ? null : 'claude-haiku-4-5',
      matchCandidates: jest
        .fn<Promise<AiMatchOutcome | null>, [AiMatchRequest]>()
        .mockResolvedValue(
          options.aiVerdicts
            ? {
                verdicts: options.aiVerdicts,
                model: 'claude-haiku-4-5',
                latencyMs: 120,
                inputTokens: 400,
                outputTokens: 60,
              }
            : null,
        ),
    };

    const cache = {
      find: jest.fn().mockResolvedValue(options.cached ?? []),
      upsert: jest.fn().mockResolvedValue(undefined),
    };

    const users = {
      findOne: jest.fn().mockResolvedValue(
        options.user
          ? ({
              id: 'acc-1',
              aiMatchesUsed: 0,
              aiMatchesLimit: 100,
              aiPeriodStartedAt: null,
              ...options.user,
            } as User)
          : null,
      ),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MatchingService,
        { provide: ClaudeService, useValue: claude },
        { provide: getRepositoryToken(MatchCache), useValue: cache },
        { provide: getRepositoryToken(User), useValue: users },
      ],
    }).compile();

    return { service: moduleRef.get(MatchingService), claude, cache, users };
  }

  it('understands a query without calling anything', async () => {
    const { service, claude } = await build({});

    const understood = service.understand('philips led 12w e27 4000k');

    expect(understood.brand).toBe('philips');
    expect(understood.specs.socket).toBe('E27');
    expect(understood.measurements).toContainEqual({ value: 12, unit: 'W' });
    expect(understood.measurements).toContainEqual({ value: 4000, unit: 'K' });
    expect(claude.matchCandidates).not.toHaveBeenCalled();
  });

  it('never asks a model about a pair arithmetic already rejected', async () => {
    const { service, claude } = await build({});

    const run = await service.match('acc-1', 'iPhone 15 128GB', [
      { id: 'a', name: 'iPhone 15 256GB', supplier: 'Склад А' },
    ]);

    expect(run.results[0].confidence).toBe(0);
    expect(claude.matchCandidates).not.toHaveBeenCalled();
    expect(run.aiCallsMade).toBe(0);
  });

  it('never asks a model about a pair a barcode already settled', async () => {
    const { service, claude } = await build({});

    const run = await service.match('acc-1', 'Philips LED 5410288888880', [
      { id: 'a', name: 'CorePro 5410288888880', supplier: 'Склад А' },
    ]);

    expect(run.results[0].confidence).toBe(1);
    expect(run.results[0].method).toBe('gtin');
    expect(claude.matchCandidates).not.toHaveBeenCalled();
  });

  it("settles the catalogue's own phrasings without any model at all", async () => {
    const { service, claude } = await build({});

    // The three spellings from the brief: same brand, same wattage, same
    // socket. Nothing here needs a second opinion, and buying one per search
    // per supplier is what makes an AI feature cost more than it earns.
    const run = await service.match('acc-1', QUERY, [
      { id: '0', name: 'PHILIPS LED BULB 12W E27 4000K', supplier: 'А' },
      { id: '1', name: 'Philips CorePro LED 12W 840 E27', supplier: 'Б' },
      { id: '2', name: 'LED E27 Philips 12W Neutral White', supplier: 'В' },
    ]);

    expect(claude.matchCandidates).not.toHaveBeenCalled();
    expect(run.decidedDeterministically).toBe(3);
    expect(run.results.every((result) => result.confidence >= 0.9)).toBe(true);
  });

  it('asks once for the whole shortlist rather than once per candidate', async () => {
    const { service, claude } = await build({
      aiVerdicts: [
        { id: 'a', same: true, confidence: 0.93, reason: 'същата спецификация' },
        { id: 'b', same: true, confidence: 0.9, reason: 'същата спецификация' },
      ],
    });

    await service.match('acc-1', QUERY, ambiguous);

    expect(claude.matchCandidates).toHaveBeenCalledTimes(1);
    expect(claude.matchCandidates.mock.calls[0][0].candidates).toHaveLength(2);
  });

  it('lets a model raise confidence, but never into the checkable bands', async () => {
    const { service } = await build({
      aiVerdicts: [{ id: 'a', same: true, confidence: 0.99, reason: '840 означава 4000K' }],
    });

    const run = await service.match('acc-1', QUERY, [ambiguous[0]]);

    // 0.95 and above is reserved for a barcode, an article number or agreeing
    // specifications — things a customer can check for themselves.
    expect(run.results[0].confidence).toBeLessThanOrEqual(0.94);
    expect(run.results[0].method).toBe('ai');
  });

  it('lets a model reject what the words alone suggested', async () => {
    const { service } = await build({
      aiVerdicts: [{ id: 'a', same: false, confidence: 0.2, reason: 'аксесоар, не самата лампа' }],
    });

    // Brand and wattage agree, so arithmetic cannot rule it out — but it is a
    // stand for a lamp, not a lamp.
    const run = await service.match('acc-1', QUERY, [
      { id: 'a', name: 'Стойка за лампа Philips 12W', supplier: 'А' },
    ]);

    expect(run.results[0].confidence).toBeLessThanOrEqual(0.5);
    expect(run.results[0].explanation).toContain('аксесоар');
  });

  it('answers from a previous verdict instead of paying for it twice', async () => {
    const { service, claude } = await build({
      cached: [
        {
          fingerprint: fingerprint(
            normaliseProductName(QUERY),
            ambiguous[0].name,
            'claude-haiku-4-5',
          ),
          isSame: true,
          confidence: 0.92,
          reason: 'кеширана преценка',
          model: 'claude-haiku-4-5',
        },
      ],
      aiVerdicts: [{ id: 'b', same: true, confidence: 0.9, reason: 'втората' }],
    });

    const run = await service.match('acc-1', QUERY, ambiguous);

    expect(run.aiCacheHits).toBe(1);
    // The other candidate still goes to the model — one hit does not answer
    // the whole shortlist.
    expect(claude.matchCandidates.mock.calls[0][0].candidates).toHaveLength(1);
  });

  it('asks again when the prompt or the model changes', () => {
    const a = fingerprint('led 12w e27', 'led lampe 12w e27', 'claude-haiku-4-5');
    const b = fingerprint('led 12w e27', 'led lampe 12w e27', 'claude-sonnet-5');
    expect(a).not.toBe(b);
  });

  it('treats two spellings of one measurement as one question', () => {
    // "12 watt" and "12W" must not be cached — or paid for — twice.
    expect(fingerprint('led 12w e27', 'LED Lampe 12 watt E27', 'm')).toBe(
      fingerprint('led 12w e27', 'LED Lampe 12W E27', 'm'),
    );
  });

  it('stops calling the model when the account has spent its allowance', async () => {
    const { service, claude } = await build({
      user: { aiMatchesUsed: 100, aiMatchesLimit: 100, aiPeriodStartedAt: new Date() },
    });

    const run = await service.match('acc-1', QUERY, ambiguous);

    expect(claude.matchCandidates).not.toHaveBeenCalled();
    expect(run.aiSkippedReason).toBe('quota');
    // The search still answers — with deterministic confidence, not an error.
    expect(run.results).toHaveLength(2);
  });

  it('keeps working when the model cannot be reached', async () => {
    const { service } = await build({ aiVerdicts: undefined });

    const run = await service.match('acc-1', QUERY, ambiguous);

    expect(run.aiSkippedReason).toBe('unreachable');
    expect(run.results).toHaveLength(2);
  });

  it('runs deterministically with no AI configured at all', async () => {
    const { service } = await build({ aiEnabled: false });

    const run = await service.match(null, QUERY, ambiguous);

    expect(run.results.every((result) => result.confidence > 0)).toBe(true);
    expect(run.aiModel).toBeNull();
    expect(run.aiSkippedReason).toBe('disabled');
  });

  describe('the meter the customer sees', () => {
    it('reports the allowance including what this search just spent', async () => {
      const { service, users } = await build({
        user: {
          plan: UserPlan.Pro,
          aiMatchesUsed: 0,
          aiMatchesLimit: 100,
          aiPeriodStartedAt: new Date(),
        },
        aiVerdicts: [
          { id: 'a', same: true, confidence: 0.9, reason: 'проверено' },
          { id: 'b', same: true, confidence: 0.9, reason: 'проверено' },
        ],
      });

      // The post-run read sees the row as the claim left it.
      users.findOne
        .mockResolvedValueOnce({
          id: 'acc-1',
          aiMatchesUsed: 0,
          aiMatchesLimit: 100,
          aiPeriodStartedAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: 'acc-1',
          aiMatchesUsed: 2,
          aiMatchesLimit: 100,
          aiPeriodStartedAt: new Date(),
        });

      const run = await service.match('acc-1', QUERY, ambiguous);

      expect(run.aiQuota).toEqual({ used: 2, limit: 100, renews: true });
    });

    it('shows zero spent when a paid plan rolls over', async () => {
      const stale = new Date(Date.now() - 40 * 24 * 3600_000);
      const { service } = await build({
        user: {
          plan: UserPlan.Pro,
          aiMatchesUsed: 87,
          aiMatchesLimit: 100,
          aiPeriodStartedAt: stale,
        },
        aiVerdicts: [],
      });

      const run = await service.match('acc-1', QUERY, []);

      // Last month's 87 must not be presented as this month's spend.
      expect(run.aiQuota).toEqual({ used: 0, limit: 100, renews: true });
    });

    it('never rolls the free allowance over, however long it has been', async () => {
      const longAgo = new Date(Date.now() - 400 * 24 * 3600_000);
      const { service, claude } = await build({
        user: {
          plan: UserPlan.Free,
          aiMatchesUsed: 50,
          aiMatchesLimit: 50,
          aiPeriodStartedAt: longAgo,
        },
      });

      const run = await service.match('acc-1', QUERY, ambiguous);

      // A monthly free allowance is worth farming mailboxes for; a one-off one
      // is worth farming once, for fifty comparisons.
      expect(run.aiQuota).toEqual({ used: 50, limit: 50, renews: false });
      expect(run.aiSkippedReason).toBe('quota');
      expect(claude.matchCandidates).not.toHaveBeenCalled();
    });

    it('has no meter for a caller with no account', async () => {
      const { service } = await build({ aiEnabled: false });

      const run = await service.match(null, QUERY, ambiguous);

      expect(run.aiQuota).toBeNull();
    });
  });
});
