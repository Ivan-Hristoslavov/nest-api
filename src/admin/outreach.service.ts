import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MailService } from '../billing/mail.service';
import { Configuration } from '../config/configuration';
import { Shop } from '../shops/entities/shop.entity';
import { OutreachDraftDto, SendOutreachDto, UpdateOutreachDto } from './dto/outreach.dto';
import { ApiOutreach, OutreachStatus } from './entities/api-outreach.entity';
import { buildOutreach, localeForHost, OutreachLocale } from './outreach-templates';

const LOCALE_REASON: Record<OutreachLocale, string> = {
  bg: 'домейнът сочи към български сайт',
  ro: 'домейнът сочи към румънски сайт',
  el: 'домейнът сочи към гръцки сайт',
  en: 'домейнът не подсказва език — английски по подразбиране',
};

@Injectable()
export class OutreachService {
  private readonly logger = new Logger(OutreachService.name);
  private readonly appUrl: string;
  private readonly senderEmail: string;

  constructor(
    @InjectRepository(ApiOutreach) private readonly outreach: Repository<ApiOutreach>,
    @InjectRepository(Shop) private readonly shops: Repository<Shop>,
    private readonly mail: MailService,
    configService: ConfigService<Configuration, true>,
  ) {
    const mailConfig = configService.get('mail', { infer: true });
    this.appUrl = mailConfig.appUrl;
    // The letter asks for a conversation, so it has to be answerable. Falls
    // back to the sending address when no support address is configured.
    this.senderEmail = mailConfig.supportEmail ?? mailConfig.from;
  }

  /**
   * Composes the letter without sending it.
   *
   * Always a separate step: this is the one email in the system a person is
   * meant to read and rewrite before it goes out, and a preview that is not
   * the thing that will be sent is worse than no preview.
   */
  async draft(host: string, locale?: OutreachLocale): Promise<OutreachDraftDto> {
    const rows = await this.shops.find({ where: { host } });

    if (rows.length === 0) {
      throw new NotFoundException('Няма такъв сайт сред добавените от клиенти.');
    }

    const chosen = locale ?? localeForHost(host);
    const buyers = new Set(rows.map((shop) => shop.ownerId)).size;

    const letter = buildOutreach({
      host,
      buyers,
      locale: chosen,
      appUrl: this.appUrl,
      senderName: 'Stoclify',
      senderEmail: this.senderEmail,
    });

    return {
      locale: chosen,
      localeReason: locale ? 'избран на ръка' : LOCALE_REASON[chosen],
      subject: letter.subject,
      body: letter.body,
      buyers,
      // Shown, never prefilled. A customer gave us this address so we could
      // place *their* orders; using it for our own approach is a different
      // purpose than the one it was handed over for, and the operator should
      // have to decide that deliberately rather than by pressing send.
      knownOrderEmail: rows.find((shop) => shop.orderEmail)?.orderEmail ?? null,
    };
  }

  async send(dto: SendOutreachDto): Promise<ApiOutreach> {
    const existing = await this.outreach.findOne({ where: { host: dto.host } });

    if (existing) {
      throw new ConflictException(
        `На ${dto.host} вече е писано на ${existing.sentAt.toISOString().slice(0, 10)}. Един домейн, едно писмо.`,
      );
    }

    const delivered = await this.mail.sendOutreach({
      to: dto.recipient,
      replyTo: this.senderEmail,
      subject: dto.subject,
      body: dto.body,
    });

    // Recorded only when it actually left. A row saying "sent" for a letter
    // the mail server refused would make the panel lie in the one place its
    // whole job is to tell the truth.
    if (!delivered) {
      throw new BadRequestException(
        'Пощата не прие писмото. Провери плочката ПОЩА горе и опитай пак.',
      );
    }

    const record = await this.outreach.save(
      this.outreach.create({
        host: dto.host,
        recipient: dto.recipient,
        locale: dto.locale,
        subject: dto.subject,
        body: dto.body,
        status: OutreachStatus.Sent,
      }),
    );

    this.logger.log(`API access requested from ${dto.host} (${dto.locale}).`);

    return record;
  }

  findAll(): Promise<ApiOutreach[]> {
    return this.outreach.find({ order: { sentAt: 'DESC' } });
  }

  async update(id: string, dto: UpdateOutreachDto): Promise<ApiOutreach> {
    const record = await this.outreach.findOne({ where: { id } });

    if (!record) throw new NotFoundException('Няма такъв запис.');

    record.status = dto.status;
    if (dto.note !== undefined) record.note = dto.note.trim() || null;

    return this.outreach.save(record);
  }
}
