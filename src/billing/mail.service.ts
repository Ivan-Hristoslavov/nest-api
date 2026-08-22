import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

import { Configuration, MailConfig } from '../config/configuration';
import { codeBlock, dataRows, escapeHtml, noticeBox, paragraph, renderEmail } from './email-layout';
import {
  PLAN_PRODUCT_LIMIT,
  TRIAL_AI_MATCHES,
  TRIAL_DAYS,
  TRIAL_PLAN,
  User,
  UserPlan,
} from './entities/user.entity';

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
    const subject = replaced ? 'Новият ви ключ за Stoclify' : 'Готово — ето ключа ви за Stoclify';

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
          [
            'План',
            user.isOnTrial() ? `${plan} — пробен, ${user.trialDaysLeft() ?? TRIAL_DAYS} дни` : plan,
          ],
          ['Следени артикула', String(user.productLimit)],
          [
            'AI сравнения',
            user.isOnTrial()
              ? `${user.aiMatchesLimit} за пробния период`
              : `${user.aiMatchesLimit} на месец`,
          ],
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
    const subject = 'Вход в Stoclify';

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
    const subject = 'Потвърдете имейла си за Stoclify';

    const { html, text } = renderEmail({
      title: subject,
      preheader: `Едно натискане отваря акаунта. Връзката важи ${minutes} минути.`,
      heading: 'Остана едно натискане',
      appUrl: this.config.appUrl,
      supportEmail: this.config.supportEmail,
      body: [
        paragraph(
          `Потвърдете, че този имейл е ваш, и акаунтът се отваря веднага — с ${TRIAL_DAYS} дни ПРО, без карта и без абонамент.`,
        ),
        dataRows([
          ['Пробен период', `${TRIAL_DAYS} дни ПРО, без карта`],
          ['Следени артикула', `${PLAN_PRODUCT_LIMIT[TRIAL_PLAN]} през пробния период`],
          ['AI сравнения', `${TRIAL_AI_MATCHES} за периода`],
          ['Доставчици', 'без ограничение'],
          ['След това', `безплатен план, ${PLAN_PRODUCT_LIMIT[UserPlan.Free]} артикула`],
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

  /**
   * The nudge two days before the trial runs out.
   *
   * Written around what they will lose rather than what they would buy. A
   * person two days from the end of a trial does not need the feature list
   * again — they need to know that the forty articles they entered stop being
   * watched on Thursday, and that one click keeps them.
   */
  async sendTrialEnding(user: User, daysLeft: number, watched: number): Promise<boolean> {
    const subject = `Остават ${daysLeft} дни от пробния период`;
    const freeLimit = PLAN_PRODUCT_LIMIT[UserPlan.Free];
    const parking = Math.max(0, watched - freeLimit);

    const { html, text } = renderEmail({
      title: subject,
      preheader:
        parking > 0
          ? `След ${daysLeft} дни спираме да следим ${parking} от артикулите ви.`
          : 'Данните ви остават. Планът се променя.',
      heading: `Остават ${daysLeft} дни`,
      appUrl: this.config.appUrl,
      supportEmail: this.config.supportEmail,
      body: [
        paragraph(
          parking > 0
            ? `В момента следим <strong>${watched} артикула</strong> вместо вас. Безплатният план следи ${freeLimit}, така че след ${daysLeft} дни <strong>${parking}</strong> от тях спират да се проверяват.`
            : `В момента следим <strong>${watched} артикула</strong> вместо вас — това се събира и в безплатния план, така че нищо няма да спре.`,
        ),
        noticeBox(
          'Нищо не се изтрива. Историята на цените, доставчиците и настройките остават — спрените артикули просто не се проверяват, докато не изберете план.',
          parking > 0 ? 'warn' : 'info',
        ),
        paragraph('Няма нужда да настройвате нищо отново. Ключът ви продължава да работи.'),
      ],
      cta: { label: 'Виж плановете', url: `${this.config.appUrl}/#pricing` },
      footnotes: ['Ако решите да не продължите, не е нужно да правите нищо.'],
    });

    return this.send(user.email, subject, html, text);
  }

  /** Says what actually happened when the seven days ran out. */
  async sendTrialEnded(user: User, watched: number, parked: number): Promise<boolean> {
    const subject = 'Пробният период приключи';

    const { html, text } = renderEmail({
      title: subject,
      preheader:
        parked > 0
          ? `${watched - parked} артикула продължават да се следят, ${parked} са на пауза.`
          : 'Акаунтът ви продължава на безплатния план.',
      heading: 'Пробният период приключи',
      appUrl: this.config.appUrl,
      supportEmail: this.config.supportEmail,
      body: [
        paragraph(
          'Акаунтът ви мина на безплатния план. Ключът ви работи, доставчиците ви са там, историята на цените е непокътната.',
        ),
        dataRows([
          ['Следени сега', String(watched - parked)],
          ['На пауза', String(parked)],
          ['Доставчици', 'без ограничение'],
          ['Търсене при доставчици', 'работи както преди'],
        ]),
        parked > 0
          ? noticeBox(
              `<strong>${parked} артикула</strong> са на пауза — не се изтриват, само не се проверяват. План ги връща обратно с едно натискане.`,
              'warn',
            )
          : paragraph('Всичко, което следите, се събира в безплатния план — нищо не е спряно.'),
      ],
      cta: { label: 'Върни всичко обратно', url: `${this.config.appUrl}/#pricing` },
      footnotes: [
        'Ако седмицата не ви свърши работа — отговорете на това писмо и ни кажете защо. Четем всяко.',
      ],
    });

    return this.send(user.email, subject, html, text);
  }

  /**
   * Sends one order request to a supplier.
   *
   * Three details matter more than the layout.
   *
   * `replyTo` is the buyer, not us. The supplier's answer — "we have it, but
   * only in 100m drums" — has to reach the person who can decide, and a reply
   * that lands in our inbox is a delay and a game of telephone.
   *
   * The message says whose order it is in the first line. We are the tool that
   * worked out where to send it; presenting it as ours would put us between
   * two companies in a commercial transaction, which is a different business
   * with different liabilities.
   *
   * And the prices are labelled as *read from the supplier's own site*, with a
   * request to confirm. They are what the buyer saw, not what either party has
   * agreed, and saying so is what stops a stale figure becoming a dispute.
   */
  async sendOrderRequest(options: {
    to: string;
    replyTo: string;
    buyerName: string;
    orderNumber: number;
    currency: string;
    total: number;
    note: string | null;
    contact: string | null;
    lines: Array<{
      query: string;
      matchedName: string | null;
      quantity: number;
      unitPrice: number;
      lineTotal: number;
    }>;
  }): Promise<boolean> {
    const subject = `Заявка за поръчка №${options.orderNumber} от ${options.buyerName}`;
    const money = (value: number) => `${value.toFixed(2)} ${options.currency}`;

    const { html, text } = renderEmail({
      title: subject,
      preheader: `${options.lines.length} позиции на стойност ${money(options.total)}.`,
      heading: `Заявка за поръчка №${options.orderNumber}`,
      appUrl: this.config.appUrl,
      supportEmail: this.config.supportEmail,
      body: [
        paragraph(
          `${options.contact ? escapeHtml(options.contact) + ', з' : 'З'}дравейте. Това е заявка за поръчка от <strong>${escapeHtml(options.buyerName)}</strong>. Отговорете на това писмо, за да потвърдите наличност и срок — отговорът отива директно при тях.`,
        ),
        dataRows(
          options.lines.map((line) => [
            escapeHtml(line.query) +
              (line.matchedName
                ? ` <span style="opacity:.7">(${escapeHtml(line.matchedName)})</span>`
                : ''),
            `${line.quantity} × ${money(line.unitPrice)} = <strong>${money(line.lineTotal)}</strong>`,
          ]),
        ),
        paragraph(`<strong>Общо: ${money(options.total)}</strong>`),
        options.note ? noticeBox(`Бележка от клиента: ${escapeHtml(options.note)}`) : paragraph(''),
        noticeBox(
          'Цените в тази заявка са прочетени от вашия сайт и са ориентировъчни. Обвързваща е цената, която потвърдите вие.',
        ),
      ],
      footnotes: [
        `Заявката е изпратена през Stoclify от името на ${options.buyerName}. Stoclify не е страна по сделката и не обработва плащания.`,
      ],
    });

    return this.send(options.to, subject, html, text, options.replyTo);
  }

  /** Tells a customer their subscription has lapsed and the key has stopped. */
  async sendAccessExpired(user: User, reason: string): Promise<boolean> {
    const subject = 'Достъпът ви до Stoclify е спрян';

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

  private async send(
    to: string,
    subject: string,
    html: string,
    text: string,
    replyTo?: string,
  ): Promise<boolean> {
    if (!this.transporter) {
      this.logger.warn(`Email is off — "${subject}" for ${to} was not sent.`);
      return false;
    }

    try {
      await this.transporter.sendMail({
        from: this.config.from,
        to,
        subject,
        html,
        text,
        // Set only for mail sent *on somebody's behalf*: an order request must
        // be answered to the buyer, not to us.
        ...(replyTo ? { replyTo } : {}),
      });
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
