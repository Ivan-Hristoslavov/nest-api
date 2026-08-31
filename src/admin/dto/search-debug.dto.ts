import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';

/** What to trace, and on whose supplier list. */
export class SearchDebugQueryDto {
  @ApiProperty({
    description: 'The query to trace, exactly as a customer would type it.',
    example: 'iphone 15 128gb',
  })
  @IsString()
  @Length(2, 160)
  q!: string;

  @ApiPropertyOptional({
    description:
      "Whose supplier list to search. Defaults to the operator's own, which is usually the seeded demo account.",
  })
  @IsUUID()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({
    description:
      'Whether a model may be consulted. Off by default: a support trace should show what the deterministic engine did, and paying for a model to reproduce a complaint is rarely the point.',
    default: false,
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  ai?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether cached supplier answers may be reused. Off by default, because a trace of a cache is a trace of an afternoon ago.',
    default: false,
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  useCache?: boolean;

  @ApiPropertyOptional({
    description:
      "Where to look. Defaults to the customer's own suppliers, which is what they were searching when they complained.",
    enum: ['my_suppliers', 'global'],
    default: 'my_suppliers',
  })
  @IsIn(['my_suppliers', 'global'])
  @IsOptional()
  scope?: 'my_suppliers' | 'global';
}

/**
 * Every stage of one search, in the order it happened.
 *
 * The shape is deliberately loose — `Object` rather than a class per stage —
 * because this is a diagnostic surface for one operator, not a contract other
 * software is written against. Pinning it would mean a DTO change every time
 * the engine learns to report one more thing about itself, which is exactly
 * the friction that stops a debugger from being kept current.
 */
export class SearchDebugDto {
  @ApiProperty({ description: 'The query as it was typed. Never rewritten silently.' })
  query!: string;

  @ApiProperty({
    description: 'What the engine read out of it: type, brand, attributes, identifiers.',
    type: Object,
  })
  understood!: Record<string, unknown>;

  @ApiProperty({
    description: 'The spellings the suppliers could be asked, the original first.',
    isArray: true,
    type: Object,
  })
  variants!: Array<Record<string, unknown>>;

  @ApiProperty({
    description: 'Each supplier: what it was asked, what it answered, and how long it took.',
    isArray: true,
    type: Object,
  })
  shops!: Array<Record<string, unknown>>;

  @ApiProperty({
    description:
      'Every candidate that survived ranking, with why it matched or did not: the relation, the confidence, what agreed, what was missing and what clashed.',
    isArray: true,
    type: Object,
  })
  candidates!: Array<Record<string, unknown>>;

  @ApiProperty({ description: 'What matching cost and what it decided.', type: Object })
  matching!: Record<string, unknown>;

  @ApiProperty({ example: 1840 })
  durationMs!: number;
}
