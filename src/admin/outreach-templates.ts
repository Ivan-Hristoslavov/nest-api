/**
 * The letter that asks a supplier for a feed.
 *
 * Written in the language of the site rather than in ours. A wholesaler in
 * Bucharest who opens an email in Bulgarian has already decided what it is
 * before reading a line of it.
 *
 * On what it says, and what it used to say. The first version led with the
 * scraping: we read your pages, it loads your server, give us a feed and we
 * will stop. Read from their side that is not an offer, it is a demand with
 * the harm named first — and "we will stop reading your site" listed as a
 * *benefit* is protection money, however politely it is put.
 *
 * The rewrite leads with the only thing that is actually theirs to gain:
 * buyers on this platform compare suppliers and then order from them, by
 * email, with the buyer's own address in reply-to. A supplier whose price is
 * current gets the order. One whose price is stale loses it over a difference
 * that frequently does not exist. That is a revenue argument, it is true, and
 * it does not require them to feel cornered to be persuasive.
 *
 * The scraping is still disclosed — saying nothing about it would be worse —
 * but late, factually, and with the explicit line that a refusal changes
 * nothing. A supplier who says no is not punished, and the letter has to say
 * so or the offer reads as a threat regardless of wording.
 */

export type OutreachLocale = 'bg' | 'en' | 'ro' | 'el';

export const OUTREACH_LOCALES: OutreachLocale[] = ['bg', 'en', 'ro', 'el'];

/**
 * Which language to write in, read off the host.
 *
 * The country top-level domain decides it. Where there is none — `.eu`,
 * `.com` — a country prefix is the next best signal: `bg.elmarkstore.eu` is a
 * Bulgarian storefront no matter what the registry says, and English there
 * would be a worse guess than the one the subdomain is making for us.
 *
 * Everything unrecognised gets English, which is the language a European
 * wholesaler is least likely to be unable to read.
 */
export function localeForHost(host: string): OutreachLocale {
  const clean = host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');

  if (clean.endsWith('.bg')) return 'bg';
  if (clean.endsWith('.ro')) return 'ro';
  if (clean.endsWith('.gr')) return 'el';

  if (/^bg\.|\.bg\./.test(clean)) return 'bg';
  if (/^ro\.|\.ro\./.test(clean)) return 'ro';
  if (/^(gr|el)\.|\.(gr|el)\./.test(clean)) return 'el';

  return 'en';
}

export interface OutreachOptions {
  host: string;
  /** How many of our customers already compare this supplier. */
  buyers: number;
  locale: OutreachLocale;
  appUrl: string;
  senderName: string;
  senderEmail: string;
}

export interface OutreachLetter {
  subject: string;
  body: string;
}

interface Strings {
  subject: string;
  presenceMany: (buyers: number) => string;
  presenceOne: string;
  presenceNone: string;
  build: (parts: {
    host: string;
    presence: string;
    appUrl: string;
    senderName: string;
    senderEmail: string;
  }) => string;
}

const BG: Strings = {
  subject: 'Вашите цени пред купувачи на едро',
  presenceMany: (buyers) => `Вие вече присъствате в сравненията на ${buyers} наши клиенти.`,
  presenceOne: 'Вие вече присъствате в сравненията на наш клиент.',
  presenceNone:
    'Платформата се ползва от търговци на едро, които избират доставчик по цена и наличност.',
  build: ({ host, presence, appUrl, senderName, senderEmail }) =>
    `Здравейте,

Пиша ви от Stoclify — платформа, в която търговци на едро сравняват своите доставчици и поръчват от тях.

${presence} Когато вашата цена излезе вярна и актуална, поръчката идва при вас. Когато е стара или разчетена грешно, отива при друг — заради разлика, която често не съществува.

Затова ви пиша. Ако ни дадете четящ достъп до цените и наличностите — API ключ, XML или CSV емисия, дори файл по график — вашето предложение ще се показва точно както го публикувате, с наличността, която наистина имате.

Какво получавате:
- присъствие пред купувачи, които в момента избират доставчик
- поръчките идват като обикновен имейл, на който отговаряте директно на купувача — няма портал за учене и няма интеграция за правене
- нищо не плащате: без комисиона, без изключителност, без договор

За пълна яснота: днес четем публичните страници на ${host}, за да поддържаме цените актуални. Емисията е по-точна за вас и по-лека за сайта ви, но изборът е ваш и нищо няма да се промени, ако предпочетете да откажете.

Повече за платформата: ${appUrl}

Ако не представлява интерес, един ред отговор е достатъчен и няма да ви пишем отново.

Поздрави,
${senderName}
${senderEmail}`,
};

