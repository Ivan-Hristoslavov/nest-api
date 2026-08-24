import { BlockedAddressError, assertPublicHttpUrl, guardedLookup, isBlockedAddress } from './address-guard';

/**
 * The scraper fetches addresses a customer typed. Everything here is a way
 * somebody could point it at this server's own network instead of a shop.
 */
describe('address guard', () => {
  describe('literal addresses', () => {
    const blocked = [
      ['loopback', '127.0.0.1'],
      ['loopback, unusual spelling', '127.1.1.1'],
      ['IPv6 loopback', '::1'],
      ['IPv4 loopback wearing IPv6 clothes', '::ffff:127.0.0.1'],
      ['cloud metadata', '169.254.169.254'],
      ['private, RFC 1918', '10.0.0.5'],
      ['private, RFC 1918', '172.16.0.1'],
      ['private, RFC 1918', '192.168.1.1'],
      ['carrier NAT', '100.64.0.1'],
      ['unspecified', '0.0.0.0'],
      ['unique local IPv6', 'fd00::1'],
      ['link-local IPv6', 'fe80::1'],
    ] as const;

    for (const [what, address] of blocked) {
      it(`refuses ${what} (${address})`, () => {
        expect(isBlockedAddress(address)).toBe(true);
      });
    }

    const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];

    for (const address of allowed) {
      it(`allows the public address ${address}`, () => {
        expect(isBlockedAddress(address)).toBe(false);
      });
    }

    it('says nothing about a hostname, which is not its job', () => {
      expect(isBlockedAddress('shop.example.com')).toBe(false);
    });
  });

  describe('a URL a customer submitted', () => {
    it('accepts an ordinary shop', () => {
      expect(assertPublicHttpUrl('https://shop.example.com/p/1').hostname).toBe('shop.example.com');
    });

    it('refuses the metadata endpoint', () => {
      expect(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
        BlockedAddressError,
      );
    });

    it('refuses this server talking to itself', () => {
      expect(() => assertPublicHttpUrl('http://127.0.0.1:3000/api/v1/stats')).toThrow(
        BlockedAddressError,
      );
    });

    it('refuses a bracketed IPv6 loopback', () => {
      expect(() => assertPublicHttpUrl('http://[::1]:3000/')).toThrow(BlockedAddressError);
    });

    it('refuses a protocol that is not http', () => {
      expect(() => assertPublicHttpUrl('file:///etc/passwd')).toThrow(TypeError);
      expect(() => assertPublicHttpUrl('gopher://example.com/')).toThrow(TypeError);
    });

    it('refuses something that is not a URL', () => {
      expect(() => assertPublicHttpUrl('not a url')).toThrow(TypeError);
    });

    it('lets a public hostname through — the lookup decides the rest', () => {
      // This is the case the synchronous check cannot answer, and must not
      // pretend to: the name is public, the address behind it may not be.
      expect(() => assertPublicHttpUrl('http://rebind.example.com/')).not.toThrow();
    });
  });

  describe('the lookup an agent uses', () => {
    it('stops a public name that resolves somewhere private', (done) => {
      jest.isolateModules(() => {
        jest.doMock('node:dns', () => ({
          ...jest.requireActual('node:dns'),
          lookup: (_host: string, _options: unknown, cb: Function) => cb(null, '127.0.0.1', 4),
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { guardedLookup: guarded } = require('./address-guard');

        guarded('rebind.example.com', {}, (error: NodeJS.ErrnoException | null) => {
          expect(error).toBeTruthy();
          expect(error?.code).toBe('EBLOCKEDADDRESS');
          done();
        });
      });
    });

    it('stops a name where only one of several records is private', (done) => {
      jest.isolateModules(() => {
        jest.doMock('node:dns', () => ({
          ...jest.requireActual('node:dns'),
          lookup: (_host: string, _options: unknown, cb: Function) =>
            cb(null, [
              { address: '93.184.216.34', family: 4 },
              { address: '169.254.169.254', family: 4 },
            ]),
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { guardedLookup: guarded } = require('./address-guard');

        guarded('mixed.example.com', { all: true }, (error: NodeJS.ErrnoException | null) => {
          expect(error?.code).toBe('EBLOCKEDADDRESS');
          done();
        });
      });
    });

    it('lets an ordinary public answer through', (done) => {
      guardedLookup('example.com', {}, (error, address) => {
        // No network in the test environment is fine: what must not happen is
        // the guard inventing a block for a name it could not resolve.
        if (error) {
          expect(error.code).not.toBe('EBLOCKEDADDRESS');
        } else {
          expect(address).toBeTruthy();
        }
        done();
      });
    });
  });
});
