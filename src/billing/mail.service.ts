import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

import { Configuration, MailConfig } from '../config/configuration';
import { User } from './entities/user.entity';

/** Plan names as a customer would recognise them. */
const PLAN_LABELS: Record<string, string> = {
  free: 'Безплатен',
  starter: 'Старт',
  pro: 'ПРО',
  business: 'Бизнес',
};

/**
 * Outgoing email.
 *
 * Exists for one job that nothing else can do: putting the API key in the
 * customer's hands. The key is stored as a hash, so the plaintext exists for
 * exactly one moment — inside the request that created it. Miss that moment
 * and the only remedy is to issue a *different* key, which is why a paid
 * account with no delivered key is a support ticket rather than a customer.
 *
 * Failures never propagate. A payment that succeeded must not be reported as
 * failed because a mail server was briefly unreachable — the account is
 * already active, and an operator can resend from the customer list.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly config: MailConfig;
  private transporter: Transporter | null = null;

  constructor(configService: ConfigService<Configuration, true>) {
    this.config = configService.get('mail', { infer: true });
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.warn(
        'Email is off (no SMTP_HOST/SMTP_FROM). Paid accounts will be activated but their ' +
          'API key will NOT be delivered — issue it from the operator screen instead.',
      );
      return;
    }

    this.transporter = createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth:
        this.config.username && this.config.password
          ? { user: this.config.username, pass: this.config.password }
          : undefined,
    });

    this.logger.log(
      `Email ready via ${this.config.host}:${this.config.port} as ${this.config.from}`,
    );
  }

  get enabled(): boolean {
    return this.config.enabled && this.transporter !== null;
  }

  /** Confirms the SMTP settings without sending anything. */
  async verify(): Promise<{ ok: boolean; detail: string }> {
    if (!this.transporter) {
      return { ok: false, detail: 'SMTP is not configured (SMTP_HOST / SMTP_FROM are empty).' };
    }

    try {
      await this.transporter.verify();
      return { ok: true, detail: `${this.config.host}:${this.config.port} accepted the login.` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Sends a customer the key their payment bought.
   *
   * @returns whether it went out, so the caller can tell the operator that a
   * key still needs delivering by hand.
   */
  async sendApiKey(user: User, apiKey: string, replaced = false): Promise<boolean> {
    const plan = PLAN_LABELS[user.plan] ?? user.plan;
    const subject = replaced ? 'Новият ви ключ за PriceGuard' : 'Достъпът ви до PriceGuard';

    const intro = replaced
      ? 'Ето новия ви ключ. Предишният вече не работи.'
      : `Благодарим ви. Акаунтът ви е активен на план <strong>${escapeHtml(plan)}</strong>.`;

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;color:#1f2937;line-height:1.6">
        <h2 style="margin:0 0 16px;font-size:20px">${escapeHtml(subject)}</h2>
        <p style="margin:0 0 16px">${intro}</p>
        <p style="margin:0 0 8px">Вашият ключ:</p>
        <p style="margin:0 0 16px;padding:14px 16px;background:#0f172a;color:#34d399;border-radius:8px;font-family:ui-monospace,Menlo,monospace;font-size:14px;word-break:break-all">${escapeHtml(apiKey)}</p>
        <p style="margin:0 0 16px">
          Отворете <a href="${escapeHtml(this.config.appUrl)}" style="color:#2563eb">${escapeHtml(this.config.appUrl)}</a>
          и го поставете в полето за достъп.
        </p>
        <p style="margin:0 0 16px;padding:12px 14px;background:#fef3c7;border-radius:8px;font-size:14px">
          <strong>Пазете това писмо.</strong> Ключът не се съхранява в четим вид никъде — ако го загубите,
          може само да бъде заменен с нов.
        </p>
        <p style="margin:0 0 4px;font-size:14px;color:#6b7280">Планът ви позволява ${user.productLimit} следени продукта.</p>
        ${
          this.config.supportEmail
            ? `<p style="margin:0;font-size:14px;color:#6b7280">Въпроси: <a href="mailto:${escapeHtml(this.config.supportEmail)}" style="color:#2563eb">${escapeHtml(this.config.supportEmail)}</a></p>`
            : ''
        }
      </div>`;

    const text = [
      subject,
      '',
      replaced
        ? 'Ето новия ви ключ. Предишният вече не работи.'
        : `Акаунтът ви е активен на план ${plan}.`,
      '',
      `Ключ: ${apiKey}`,
      '',
      `Отворете ${this.config.appUrl} и го поставете в полето за достъп.`,
      '',
      'Пазете това писмо — ключът не се съхранява в четим вид и може само да бъде заменен.',
      `Планът ви позволява ${user.productLimit} следени продукта.`,
    ].join('\n');

    return this.send(user.email, subject, html, text);
  }

  /** Tells a customer their subscription has lapsed and the key has stopped. */
  async sendAccessExpired(user: User, reason: string): Promise<boolean> {
    const subject = 'Достъпът ви до PriceGuard е спрян';

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;color:#1f2937;line-height:1.6">
        <h2 style="margin:0 0 16px;font-size:20px">${escapeHtml(subject)}</h2>
        <p style="margin:0 0 16px">Ключът ви спря да работи: ${escapeHtml(reason)}.</p>
        <p style="margin:0 0 16px">
          Следените продукти и историята на цените се пазят. Подновете абонамента и достъпът се връща
          със същия ключ.
        </p>
        <p style="margin:0"><a href="${escapeHtml(this.config.appUrl)}" style="color:#2563eb">${escapeHtml(this.config.appUrl)}</a></p>
      </div>`;

    return this.send(
      user.email,
      subject,
      html,
      `${subject}\n\nКлючът ви спря да работи: ${reason}.\nСледените продукти се пазят. ${this.config.appUrl}`,
    );
  }

  private async send(to: string, subject: string, html: string, text: string): Promise<boolean> {
    if (!this.transporter) {
      this.logger.warn(`Email is off — "${subject}" for ${to} was not sent.`);
      return false;
    }

    try {
      await this.transporter.sendMail({ from: this.config.from, to, subject, html, text });
      this.logger.log(`Sent "${subject}" to ${to}`);
      return true;
    } catch (error) {
      // Never thrown onward: the payment succeeded and the account is live.
      // Reporting the whole webhook as failed would make the provider retry a
      // charge that already worked.
      this.logger.error(
        `Could not email ${to} ("${subject}"): ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
