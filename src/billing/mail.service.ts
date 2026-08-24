import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

import { redactEmail } from '../common/redact';
import { translator } from './email-locale';
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

  /** True when mail leaves over Resend's HTTPS API rather than SMTP. */
  private get viaResend(): boolean {
    return Boolean(this.config.resendApiKey);
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.warn(
        'Email is off (needs SMTP_FROM, plus either RESEND_API_KEY or SMTP_HOST). Paid ' +
          'accounts will be activated but their API key will NOT be delivered — issue it ' +
          'from the operator screen instead.',
      );
      return;
    }

    // Resend wins where both are configured, because it is the one that works
    // from a host with the SMTP ports closed — which is every platform this is
    // likely to run on. SMTP stays for a laptop, where it needs no account.
    if (this.viaResend) {
      this.logger.log(`Email ready via the Resend API as ${this.config.from}`);
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
      // Registration waits for its verification email before it answers, so
      // these decide how long somebody stares at a spinner when the mail
      // server is unreachable, wrong, or — as on a deployment where
      // SMTP_PASSWORD was never set — refusing to authenticate. Nodemailer's
      // defaults are minutes; a person gives up long before that and tries
      // again, which sends a second mail rather than fixing anything.
      //
      // Generous enough for a real server on a bad day, short enough that a
      // broken one produces an error instead of a hang.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    this.logger.log(
      `Email ready via ${this.config.host}:${this.config.port} as ${this.config.from}`,
    );
  }

  get enabled(): boolean {
    return this.config.enabled && this.transporter !== null;
  }

  /** Confirms the settings without sending anything. */
  async verify(): Promise<{ ok: boolean; detail: string }> {
    if (this.viaResend) {
      // Asks Resend who the key belongs to. It proves the key is live and that
      // 443 is open, which are the two things that fail in practice.
      try {
        const response = await fetch('https://api.resend.com/domains', {
          headers: { Authorization: `Bearer ${this.config.resendApiKey}` },
          signal: AbortSignal.timeout(10_000),
        });

        return response.ok
          ? { ok: true, detail: `Resend accepted the key; sending as ${this.config.from}.` }
          : { ok: false, detail: `Resend refused the key: HTTP ${response.status}.` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    }

    if (!this.transporter) {
      return { ok: false, detail: 'Mail is not configured (needs RESEND_API_KEY or SMTP_HOST).' };
    }

    try {
      await this.transporter.verify();
      return { ok: true, detail: `${this.config.host}:${this.config.port} accepted the login.` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * One message, over HTTPS.
   *
   * The whole reason this exists: the platform closes the SMTP ports, so the
   * transport has to be something that speaks over 443. The shape of the call
   * is deliberately the same as `send` above — same arguments, same boolean,
   * same swallowed failure — so nothing upstream knows or cares which one ran.
   *
   * Never throws. A failed send is reported, logged and survived: the payment
   * that triggered it already succeeded, and an exception here would make the
   * provider retry a charge that worked.
   */
  private async sendViaResend(
    to: string,
    subject: string,
    html: string,
    text: string,
    replyTo?: string,
  ): Promise<boolean> {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [to],
          subject,
          html,
          text,
          // Set only for mail sent *on somebody's behalf*: an order request
          // must be answered to the buyer, not to us.
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        // The body carries why — an unverified sender domain, a malformed
        // address — and that sentence is the difference between a fix and a
        // guess.
        const detail = await response.text().catch(() => '');
        this.logger.error(
          `Could not email ${to} ("${subject}"): Resend returned ${response.status} ${detail.slice(0, 300)}`,
        );
        return false;
      }

      this.logger.log(`Emailed ${redactEmail(to)}: "${subject}"`);
      return true;
    } catch (error) {
      this.logger.error(
        `Could not email ${to} ("${subject}"): ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Sends a customer the key their payment bought.
   *
   * @returns whether it went out, so the caller can tell the operator that a
   * key still needs delivering by hand.
   */
  async sendApiKey(user: User, apiKey: string, replaced = false): Promise<boolean> {
    const t = translator(user.locale);
    const plan = t(PLAN_LABELS[user.plan] ?? user.plan);
    const subject = replaced
      ? t('Новият ви ключ за Stoclify')
      : t('Готово — ето ключа ви за Stoclify');

    const { html, text } = renderEmail({
      title: subject,
      preheader: replaced
        ? t('Предишният ключ вече не работи.')
        : t('Акаунтът ви е активен на план {plan}. Ключът е вътре.', { plan }),
      heading: replaced ? t('Ето новия ви ключ') : t('Акаунтът ви е готов'),
      appUrl: this.config.appUrl,
      supportEmail: this.config.supportEmail,
      body: [
        paragraph(
          replaced
            ? t(
                'Издадохме нов ключ по ваша заявка. <strong>Предишният спря да работи в същия момент</strong> — ако някъде е останал записан, заменете го.',
              )
            : t('Благодарим ви. Планът ви е <strong>{plan}</strong> и достъпът е активен веднага.', {
                plan: escapeHtml(plan),
              }),
        ),
        codeBlock(apiKey, t('Вашият ключ')),
        noticeBox(
          t(
            '<strong>Запазете това писмо.</strong> Ключът се пази само като хеш — никой, включително ние, не може да го прочете повторно. Загубен ключ не се възстановява, а се заменя с нов.',
          ),
          'warn',
        ),
        dataRows([
          [
            t('План'),
            user.isOnTrial()
              ? t('{plan} — пробен, {days} дни', {
                  plan,
                  days: user.trialDaysLeft() ?? TRIAL_DAYS,
                })
              : plan,
          ],
          [t('Следени артикула'), String(user.productLimit)],
          [
            t('AI сравнения'),
            user.isOnTrial()
              ? t('{count} за пробния период', { count: user.aiMatchesLimit })
              : t('{count} на месец', { count: user.aiMatchesLimit }),
          ],
          [t('Доставчици'), t('без ограничение')],
        ]),
      ],
      cta: { label: t('Отвори таблото'), url: this.config.appUrl },
      footnotes: [
        t(
          'Поставете ключа в полето за достъп горе вдясно — браузърът го помни, за да не го въвеждате всеки път.',
        ),
        t(
          'Ключът е равнозначен на парола. Не го пращайте по чат и не го оставяйте в споделен документ.',
        ),
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
    const t = translator(user.locale);
    const subject = t('Вход в Stoclify');

    const { html, text } = renderEmail({
      title: subject,
      preheader: t('Връзката важи {minutes} минути и се използва веднъж.', { minutes }),
      heading: t('Влезте в таблото си'),
      appUrl: this.config.appUrl,
      supportEmail: this.config.supportEmail,
      body: [
        paragraph(
          t(
            'Натиснете бутона и ще ви пуснем в акаунта <strong>{email}</strong>. Няма парола за помнене.',
            { email: escapeHtml(user.email) },
          ),
        ),
        noticeBox(
          t(
            'Връзката важи <strong>{minutes} минути</strong> и работи само веднъж. Ако не сте я поискали вие — не правете нищо; без натискане не се случва нищо.',
            { minutes },
          ),
        ),
      ],
      cta: { label: t('Влез в таблото'), url },
      footnotes: [
        t('Ако бутонът не сработи, копирайте адреса от него в браузъра.'),
        t(
          'Това писмо не съдържа вашия API ключ — той се използва от програми, а този вход е за хора.',
        ),
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
    const t = translator(user.locale);
    const subject = t('Потвърдете имейла си за Stoclify');

    const { html, text } = renderEmail({
      title: subject,
      preheader: t('Едно натискане отваря акаунта. Връзката важи {minutes} минути.', { minutes }),
      heading: t('Остана едно натискане'),
      appUrl: this.config.appUrl,
      supportEmail: this.config.supportEmail,
      body: [
        paragraph(
          t(
            'Потвърдете, че този имейл е ваш, и акаунтът се отваря веднага — с {days} дни ПРО, без карта и без абонамент.',
            { days: TRIAL_DAYS },
          ),
        ),
        dataRows([
          [t('Пробен период'), t('{days} дни ПРО, без карта', { days: TRIAL_DAYS })],
          [
            t('Следени артикула'),
            t('{count} през пробния период', { count: PLAN_PRODUCT_LIMIT[TRIAL_PLAN] }),
          ],
          [t('AI сравнения'), t('{count} за периода', { count: TRIAL_AI_MATCHES })],
          [t('Доставчици'), t('без ограничение')],
          [
            t('След това'),
            t('безплатен план, {count} артикула', { count: PLAN_PRODUCT_LIMIT[UserPlan.Free] }),
          ],
        ]),
        noticeBox(
          t(
            'Връзката важи <strong>{minutes} минути</strong> и работи веднъж. Ако не сте се регистрирали вие — не правете нищо и акаунтът никога не се отваря.',
            { minutes },
          ),
        ),
      ],
      cta: { label: t('Потвърди и влез'), url },
      footnotes: [t('Ако бутонът не сработи, копирайте адреса от него в браузъра.')],
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
    if (this.viaResend) {
      return this.sendViaResend(to, subject, html, text, replyTo);
    }

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
