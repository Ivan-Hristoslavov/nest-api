import { PartialType } from '@nestjs/swagger';

import { CreateCompetitorDto } from './create-competitor.dto';

/** Every field of {@link CreateCompetitorDto}, all optional. */
export class UpdateCompetitorDto extends PartialType(CreateCompetitorDto) {}
