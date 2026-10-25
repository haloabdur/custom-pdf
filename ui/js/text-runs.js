// Turns pdf.js text items into editable "runs" (one line of text each) and
// guesses the style of each run so a replacement looks like the original.

/** CSS stacks that match the standard PDF fonts the edits are written with. */
export const FONT_CSS = {
  sans: 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", "Nimbus Roman", serif',
  mono: '"Courier New", Courier, "Liberation Mono", "Nimbus Mono PS", monospace',
};

/** Ascent/descent (em) of those CSS fonts, to put the CSS baseline exactly on the PDF one. */
const CSS_METRICS = {
  sans: [0.905, 0.212],
  serif: [0.891, 0.216],
  mono: [0.833, 0.3],
};

/** Distance from the top of a CSS line box to its baseline, in em. */
export function baselineOffset(font, lineHeight) {
  const [asc, desc] = CSS_METRICS[font] || CSS_METRICS.sans;
  return (lineHeight - (asc + desc)) / 2 + asc;
}

export const FONT_LABEL = { sans: 'Sans (Helvetica)', serif: 'Serif (Times)', mono: 'Mono (Courier)' };

function cleanFontName(name) {
  return String(name || '').replace(/^[A-Z]{6}\+/, '').replace(/[-_,]?(MT|PS|PSMT)$/i, '');
}

export function classifyFont(fontObj, style) {
  const raw = fontObj?.name || '';
  const name = cleanFontName(raw);
  const n = name.toLowerCase();
  let font = 'sans';
  if (fontObj?.isMonospace || /mono|courier|consol|menlo|code|typewriter/.test(n) || style?.fontFamily === 'monospace') font = 'mono';
  else if (
    /times|georgia|garamond|cambria|book ?antiqua|palatino|baskerville|minion|caslon|bodoni|didot|serif(?!.*sans)|roman|century|bookman|constantia|charter/.test(n) ||
    (!/sans|arial|helvet|calibri|verdana|tahoma|segoe|roboto|open|lato|inter|gothic|futura|myriad|frutiger|univers/.test(n) && (fontObj?.isSerifFont || style?.fontFamily === 'serif'))
  ) font = 'serif';
  const bold = Boolean(fontObj?.bold || fontObj?.black) || /bold|black|heavy|semibold|demi|extrabold/.test(n);
  const italic = Boolean(fontObj?.italic) || /italic|oblique/.test(n);
  return { font, bold, italic, displayName: name.replace(/[,-](Bold|Italic|Regular|BoldItalic|Oblique)$/i, '') || 'tidak diketahui' };
}

/**
 * Groups pdf.js text items into runs. Each run is one line segment of text in
 * one direction and size, with its baseline origin, width, and a cover
 * polygon (PDF user space) that hides the original glyphs.
 */