const EN: Strings = {
  subject: 'Your prices in front of wholesale buyers',
  presenceMany: (buyers) => `You already appear in the comparisons of ${buyers} of our customers.`,
  presenceOne: 'You already appear in the comparisons of one of our customers.',
  presenceNone:
    'The platform is used by wholesale buyers choosing a supplier on price and availability.',
  build: ({ host, presence, appUrl, senderName, senderEmail }) =>
    `Hello,

I am writing from Stoclify, a platform where wholesale buyers compare their suppliers and order from them.

${presence} When your price shows up correct and current, the order comes to you. When it is stale or misread, it goes to somebody else — over a difference that frequently does not exist.

That is why I am writing. With read access to your prices and stock — an API key, an XML or CSV feed, even a scheduled file — your offer would appear exactly as you publish it, with the availability you actually have.

What you get:
- visibility with buyers who are choosing a supplier right now
- orders arriving as an ordinary email you answer directly to the buyer — no portal to learn, no integration to build
- no cost at all: no commission, no exclusivity, no contract

To be straightforward about it: today we read the public pages of ${host} to keep prices current. A feed is more accurate for you and lighter on your site, but the choice is yours and nothing changes if you would rather decline.

More about the platform: ${appUrl}

If this is not of interest, one line back is enough and we will not write again.

Kind regards,
${senderName}
${senderEmail}`,
};

const RO: Strings = {
  subject: 'Prețurile dumneavoastră în fața cumpărătorilor en gros',
  presenceMany: (buyers) => `Apăreți deja în comparațiile a ${buyers} dintre clienții noștri.`,
  presenceOne: 'Apăreți deja în comparațiile unui client de-al nostru.',
  presenceNone:
    'Platforma este folosită de cumpărători en gros care își aleg furnizorul după preț și disponibilitate.',
  build: ({ host, presence, appUrl, senderName, senderEmail }) =>
    `Bună ziua,

Vă scriu din partea Stoclify, o platformă în care cumpărătorii en gros își compară furnizorii și comandă de la ei.

${presence} Când prețul dumneavoastră apare corect și actualizat, comanda vine la dumneavoastră. Când este vechi sau citit greșit, ajunge la altcineva — pentru o diferență care de multe ori nici nu există.

De aceea vă scriu. Cu acces de citire la prețuri și stocuri — o cheie API, un flux XML sau CSV, chiar și un fișier trimis periodic — oferta dumneavoastră ar apărea exact așa cum o publicați, cu disponibilitatea pe care o aveți în realitate.

Ce primiți:
- vizibilitate în fața cumpărătorilor care își aleg furnizorul chiar acum
- comenzile ajung ca un e-mail obișnuit, la care răspundeți direct cumpărătorului — fără portal de învățat și fără integrare de făcut
- nu plătiți nimic: fără comision, fără exclusivitate, fără contract

Ca să fie limpede: astăzi citim paginile publice de pe ${host} pentru a menține prețurile actualizate. Un flux este mai exact pentru dumneavoastră și mai ușor pentru site, dar alegerea vă aparține și nu se schimbă nimic dacă preferați să refuzați.

Mai multe despre platformă: ${appUrl}

Dacă nu vă interesează, un singur rând de răspuns este suficient și nu vă vom mai scrie.

Cu stimă,
${senderName}
${senderEmail}`,
};

