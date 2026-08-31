import { Global, Module } from '@nestjs/common';

import { EffectiveCostService } from './effective-cost.service';
import { OptimiserStatsService } from './optimiser-stats.service';

/**
 * What a customer actually pays.
 *
 * Global because it is a domain rule rather than a feature: the ranking, the
 * basket and (later) the order optimiser all need the same answer, and a
 * second implementation appearing anywhere is the failure this module exists
 * to prevent.
 *
 * It holds no state and touches no repository, so being global costs nothing.
 */
@Global()
@Module({
  providers: [EffectiveCostService, OptimiserStatsService],
  exports: [EffectiveCostService, OptimiserStatsService],
})
export class PricingModule {}
