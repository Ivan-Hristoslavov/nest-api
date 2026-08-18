import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PLAN_PRODUCT_LIMIT, User, UserPlan, UserStatus } from './entities/user.entity';
import { UsersService } from './users.service';

/**
 * The free signup is the only way a stranger can write to this database, so
 * the two failure modes worth pinning are: an account that cannot use the key
 * it was just given, and a signup that destroys an existing customer's key.
 */
describe('free signup', () => {
  let service: UsersService;
  let repository: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock };

  beforeEach(async () => {
    repository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((input: Partial<User>) => input as User),
      save: jest.fn((input: Partial<User>) => Promise.resolve({ id: 'u1', ...input } as User)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, { provide: getRepositoryToken(User), useValue: repository }],
    }).compile();

    service = moduleRef.get(UsersService);
  });

  it('creates an account whose key works immediately', async () => {
    const user = await service.createFreeAccount('Kupuvach@Moiat-Magazin.BG ', ' Електро ЕООД ');

    // Pending would mean handing someone a key the guard answers 403 to.
    expect(user.status).toBe(UserStatus.Active);
    expect(user.plan).toBe(UserPlan.Free);
    expect(user.productLimit).toBe(PLAN_PRODUCT_LIMIT[UserPlan.Free]);
    expect(user.email).toBe('kupuvach@moiat-magazin.bg');
    expect(user.name).toBe('Електро ЕООД');
  });

  it('refuses an address that already has an account instead of re-keying it', async () => {
    repository.findOne.mockResolvedValue({ id: 'existing', email: 'taken@example.com' });

    await expect(service.createFreeAccount('taken@example.com')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.save).not.toHaveBeenCalled();
  });
});