const EL: Strings = {
  subject: 'Οι τιμές σας μπροστά σε χονδρεμπόρους',
  presenceMany: (buyers) => `Εμφανίζεστε ήδη στις συγκρίσεις ${buyers} πελατών μας.`,
  presenceOne: 'Εμφανίζεστε ήδη στις συγκρίσεις ενός πελάτη μας.',
  presenceNone:
    'Την πλατφόρμα τη χρησιμοποιούν χονδρέμποροι που επιλέγουν προμηθευτή με βάση την τιμή και τη διαθεσιμότητα.',
  build: ({ host, presence, appUrl, senderName, senderEmail }) =>
    `Καλησπέρα σας,

Σας γράφω από τη Stoclify, μια πλατφόρμα όπου χονδρέμποροι συγκρίνουν τους προμηθευτές τους και παραγγέλνουν από αυτούς.

${presence} Όταν η τιμή σας εμφανίζεται σωστή και ενημερωμένη, η παραγγελία έρχεται σε εσάς. Όταν είναι παλιά ή διαβαστεί λάθος, πηγαίνει σε κάποιον άλλον — για μια διαφορά που συχνά δεν υπάρχει καν.

Γι' αυτό σας γράφω. Με πρόσβαση ανάγνωσης στις τιμές και τη διαθεσιμότητα — ένα κλειδί API, μια ροή XML ή CSV, ακόμη και ένα αρχείο σε τακτά διαστήματα — η προσφορά σας θα εμφανίζεται ακριβώς όπως τη δημοσιεύετε, με τη διαθεσιμότητα που πραγματικά έχετε.

Τι κερδίζετε:
- προβολή σε αγοραστές που επιλέγουν προμηθευτή αυτή τη στιγμή
- οι παραγγελίες φτάνουν ως απλό email, στο οποίο απαντάτε απευθείας στον αγοραστή — χωρίς πλατφόρμα να μάθετε και χωρίς ενοποίηση να φτιάξετε
- δεν πληρώνετε τίποτα: χωρίς προμήθεια, χωρίς αποκλειστικότητα, χωρίς σύμβαση

Για να είμαστε ξεκάθαροι: σήμερα διαβάζουμε τις δημόσιες σελίδες του ${host} για να κρατάμε τις τιμές ενημερωμένες. Μια ροή είναι πιο ακριβής για εσάς και πιο ελαφριά για τον ιστότοπό σας, αλλά η επιλογή είναι δική σας και δεν αλλάζει τίποτα αν προτιμάτε να αρνηθείτε.

Περισσότερα για την πλατφόρμα: ${appUrl}

Αν δεν σας ενδιαφέρει, μία γραμμή απάντησης αρκεί και δεν θα σας ξαναγράψουμε.

Με εκτίμηση,
${senderName}
${senderEmail}`,
};

const STRINGS: Record<OutreachLocale, Strings> = { bg: BG, en: EN, ro: RO, el: EL };

export function buildOutreach(options: OutreachOptions): OutreachLetter {
  const strings = STRINGS[options.locale] ?? EN;

  // One customer is not "1 of our customers" in any of these languages, and
  // none is not a number worth writing at all — a claim of demand we cannot
  // make is the one line that would make the rest of the letter untrustworthy.
  const presence =
    options.buyers > 1
      ? strings.presenceMany(options.buyers)
      : options.buyers === 1
        ? strings.presenceOne
        : strings.presenceNone;

  const body = strings
    .build({
      host: options.host,
      presence,
      appUrl: options.appUrl,
      senderName: options.senderName,
      senderEmail: options.senderEmail,
    })
    .replace(/\n{3,}/g, '\n\n');

  return { subject: strings.subject, body };
}
