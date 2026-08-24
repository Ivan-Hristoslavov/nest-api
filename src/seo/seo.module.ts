import { Module } from '@nestjs/common';

import { SeoController } from './seo.controller';
import { SeoService } from './seo.service';

@Module({
  controllers: [SeoController],
  providers: [SeoService],
  // `main.ts` resolves the service to inject the head tags into index.html,
  // which happens in an express middleware rather than a controller — the
  // static file handler answers `/` and has to be given the finished HTML.
  exports: [SeoService],
})
export class SeoModule {}
