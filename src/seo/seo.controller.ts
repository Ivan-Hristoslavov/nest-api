import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '../common/decorators/public.decorator';
import { SeoService } from './seo.service';

/**
 * The two files a crawler asks for by name.
 *
 * Excluded from the API documentation and from the version prefix: neither is
 * part of the API, and `/api/v1/robots.txt` is a file no crawler will ever ask
 * for. The exclusion lives in `setGlobalPrefix` in `main.ts`.
 */
@ApiExcludeController()
@Controller()
export class SeoController {
  constructor(private readonly seo: SeoService) {}

  @Public()
  @Get('robots.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  robots(): string {
    return this.seo.robots();
  }

  @Public()
  @Get('sitemap.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  sitemap(): string {
    return this.seo.sitemap();
  }
}
