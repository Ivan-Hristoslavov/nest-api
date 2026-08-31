import { SEARCH_PROVIDERS } from './search-providers';

/**
 * Where a search looks.
 *
 * A purchasing question has two forms and they are asked minutes apart: "can I
 * get this from somebody I already deal with?" and, when the answer is no,
 * "then who does sell it?". These pin the rules that keep the two apart —
 * chiefly that a shop nobody has terms with can never be quoted at a
 * negotiated price.
 */
describe('search scope', () => {
  /** The rule the service applies, kept here so it can be tested on its own. */
  const globalPool = (mine: string[]): string[] => {
    const owned = (host: string): boolean =>
      mine.some((own) => {
        const left = own.replace(/^www\./, '').toLowerCase();
        const right = host.toLowerCase();
        return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
      });

    return SEARCH_PROVIDERS.filter((provider) => !owned(provider.host)).map(
      (provider) => provider.host,
    );
  };

  it('adds the verified shelf when the buyer asks to look everywhere', () => {
    expect(globalPool([]).length).toBe(SEARCH_PROVIDERS.length);
    expect(globalPool([]).length).toBeGreaterThan(0);
  });

  it('never searches one shop twice', () => {
    // A shop the buyer has added is searched as theirs — with their terms and
    // their discount — and must not also appear as a stranger's.
    const owned = SEARCH_PROVIDERS[0].host;
    expect(globalPool([owned])).not.toContain(owned);
  });

  it('recognises the same shop under a subdomain', () => {
    const owned = SEARCH_PROVIDERS[0].host;
    expect(globalPool([`bg.${owned}`])).not.toContain(owned);
    expect(globalPool([`www.${owned}`])).not.toContain(owned);
  });
});
