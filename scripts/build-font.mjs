// Converts assets/fonts/RussoOne-Regular.ttf (SIL OFL, see assets/fonts/OFL.txt)
// into three.js typeface JSON for TextGeometry, keeping only printable ASCII.
//
//   npm run font   ->  public/fonts/hud.typeface.json (3D text)
//                      public/fonts/hud.ttf (canvas text on the manual's pages)

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'assets', 'fonts', 'RussoOne-Regular.ttf');
const out = join(root, 'public', 'fonts', 'hud.typeface.json');

const buf = readFileSync(src);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const r = (n) => Math.round(n);

const glyphs = {};
for (let code = 32; code < 127; code++) {
  const ch = String.fromCharCode(code);
  const g = font.charToGlyph(ch);
  if (!g) continue;
  // Glyph outlines are in font units, y up, which is what three expects.
  // three's order: q = end x y, control x y; b = end x y, c1 x y, c2 x y.
  const o = [];
  for (const c of g.path.commands) {
    if (c.type === 'M') o.push('m', r(c.x), r(c.y));
    else if (c.type === 'L') o.push('l', r(c.x), r(c.y));
    else if (c.type === 'Q') o.push('q', r(c.x), r(c.y), r(c.x1), r(c.y1));
    else if (c.type === 'C') o.push('b', r(c.x), r(c.y), r(c.x1), r(c.y1), r(c.x2), r(c.y2));
  }
  const bb = g.getBoundingBox();
  glyphs[ch] = { ha: r(g.advanceWidth), x_min: r(bb.x1), x_max: r(bb.x2), o: o.join(' ') };
}

const t = font.tables;
const json = {
  glyphs,
  familyName: font.names.fontFamily?.en ?? 'Russo One',
  ascender: r(t.hhea.ascender),
  descender: r(t.hhea.descender),
  underlinePosition: r(t.post.underlinePosition),
  underlineThickness: r(t.post.underlineThickness),
  boundingBox: { xMin: r(t.head.xMin), yMin: r(t.head.yMin), xMax: r(t.head.xMax), yMax: r(t.head.yMax) },
  resolution: font.unitsPerEm,
  original_font_information: { license: 'SIL Open Font License 1.1', copyright: 'Copyright (c) 2011-2012, Jovanny Lemonad' },
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(json));
copyFileSync(src, join(dirname(out), 'hud.ttf'));
copyFileSync(join(root, 'assets', 'fonts', 'OFL.txt'), join(dirname(out), 'OFL.txt'));
console.log(`${out}: ${Object.keys(glyphs).length} glyphs, ${(JSON.stringify(json).length / 1024).toFixed(0)} KB`);
