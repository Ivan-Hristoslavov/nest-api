import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { MailService } from './mail.service';
import { User, UserPlan } from './entities/user.entity';

/**
 * Mail leaves over Resend's HTTPS API rather than SMTP, because the platform
 * this runs on closes outbound 25, 465 and 587 — to Gmail and to Resend's own
 * SMTP endpoint alike. Port 443 is the one that is open.
 *
 * What matters here: the right transport is chosen, a refusal is survived
 * rather than thrown, and the sender never has to know which one ran.
 */
describe('sending over Resend', () => {
  const base = {
    enabled: true,
    host: '',
    port: 587,
    secure: false,
    from: 'Stoclify <no-reply@stoclify.test>',
    appUrl: 'https://stoclify.test',
    resendApiKey: 're_test_key',
  };

  async function build(overrides: Record<string, unknown> = {}) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        MailService,
        {
          provide: ConfigService,
          useValue: { get: () => ({ ...base, ...overrides }) },
        },
      ],
    }).compile();

    const service = moduleRef.get(MailService);
    service.onModuleInit();
    return service;
  }

  const user = {
    email: 'kupuvach@example.com',
    plan: UserPlan.Pro,
    productLimit: 500,
    aiMatchesLimit: 1000,
    isOnTrial: () => false,
    trialDaysLeft: () => null,
  } as unknown as User;

  afterEach(() => jest.restoreAllMocks());

  it('posts the message to Resend rather than opening a socket', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"id":"abc"}', { status: 200 }));

    const service = await build();
    await expect(service.sendApiKey(user, 'pk_live_x')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');

    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.to).toEqual(['kupuvach@example.com']);
    expect(body.from).toBe(base.from);
    expect(body.html).toContain('pk_live_x');
  });

  it('reports a refusal instead of throwing into a paid signup', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('domain is not verified', { status: 403 }));

    const service = await build();

    // The charge already succeeded. Throwing here would make the provider
    // retry a payment that worked.
    await expect(service.sendApiKey(user, 'pk_live_x')).resolves.toBe(false);
  });

  it('survives the network being gone', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ENETUNREACH'));

    const service = await build();
    await expect(service.sendApiKey(user, 'pk_live_x')).resolves.toBe(false);
  });

  it('carries Reply-To only when the mail is sent on somebody else’s behalf', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const service = await build();

    await service.sendOrderRequest({
      to: 'orders@supplier.test',
      replyTo: 'buyer@example.com',
      buyerName: 'Електро Иванов',
      orderNumber: 3,
      currency: 'EUR',
      total: 41.2,
      note: null,
      contact: null,
      lines: [{ query: 'LED', matchedName: null, quantity: 2, unitPrice: 20.6, lineTotal: 41.2 }],
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.reply_to).toBe('buyer@example.com');
  });

  it('checks the key against Resend rather than guessing', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"data":[]}', { status: 200 }));

    const service = await build();
    await expect(service.verify()).resolves.toEqual({
      ok: true,
      detail: expect.stringContaining('Resend accepted the key'),
    });
  });

  it('says so when Resend refuses the key', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    const service = await build();
    const result = await service.verify();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('401');
  });

  it('falls back to SMTP when no Resend key is set', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');

    const service = await build({ resendApiKey: undefined, host: 'smtp.example.test' });
    await service.sendApiKey(user, 'pk_live_x');

    // Whatever SMTP did, it did not go through Resend.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is off when there is a key but nowhere to send from', async () => {
    const service = await build({ enabled: false, resendApiKey: undefined, host: '' });

    await expect(service.sendApiKey(user, 'pk_live_x')).resolves.toBe(false);
  });
});
