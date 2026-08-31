import { buildOutreach, localeForHost, OUTREACH_LOCALES } from './outreach-templates';

describe('localeForHost', () => {
  it('reads the country top-level domain', () => {
    expect(localeForHost('partner.bg')).toBe('bg');
    expect(localeForHost('depozit.ro')).toBe('ro');
    expect(localeForHost('emporio.gr')).toBe('el');
  });

  it('falls back to English where the domain says nothing', () => {
    expect(localeForHost('supplier.com')).toBe('en');
    expect(localeForHost('wholesale.eu')).toBe('en');
    expect(localeForHost('shop.io')).toBe('en');
  });

  // The case that started this: a Bulgarian storefront on a .eu registry.
  // Reading only the TLD writes to them in English, which is a worse guess
  // than the one their own subdomain is making for us.
  it('takes the hint from a country subdomain', () => {
    expect(localeForHost('bg.elmarkstore.eu')).toBe('bg');
    expect(localeForHost('ro.example.com')).toBe('ro');
    expect(localeForHost('gr.example.com')).toBe('el');
  });

  it('ignores www and casing', () => {
    expect(localeForHost('WWW.Partner.BG')).toBe('bg');
  });

  it('does not mistake a country name inside a word for a subdomain', () => {
    expect(localeForHost('bgtools.com')).toBe('en');
    expect(localeForHost('bulgaria-parts.com')).toBe('en');
  });
});

describe('buildOutreach', () => {
  const base = {
    host: 'partner.bg',
    locale: 'bg' as const,
    appUrl: 'https://stoclify.bg',
    senderName: 'Stoclify',
    senderEmail: 'hello@stoclify.bg',
  };

  it('writes in every language it offers', () => {
    for (const locale of OUTREACH_LOCALES) {
      const letter = buildOutreach({ ...base, locale, buyers: 3 });

      expect(letter.subject.length).toBeGreaterThan(10);
      expect(letter.body).toContain('https://stoclify.bg');
      expect(letter.body).toContain('hello@stoclify.bg');
      expect(letter.body).toContain('partner.bg');
      expect(letter.body.length).toBeGreaterThan(400);
    }
  });

  // The subject used to be "a price feed for partner.bg instead of us reading
  // the pages" — our problem, in their inbox, before they had read a word.
  it('offers something in the subject rather than naming our scraper', () => {
    for (const locale of OUTREACH_LOCALES) {
      const { subject } = buildOutreach({ ...base, locale, buyers: 2 });

      expect(subject).not.toContain('partner.bg');
      expect(subject.toLowerCase()).not.toMatch(/scrap|четен|citim|διαβάζ/);
    }
  });

  /*
   * The letter's whole failure mode is sounding like a demand: we are already
   * taking from you, so hand over a feed. Two properties keep it an offer.
   */
  describe('reads as an offer, not as a demand', () => {
    it('never lists stopping our own scraping as a benefit', () => {
      const banned = {
        bg: 'спира автоматичното четене',
        en: 'our automated reading of your site stops',
        ro: 'citirea automată a site-ului dumneavoastră de către noi încetează',
        el: 'σταματά η αυτόματη ανάγνωση',
      };

      for (const locale of OUTREACH_LOCALES) {
        expect(buildOutreach({ ...base, locale, buyers: 2 }).body).not.toContain(banned[locale]);
      }
    });

    it('says plainly that refusing costs them nothing', () => {
      const reassurance = {
        bg: 'нищо няма да се промени, ако предпочетете да откажете',
        en: 'nothing changes if you would rather decline',
        ro: 'nu se schimbă nimic dacă preferați să refuzați',
        el: 'δεν αλλάζει τίποτα αν προτιμάτε να αρνηθείτε',
      };

      for (const locale of OUTREACH_LOCALES) {
        expect(buildOutreach({ ...base, locale, buyers: 2 }).body).toContain(reassurance[locale]);
      }
    });

    // Order on the page is the argument: what they gain has to arrive before
    // the admission that we are reading their site, or the gain reads as the
    // price of making us stop.
    it('puts what they gain before what we already do', () => {
      const gain = {
        bg: 'поръчката идва при вас',
        en: 'the order comes to you',
        ro: 'comanda vine la dumneavoastră',
        el: 'η παραγγελία έρχεται σε εσάς',
      };
      const admission = {
        bg: 'четем публичните страници',
        en: 'we read the public pages',
        ro: 'citim paginile publice',
        el: 'διαβάζουμε τις δημόσιες σελίδες',
      };

      for (const locale of OUTREACH_LOCALES) {
        const body = buildOutreach({ ...base, locale, buyers: 2 }).body;

        expect(body.indexOf(gain[locale])).toBeGreaterThan(-1);
        expect(body.indexOf(admission[locale])).toBeGreaterThan(-1);
        expect(body.indexOf(gain[locale])).toBeLessThan(body.indexOf(admission[locale]));
      }
    });

    it('discloses the scraping rather than hiding it', () => {
      const admission = {
        bg: 'четем публичните страници',
        en: 'we read the public pages',
        ro: 'citim paginile publice',
        el: 'διαβάζουμε τις δημόσιες σελίδες',
      };

      for (const locale of OUTREACH_LOCALES) {
        expect(buildOutreach({ ...base, locale, buyers: 2 }).body).toContain(admission[locale]);
      }
    });
  });

  it('counts the buyers when there are several', () => {
    expect(buildOutreach({ ...base, buyers: 4 }).body).toContain('4 наши клиенти');
  });

  it('does not say "1 customer"', () => {
    const body = buildOutreach({ ...base, buyers: 1 }).body;

    expect(body).toContain('на наш клиент');
    expect(body).not.toContain('1 наши');
  });

  // A claim of demand we cannot make is the one line that would make the rest
  // of the letter untrustworthy, so it is dropped rather than zeroed.
  it('claims no demand when there is none, and leaves no hole where it was', () => {
    const body = buildOutreach({ ...base, buyers: 0 }).body;

    expect(body).not.toMatch(/присъствате в сравненията/);
    expect(body).not.toMatch(/\n{3,}/);
  });

  it('always offers a way out, in every language', () => {
    const optOut = {
      bg: 'няма да ви пишем отново',
      en: 'we will not write again',
      ro: 'nu vă vom mai scrie',
      el: 'δεν θα σας ξαναγράψουμε',
    };

    for (const locale of OUTREACH_LOCALES) {
      expect(buildOutreach({ ...base, locale, buyers: 2 }).body).toContain(optOut[locale]);
    }
  });
});
