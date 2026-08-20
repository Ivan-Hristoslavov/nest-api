import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from '../billing/entities/user.entity';
import { AuthConfig, Configuration } from '../config/configuration';
import { open, seal, secretsAvailable } from './secret-box';
import { generateSecret, otpauthUrl, verifyCode } from './totp';

/**
 * How many recovery codes are issued, and how long each is.
 *
 * Eight, because a phone is lost roughly once and a person needs enough left
 * over not to be nervous about spending one. Ten characters of base32 is about
 * fifty bits — unguessable, and short enough to be written on paper without
 * transcription errors, which is where these actually end up.
 */
const RECOVERY_CODES = 8;
const RECOVERY_LENGTH = 10;

export interface TwoFactorEnrolment {
  secret: string;
  otpauthUrl: string;
  recoveryCodes: string[];
}

/**
 * The second factor.
 *
 * This is the answer to the one real weakness in a passwordless design: sign-in
 * proves the person reads the mailbox, so whoever holds the mailbox holds the
 * account. A password would not change that — a password reset goes through
 * the same mailbox — which is why this and not passwords is what was missing.
 *
 * Optional on purpose. Most buyers will not turn it on, and forcing a
 * warehouse manager to find their phone every thirty days to look up the price
 * of cable is how a tool stops being used. The ones who want it are the ones
 * whose accounts are worth taking.
 */
@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);
  private readonly config: AuthConfig;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('auth', { infer: true });
  }

  /** Whether the deployment can store secrets at all. */
  get available(): boolean {
    return secretsAvailable(this.config.totpEncryptionKey);
  }

  private get key(): string {
    if (!this.config.totpEncryptionKey || !this.available) {
      // Refused rather than stored in plain text. A second factor kept
      // alongside the thing it protects is decoration.
      throw new BadRequestException(
        'Двуфакторната защита не е налична на този сървър (липсва TOTP_ENCRYPTION_KEY).',
      );
    }

    return this.config.totpEncryptionKey;
  }

  /**
   * Starts enrolment: a secret and recovery codes, stored but not yet active.
   *
   * Nothing is enforced until `enable` is called with a working code. Turning
   * it on before the phone has proved it can produce one is how somebody locks
   * themselves out of their own account with a mistyped QR scan.
   */
  async beginEnrolment(userId: string, email: string): Promise<TwoFactorEnrolment> {
    const secret = generateSecret();
    const recoveryCodes = Array.from({ length: RECOVERY_CODES }, () => recoveryCode());

    await this.users.update(userId, {
      totpSecret: seal(secret, this.key),
      totpConfirmedAt: null,
      totpRecoveryHashes: recoveryCodes.map(digest),
    });

    return { secret, otpauthUrl: otpauthUrl(secret, email), recoveryCodes };
  }

  /** Switches it on, once the phone has proved it works. */
  async enable(userId: string, code: string): Promise<boolean> {
    const secret = await this.secretFor(userId);
    if (!secret || !verifyCode(secret, code)) return false;

    await this.users.update(userId, { totpConfirmedAt: new Date() });
    this.logger.log(`Two-factor enabled for ${userId}`);
    return true;
  }

  /**
   * Switches it off — but only for somebody who can still pass it.
   *
   * Requiring a code to disable is the point: otherwise a stolen session, which
   * is exactly what the second factor exists to survive, could simply turn it
   * off and carry on.
   */
  async disable(userId: string, code: string): Promise<boolean> {
    if (!(await this.verify(userId, code))) return false;

    await this.users.update(userId, {
      totpSecret: null,
      totpConfirmedAt: null,
      totpRecoveryHashes: null,
    });

    this.logger.log(`Two-factor disabled for ${userId}`);
    return true;
  }

  /**
   * Checks a code, or a recovery code.
   *
   * A spent recovery code is removed in the same breath as it is accepted, so
   * one written on a piece of paper that later goes missing is worth nothing
   * twice.
   */
  async verify(userId: string, code: string): Promise<boolean> {
    const secret = await this.secretFor(userId);
    if (!secret) return false;

    if (verifyCode(secret, code)) return true;

    return this.spendRecoveryCode(userId, code);
  }

  /** How many recovery codes are left, for an interface that warns at one. */
  async recoveryCodesLeft(userId: string): Promise<number> {
    const row = await this.users
      .createQueryBuilder('user')
      .addSelect('user.totpRecoveryHashes')
      .where('user.id = :id', { id: userId })
      .getOne();

    return row?.totpRecoveryHashes?.length ?? 0;
  }

  private async secretFor(userId: string): Promise<string | null> {
    const row = await this.users
      .createQueryBuilder('user')
      .addSelect('user.totpSecret')
      .where('user.id = :id', { id: userId })
      .getOne();

    if (!row?.totpSecret) return null;

    const secret = open(row.totpSecret, this.key);

    if (!secret) {
      // Sealed under a different key: the deployment rotated TOTP_ENCRYPTION_KEY
      // without re-encrypting. Said out loud, because the symptom otherwise is
      // a customer who cannot sign in and a server with nothing to say about it.
      this.logger.error(
        `Could not open the TOTP secret for ${userId} — TOTP_ENCRYPTION_KEY may have changed.`,
      );
    }

    return secret;
  }

  private async spendRecoveryCode(userId: string, code: string): Promise<boolean> {
    const row = await this.users
      .createQueryBuilder('user')
      .addSelect('user.totpRecoveryHashes')
      .where('user.id = :id', { id: userId })
      .getOne();

    const hashes = row?.totpRecoveryHashes ?? [];
    if (hashes.length === 0) return false;

    const presented = digest(code.replace(/[\s-]/g, '').toUpperCase());
    const presentedBuffer = Buffer.from(presented, 'utf8');

    // Every stored hash is compared, so the time taken does not reveal which
    // one matched or how many are left.
    const matched = hashes.reduce(
      (found, stored) => timingSafeEqual(Buffer.from(stored, 'utf8'), presentedBuffer) || found,
      false,
    );

    if (!matched) return false;

    await this.users.update(userId, {
      totpRecoveryHashes: hashes.filter((stored) => stored !== presented),
    });

    this.logger.warn(`A recovery code was used for ${userId}; ${hashes.length - 1} remain.`);

    return true;
  }
}

/** Base32-ish, avoiding the characters people mistype off paper. */
function recoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(RECOVERY_LENGTH);

  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
