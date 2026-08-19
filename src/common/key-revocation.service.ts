import { Global, Injectable, Logger, Module } from '@nestjs/common';

/**
 * A counter that makes key revocation immediate.
 *
 * `ApiKeyGuard` caches key lookups for a few seconds, which is what stops an
 * invalid-key flood from becoming a database flood. The cost is that a key
 * revoked a moment ago keeps working until the entry expires — and both places
 * that revoke one promise otherwise: rotation says the old key dies "the
 * moment this returns", and an erased account has no row left to authorise.
 *
 * Rather than reach into the guard's cache from the billing code — which would
 * make billing depend on the guard and the guard on billing — both depend on
 * this. Bumping the epoch makes every cached entry stale at once. Coarse on
 * purpose: revocation happens a few times a day and costs one lookup per
 * active key afterwards, while tracking individual keys would mean holding
 * plaintext to identify them.
 */
@Injectable()
export class KeyRevocationService {
  private readonly logger = new Logger(KeyRevocationService.name);
  private epoch = 0;

  /** Cache entries created under a different epoch are no longer trusted. */
  get currentEpoch(): number {
    return this.epoch;
  }

  revokeCachedKeys(reason: string): void {
    this.epoch += 1;
    this.logger.log(`Cached API keys invalidated: ${reason}`);
  }
}

@Global()
@Module({
  providers: [KeyRevocationService],
  exports: [KeyRevocationService],
})
export class KeyRevocationModule {}
