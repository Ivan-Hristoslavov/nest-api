import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

import { Configuration, MailConfig } from '../config/configuration';
import { codeBlock, dataRows, escapeHtml, noticeBox, paragraph, renderEmail } from './email-layout';
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
    const subject = replaced
      ? 'Новият ви ключ за PriceGuard'
      : 'Готово — ето ключа ви за PriceGuard';

    const { html, text } = renderEmail({
      title: subject,
      preheader: replaced
        ? 'Предишният ключ вече не работи.'
        : `Акаунтът ви е активен на план ${plan}. Ключът е вътре.`,
      heading: replaced ? 'Ето новия ви ключ' : `Акаунтът ви е готов`,
      appUrl: this.config.appUrl,
      supportEmail: this.config.supportEmail,
      body: [
        paragraph(
          replaced
            ? 'Издадохме нов ключ по ваша заявка. <strong>Предишният спря да работи в същия момент</strong> — ако някъде е останал записан, заменете го.'
            : `Благодарим ви. Планът ви е <strong>${escapeHtml(plan)}</strong> и достъпът е активен веднага.`,
        ),
        codeBlock(apiKey, 'Вашият ключ'),
        noticeBox(
          '<strong>Запазете това писмо.</strong> Ключът се пази само като хеш — никой, включително ние, не може да го прочете повторно. Загубен ключ не се възстановява, а се заменя с нов.',
          'warn',
        ),
        dataRows([
          ['План', plan],
          ['Следени артикула', String(user.productLimit)],
          ['AI сравнения', `${user.aiMatchesLimit} на месец`],
          ['Доставчици', 'без ограничение'],
        ]),
      ],
      cta: { label: 'Отвори таблото', url: this.config.appUrl },
      footnotes: [
        'Поставете ключа в полето за достъп горе вдясно — браузърът го помни, за да не го въвеждате всеки път.',
        'Ключът е равнозначен на парола. Не го пращайте по чат и не го оставяйте в споделен документ.',
      ],
    });

    return this.send(user.email, subject, html, text);
  }

  /**
   * The link that signs somebody in.
   *
   * Short-lived and single use, and the message says both — a person who
   * receives one they did not ask for should know exactly how much it is worth
   * and that ignoring it is enough.
   */
  async sendSignInLink(user: User, url: string, minutes: number): Promise<boolean> {
    const subject = 'Вход в PriceGuard';

    const { html, text } = renderEmail({
      title: subject,
      preheader: `Връзката важи ${minutes} минути и се използва веднъж.`,
      heading: 'Влезте в таблото си',
      appUrl: this.config.appUrl,
      supportEmail: this.config.supportEmail,
      body: [
        paragraph(
          `Натиснете бутона и ще ви пуснем в акаунта <strong>${escapeHtml(user.email)}</strong>. Няма парола за помнене.`,
        ),
        noticeBox(
          `Връзката важи <strong>${minutes} минути</strong> и работи само веднъж. Ако не сте я поискали вие — не правете нищо; без натискане не се случва нищо.`,
        ),
      ],
      cta: { label: 'Влез в таблото', url },
      footnotes: [
        'Ако бутонът не сработи, копирайте адреса от него в браузъра.',
        'Това писмо не съдържа вашия API ключ — той се използва от програми, а този вход е за хора.',
      ],
    });

    return this.send(user.email, subject, html, text);
  }

  /**
   * The first link: it proves the mailbox and opens the account.
   *
   * Distinct from the sign-in link because it is doing more, and because the
   * person reading it has not seen the product yet — the message has to say
   * what happens when they click, not assume they remember asking.
   */
  async sendVerificationLink(user: User, url: string, minutes: number): Promise<boolean> {
    const subject = 'Потвърдете имейла си за PriceGuard';

    const { html, text } = renderEmail({
      title: subject,
      preheader: `Едно натискане отваря акаунта. Връзката важи ${minutes} минути.`,
      heading: 'Остана едно натискане',
      appUrl: this.config.appUrl,
      supportEmail: this.config.supportEmail,
      body: [
        paragraph(
          'Потвърдете, че този имейл е ваш, и акаунтът се отваря веднага — с ключ за API-то и безплатния план.',
        ),
        dataRows([
          ['План', 'Безплатен'],
          ['Следени артикула', String(user.productLimit)],
          ['AI сравнения', `${user.aiMatchesLimit} на месец`],
          ['Доставчици', 'без ограничение'],
        ]),
        noticeBox(
          `Връзката важи <strong>${minutes} минути</strong> и работи веднъж. Ако не сте се регистрирали вие — не правете нищо и акаунтът никога не се отваря.`,
        ),
      ],
      cta: { label: 'Потвърди и влез', url },
      footnotes: ['Ако бутонът не сработи, копирайте адреса от него в браузъра.'],
    });

    return this.send(user.email, subject, html, text);
  }

  /** Confirms bought comparisons landed, and says what they are for. */
  async sendTopUpReceipt(user: User, count: number): Promise<boolean> {
    const subject = `Добавихме ${count} AI сравнения`;

    const { html, text } = renderEmail({
      title: subject,
      preheader: `Новата ви наличност е ${user.aiMatchesLimit}.`,
      heading: 'Сравненията са добавени',
      appUrl: this.config.appUrl,
      supportEmail: this.config.supportEmail,
      body: [
        paragraph(
          `Благодарим ви. Добавихме <strong>${count}</strong> AI сравнения към акаунта ви.`,
        ),
        dataRows([
          ['Добавени', String(count)],
          ['Обща наличност', String(user.aiMatchesLimit)],
          ['Използвани досега', String(user.aiMatchesUsed)],
        ]),
        paragraph('Сравненията не изтичат в края на месеца — платили сте за брой, не за срок.'),
      ],
      cta: { label: 'Към търсенето', url: this.config.appUrl },
    });

    return this.send(user.email, subject, html, text);
  }

  /** Tells a customer their subscription has lapsed and the key has stopped. */
  async sendAccessExpired(user: User, reason: string): Promise<boolean> {
    const subject = 'Достъпът ви до PriceGuard е спрян';

    const { html, text } = renderEmail({
      title: subject,
      preheader: 'Данните ви са запазени. Подновяването връща достъпа със същия ключ.',
      heading: 'Достъпът ви е спрян',
      appUrl: this.config.appUrl,
      supportEmail: this.config.supportEmail,
      body: [
        paragraph(`Ключът ви спря да работи: <strong>${escapeHtml(reason)}</strong>.`),
        paragraph(
          'Доставчиците, следените артикули и цялата история на цените остават непокътнати. Подновете абонамента и достъпът се връща <strong>със същия ключ</strong> — нищо не трябва да се настройва отново.',
        ),
        noticeBox(
          'Ако смятате, че това е грешка — например плащане, което е минало — пишете ни и ще проверим преди да предприемете каквото и да е друго.',
        ),
      ],
      cta: { label: 'Поднови достъпа', url: this.config.appUrl },
    });

    return this.send(user.email, subject, html, text);
  }

  /**
   * Sends a message composed elsewhere.
   *
   * The templates in this class belong to billing; an alert email is the
   * alerts module's presentation, the same way Block Kit belongs to the Slack
   * notifier. What stays here is the one transport and its failure policy.
   */
  async deliver(to: string, subject: string, html: string, text: string): Promise<boolean> {
    return this.send(to, subject, html, text);
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
