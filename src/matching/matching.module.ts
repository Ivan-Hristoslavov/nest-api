import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../billing/entities/user.entity';
import { ClaudeService } from './claude.service';
import { MatchCache } from './entities/match-cache.entity';
import { MatchingService } from './matching.service';

/**
 * Product matching, deterministic first and optional beyond that.
 *
 * Deliberately depends on nothing but the two tables it meters and remembers
 * with. Search imports it; it imports no search, so the matcher can be tested,
 * reasoned about and switched off without touching the thing that finds the
 * products in the first place.
 */
@Module({
  imports: [TypeOrmModule.forFeature([MatchCache, User])],
  providers: [MatchingService, ClaudeService],
  exports: [MatchingService, ClaudeService],
})
export class MatchingModule {}