export function buildRuns(textContent, page, pageIndex) {
  const runs = [];
  let cur = null;

  const flush = () => {
    if (cur && cur.text.trim()) runs.push(finish(cur));
    cur = null;
  };

  for (const it of textContent.items) {
    if (!('str' in it)) continue;
    if (!it.str || !it.str.trim()) {
      if (it.hasEOL) flush();
      continue;
    }
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b);
    if (!size || !isFinite(size)) continue;
    const angle = Math.atan2(b, a);
    if (cur) {
      const ux = Math.cos(cur.angle), uy = Math.sin(cur.angle);
      const dx = e - cur.x, dy = f - cur.y;
      const along = dx * ux + dy * uy;
      const perp = -dx * uy + dy * ux;
      const sameLine =
        Math.abs(angle - cur.angle) < 0.01 &&
        Math.abs(size - cur.size) < 0.15 * cur.size &&
        Math.abs(perp) < 0.25 * cur.size &&
        along >= cur.width - 0.5 * cur.size &&
        along <= cur.width + 1.2 * cur.size;
      if (sameLine) {
        const gap = along - cur.width;
        if (gap > 0.18 * cur.size && !cur.text.endsWith(' ') && !it.str.startsWith(' ')) cur.text += ' ';
        cur.text += it.str;
        cur.width = Math.max(cur.width, along + it.width);
        if (it.hasEOL) flush();
        continue;
      }
      flush();
    }
    cur = { x: e, y: f, size, angle, width: it.width, text: it.str, fontName: it.fontName };
    if (it.hasEOL) flush();
  }
  flush();

  function finish(r) {
    const style = textContent.styles?.[r.fontName] || {};
    let fontObj = null;
    try {
      if (page.commonObjs.has(r.fontName)) fontObj = page.commonObjs.get(r.fontName);
    } catch (_) {}
    const cls = classifyFont(fontObj, style);
    const asc = style.ascent > 0 && style.ascent < 1.5 ? style.ascent : 0.8;
    const desc = style.descent < 0 && style.descent > -1 ? style.descent : -0.2;
    const ux = Math.cos(r.angle), uy = Math.sin(r.angle);
    const pt = (along, perp) => [r.x + ux * along - uy * perp, r.y + uy * along + ux * perp];
    // A little extra so anti-aliased glyph edges are hidden too.
    const padH = 0.06 * r.size, padV = 0.08 * r.size;
    return {
      key: `${pageIndex}:${runs.length}`,
      page: pageIndex,
      text: r.text.trim(),
      x: r.x,
      y: r.y,
      size: r.size,
      angle: (r.angle * 180) / Math.PI,
      width: r.width,
      ...cls,
      cover: [
        pt(-padH, desc * r.size - padV),
        pt(r.width + padH, desc * r.size - padV),
        pt(r.width + padH, asc * r.size + padV),
        pt(-padH, asc * r.size + padV),
      ],
    };
  }
  return runs;
}

/**
 * Samples the rendered canvas inside a view-space box: the most common colour
 * along its border is the background; the pixels furthest from that are the
 * text colour.
 */
export function sampleColors(canvas, box) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const x = Math.max(0, Math.floor(box.left));
  const y = Math.max(0, Math.floor(box.top));
  const w = Math.min(canvas.width - x, Math.ceil(box.width));
  const h = Math.min(canvas.height - y, Math.ceil(box.height));
  const fallback = { bg: '#ffffff', fg: '#000000' };
  if (w < 2 || h < 2) return fallback;
  let data;
  try {
    data = ctx.getImageData(x, y, w, h).data;
  } catch (_) {
    return fallback;
  }
  const px = (i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
  const buckets = new Map();
  const addBorder = (i) => {
    const [r, g, b] = px(i);
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    buckets.set(k, e);
  };
  for (let i = 0; i < w; i++) { addBorder(i); addBorder((h - 1) * w + i); }
  for (let j = 1; j < h - 1; j++) { addBorder(j * w); addBorder(j * w + w - 1); }
  let best = null;
  for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
  const bg = [best.r / best.n, best.g / best.n, best.b / best.n];

  let maxD = 0;
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = px(i);
    const d = Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
    dist[i] = d;
    if (d > maxD) maxD = d;
  }
  let fg = [0, 0, 0];
  if (maxD > 30) {
    let n = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < w * h; i++) {
      // Only the most saturated pixels: glyph edges are blended with the ground.
      if (dist[i] >= maxD * 0.9) {
        const p = px(i);
        r += p[0]; g += p[1]; b += p[2]; n++;
      }
    }
    fg = [r / n, g / n, b / n];
  } else {
    // No contrast found: dark text on light ground, light on dark.
    fg = bg[0] + bg[1] + bg[2] > 380 ? [0, 0, 0] : [255, 255, 255];
  }
  const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  return { bg: hex(bg), fg: hex(fg) };
}

export function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ−‐‑          \t\n');

/** Characters the standard PDF fonts cannot show (they would print as "?"). */
export function unsupportedChars(text) {
  const bad = new Set();
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const ok = (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || CP1252_EXTRA.has(ch);
    if (!ok) bad.add(ch);
  }
  return [...bad];
}
