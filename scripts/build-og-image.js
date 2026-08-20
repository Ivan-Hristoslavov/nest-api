/*
 * Draws public/og-image.png.
 *
 * A share card has to be a raster: Facebook, LinkedIn and X all refuse SVG for
 * `og:image`, so the brand mark is rasterised here rather than referenced. Run
 * with `npm run build:og` after changing the mark or the palette.
 *
 * Written against zlib and the PNG spec rather than pulling in a canvas
 * library, because the whole drawing is four rounded rectangles and a native
 * image dependency is a lot of build surface for that.
 *
 * This is deliberately wordless. Rendering a wordmark without a font engine
 * produces something that looks hand-drawn, and a card that looks amateur is
 * worse than one that is simply clean — replace it with a designed 1200×630
 * when there is one.
 */
const { deflateSync } = require('node:zlib');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const WIDTH = 1200;
const HEIGHT = 630;

/** The palette, taken from the same tokens the site uses. */
const BACKGROUND = [8, 9, 11];
const PANEL = [12, 14, 18];
const ACCENT = [13, 148, 136];
const WHITE = [255, 255, 255];

const canvas = Buffer.alloc(WIDTH * HEIGHT * 3);

function fill(colour) {
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    canvas[index * 3] = colour[0];
    canvas[index * 3 + 1] = colour[1];
    canvas[index * 3 + 2] = colour[2];
  }
}

/** Blends one colour over what is already there. */
function blend(x, y, colour, alpha) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT || alpha <= 0) return;

  const index = (y * WIDTH + x) * 3;
  for (let channel = 0; channel < 3; channel += 1) {
    canvas[index + channel] = Math.round(
      canvas[index + channel] * (1 - alpha) + colour[channel] * alpha,
    );
  }
}

/**
 * A rounded rectangle, anti-aliased at the corners.
 *
 * The alpha comes from the distance to the corner circle rather than from
 * supersampling: one subtraction per pixel, and at this size the difference
 * is invisible.
 */
function roundedRect(left, top, width, height, radius, colour, alpha = 1) {
  for (let y = Math.floor(top); y < Math.ceil(top + height); y += 1) {
    for (let x = Math.floor(left); x < Math.ceil(left + width); x += 1) {
      const insideX = Math.min(x - left, left + width - 1 - x);
      const insideY = Math.min(y - top, top + height - 1 - y);

      let coverage = 1;

      if (insideX < radius && insideY < radius) {
        const dx = radius - insideX;
        const dy = radius - insideY;
        coverage = Math.max(0, Math.min(1, radius - Math.sqrt(dx * dx + dy * dy) + 0.5));
      }

      blend(x, y, colour, coverage * alpha);
    }
  }
}

// --- The card -------------------------------------------------------------
fill(BACKGROUND);

// A faint panel, so the mark sits on something rather than floating.
roundedRect(60, 60, WIDTH - 120, HEIGHT - 120, 32, PANEL, 1);

// The mark: three crates narrowing to the one the product picks out. Same
// proportions as favicon.svg, scaled up.
const markCentre = WIDTH / 2;
const crates = [
  { width: 420, height: 96, y: 366, colour: WHITE, alpha: 0.4 },
  { width: 310, height: 96, y: 250, colour: WHITE, alpha: 0.68 },
  { width: 200, height: 96, y: 134, colour: ACCENT, alpha: 1 },
];

for (const crate of crates) {
  roundedRect(markCentre - crate.width / 2, crate.y, crate.width, crate.height, 24, crate.colour, crate.alpha);
}

// A rule under the mark, the accent colour, as a base line.
roundedRect(markCentre - 210, 510, 420, 6, 3, ACCENT, 0.9);

// --- PNG ------------------------------------------------------------------
/** Each row is prefixed with its filter byte; 0 means "stored as-is". */
function rawWithFilters() {
  const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    raw[y * (WIDTH * 3 + 1)] = 0;
    canvas.copy(raw, y * (WIDTH * 3 + 1) + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
  }
  return raw;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));

  return Buffer.concat([length, typed, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // colour type: truecolour, no alpha
// bytes 10-12 stay zero: deflate, adaptive filtering, no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(rawWithFilters(), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const output = join(process.cwd(), 'public', 'og-image.png');
writeFileSync(output, png);

console.log(`Wrote ${output} — ${WIDTH}×${HEIGHT}, ${(png.length / 1024).toFixed(1)} KB`);
