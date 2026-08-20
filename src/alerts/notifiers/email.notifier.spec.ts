import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { MailService } from '../../billing/mail.service';
import { UsersService } from '../../billing/users.service';
import { Alert } from '../entities/alert.entity';
import { AlertSeverity, AlertType } from '../enums/alert.enums';
import { EmailNotifier } from './email.notifier';
import { AlertContext } from './notifier.interface';

/**
 * The failure that matters here is not a bounced email — it is the wrong
 * inbox. An alert carries a supplier's price to a named buyer, so addressing
 * it from anything other than the product's own owner leaks a negotiated
 * price to a competitor.
 */
describe('EmailNotifier', () => {
  const alert = {
    id: 'a1',
    type: AlertType.PriceRise,
    severity: AlertSeverity.Warning,
    message: 'Кабелът поскъпна.',
    oldPrice: 10,
    newPrice: 12,
    changePercent: 20,
    currency: 'EUR',
  } as Alert;

  const context: AlertContext = {
    ownerId: 'owner-1',
    productName: 'СВТ 3x1.5',
    productSku: 'SVT-3-15',
    competitorName: 'Складът',
    competitorUrl: 'https://example.com/svt',
    targetPrice: 11,
  };

  async function build(overrides: {
    ownerEmail?: string;
    ownerMissing?: boolean;
    delivered?: boolean;
    fallback?: string;
  }) {
    const mail = {
      enabled: true,
      deliver: jest.fn().mockResolvedValue(overrides.delivered ?? true),
    };
    const users = {
      findOne: overrides.ownerMissing
        ? jest.fn().mockRejectedValue(new NotFoundException())
        : jest.fn().mockResolvedValue({ email: overrides.ownerEmail ?? 'buyer@example.com' }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EmailNotifier,
        { provide: MailService, useValue: mail },
        { provide: UsersService, useValue: users },
        {
          provide: ConfigService,
          useValue: {
            // Two different sections are read: the alert channel's own config
            // and the mail config the message links back with.
            get: (section: string) =>
              section === 'mail'
                ? { appUrl: 'https://stoclify.example' }
                : { emailFallbackTo: overrides.fallback },
          },
        },
      ],
    }).compile();

    return { notifier: moduleRef.get(EmailNotifier), mail, users };
  }

  it('writes to the account that owns the product', async () => {
    const { notifier, mail } = await build({ ownerEmail: 'buyer@example.com' });

    await notifier.send(alert, context);

    expect(mail.deliver).toHaveBeenCalledWith(
      'buyer@example.com',
      expect.stringContaining('СВТ 3x1.5'),
      expect.stringContaining('Кабелът поскъпна.'),
      expect.stringContaining('Кабелът поскъпна.'),
    );
  });

  it('sends nothing when the owner cannot be resolved, rather than to the fallback', async () => {
    const { notifier, mail } = await build({ ownerMissing: true, fallback: 'ops@example.com' });

    await expect(notifier.send(alert, context)).rejects.toThrow(/No recipient/);
    expect(mail.deliver).not.toHaveBeenCalled();
  });

  it('uses the fallback only for an alert with no owner at all', async () => {
    const { notifier, mail } = await build({ fallback: 'ops@example.com' });

    await notifier.send(alert, { ...context, ownerId: undefined });

    expect(mail.deliver).toHaveBeenCalledWith(
      'ops@example.com',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('reports a refused message as a failure so the alert can be retried', async () => {
    const { notifier } = await build({ delivered: false });

    await expect(notifier.send(alert, context)).rejects.toThrow(/SMTP refused/);
  });
});
