import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { CheckoutService } from './checkout.service';
import { UserPlan } from './entities/user.entity';

/**
 * Which provider takes the money is a business decision, not an architectural
 * one — and it changed once already. What must hold either way: a plan is
 * offered only when it can actually be paid for, and a plan that cannot be
 * fails loudly here rather than sending somebody to a broken page.
 */
describe('CheckoutService', () => {
  async function build(sections: { checkout?: unknown; stripe?: unknown }) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CheckoutService,
        {
          provide: ConfigService,
          useValue: {
            get: (section: string) => {
              if (section === 'checkout') return sections.checkout ?? { links: {} };
              if (section === 'stripe') return sections.stripe ?? { prices: {} };
              return { appUrl: 'https://priceguard.example' };
            },
          },
        },
      ],
    }).compile();

    return moduleRef.get(CheckoutService);
  }

  it('offers nothing when no provider is configured', async () => {
    const service = await build({});

    expect(service.enabled).toBe(false);
    expect(service.availablePlans()).toEqual([]);
    await expect(service.createSession(UserPlan.Pro)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('hands out the hosted link a merchant-of-record platform issues', async () => {
    const service = await build({
      checkout: { links: { pro: 'https://pay.example/pro' } },
    });

    expect(service.enabled).toBe(true);
    expect(service.availablePlans()).toEqual([{ plan: UserPlan.Pro }]);

    const session = await service.createSession(UserPlan.Pro, 'kupuvach@example.com');

    expect(session.url).toContain('https://pay.example/pro');
    // Carried through so the account the webhook creates belongs to the payer.
    expect(session.url).toContain('kupuvach%40example.com');
  });

  it('still refuses a plan nobody configured, even when another plan works', async () => {
    const service = await build({ checkout: { links: { pro: 'https://pay.example/pro' } } });

    await expect(service.createSession(UserPlan.Starter)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
