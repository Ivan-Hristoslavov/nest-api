import { IsPublicHttpUrl } from '../../common/validators/public-url.validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { trimString, trimUpperCase } from '../../common/transformers/dto-transformers';

const URL_OPTIONS = { protocols: ['http', 'https'], require_protocol: true, require_tld: true };

export class CreateCompetitorDto {
  @ApiProperty({
    description: 'Retailer name, used in alerts and dashboards.',
    minLength: 2,
    maxLength: 120,
    example: 'Competitor A',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(trimString)
  name!: string;

  @ApiProperty({
    description: 'Product page to scrape at this retailer.',
    format: 'uri',
    example: 'https://competitor-a.example.com/audio/sony-wh-1000xm5',
  })
  @IsUrl(URL_OPTIONS)
  @IsPublicHttpUrl()
  @MaxLength(2048)
  url!: string;

  @ApiPropertyOptional({
    description: 'ISO-4217 currency code for this listing.',
    default: 'EUR',
    example: 'EUR',
  })
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be three uppercase letters, e.g. EUR' })
  @Transform(trimUpperCase)
  @IsOptional()
  currency?: string = 'EUR';

  @ApiPropertyOptional({
    description:
      'CSS selector for the price element. Only needed when the page exposes no structured data — the parser tries JSON-LD, microdata and meta tags first.',
    maxLength: 255,
    example: '.product-price__amount',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  @Transform(trimString)
  priceSelector?: string;

  @ApiPropertyOptional({
    description: 'Read the price from this attribute instead of the element text.',
    maxLength: 64,
    example: 'content',
  })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  @Transform(trimString)
  priceAttribute?: string;

  @ApiPropertyOptional({
    description: 'Known price at this retailer, overwritten by the first scrape.',
    type: Number,
    minimum: 0,
    example: 309.0,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999)
  @IsOptional()
  currentPrice?: number;

  @ApiPropertyOptional({
    description: 'Whether the sweep should include this listing.',
    default: true,
    example: true,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;
}
