#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Canvas, Layer, encodePng, hex, loadAtlas, missing } from './lib/raster.mjs';
import { autoRedactions, buildDisplay, decodeBody, header, parseMessage, replaced, resolve } from './lib/http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const atlas = loadAtlas(join(HERE, '..', 'assets', 'atlas.bin'));
const S = atlas.scale;
const F = atlas.faces;

const DEFAULTS = {
  request: null, response: null, requestText: null, responseText: null,
  title: '', caption: '', theme: 'light', layout: 'side', frame: 'report', notes: 'callout',
  numberMarks: true, lineNumbers: true, scheme: 'https', timeMs: null,
  marks: [], redact: [], unredact: [], autoRedact: true, redactStyle: 'blur', revealChars: 4,
  redactHeaders: ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'X-Api-Key', 'X-Auth-Token', 'X-CSRF-Token', 'X-XSRF-Token'],
  redactParams: ['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'session'],
  hideHeaders: ['Sec-Ch-Ua*', 'Sec-Fetch-*', 'Accept-Language', 'Accept-Encoding', 'Priority', 'Upgrade-Insecure-Requests'],
  showHeaders: [], prettyJson: true, maxBodyLines: 40, wrapColumns: 100, bodyOffset: {},
  watermark: 'CONFIDENTIAL', watermarkOpacity: 12,
};

const PALETTE = { red: 0xe5484d, orange: 0xf76b15, amber: 0xe2a700, green: 0x30a46c, blue: 0x0090ff, purple: 0x8e4ec6 };
const PALETTE_ORDER = Object.keys(PALETTE);

const THEMES = {
  light: {
    card: 0xffffff, headerBar: 0xfbfbfb, border: 0xdfdfdf, divider: 0xdddddd, text: 0x141414, muted: 0x787878,
    paneTitle: 0x000000, gutter: 0xffffff, gutterText: 0x787878, calloutBg: 0xffffff, backdropFrom: 0xffb090,
    backdropTo: 0xff6633, redactSolid: 0x2b2b2b, watermark: 0x4b4b4b, accent: 0xff6633,
    styles: [0x141414, 0x787878, 0x141414, 0x000075, 0x202020, 0x0000c0, 0xa01010, 0x202020, 0x000075, 0x008000,
      0x0000ff, 0x000075, 0xa120b9, 0x0000b8, 0x93231b, 0x255915],
  },
  dark: {
    card: 0x2b2b2b, headerBar: 0x323334, border: 0x525255, divider: 0x555555, text: 0xcecece, muted: 0xa0a0a0,
    paneTitle: 0xffffff, gutter: 0x2b2b2b, gutterText: 0xa0a0a0, calloutBg: 0x323334, backdropFrom: 0x2b2b2b,
    backdropTo: 0xad5b28, redactSolid: 0x6a6a6c, watermark: 0xc5c7c8, accent: 0xff6633,
    styles: [0xcecece, 0xa0a0a0, 0xd1e8f9, 0xd1e8f9, 0xbababa, 0xbbcdff, 0xa5c35b, 0xd1e8f9, 0xe9c063, 0x93c763,
      0x79c1f4, 0xff9e57, 0xe2c171, 0xbeccfb, 0xabc269, 0xa7b9ba],
  },
};

const REASONS = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large',
  415: 'Unsupported Media Type', 422: 'Unprocessable Content', 429: 'Too Many Requests', 500: 'Internal Server Error',
  501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const HEADER_H = 44, TITLE_H = 36, CARD_PAD = 16, CALLOUT_W = 340, MIN_CARD_W = 520;
const PAD_X = 12, PANE_TITLE_H = 40, PAD_TOP = 8, PAD_BOTTOM = 12, GUTTER_PAD = 8, MIN_PANE = 240;
const SHADOW = [0, 0, 0];

const cw = F.mono.width('M');
const lh = 22;
const uiLH = Math.round(F.sans.height * 1.35);

const rect = (x, y, w, h) => ({ x, y, w, h });
const union = (a, b) => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return rect(x, y, Math.max(a.x + a.w, b.x + b.w) - x, Math.max(a.y + a.h, b.y + b.h) - y);
};
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const contains = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
const closest = (r, p) => ({ x: Math.max(r.x, Math.min(p.x, r.x + r.w)), y: Math.max(r.y, Math.min(p.y, r.y + r.h)) });
const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

function fail(message) {
  console.error(`render: ${message}`);
  process.exit(1);
}

function ellipsize(face, s, max) {
  if (face.width(s) <= max) return s;
  let out = s;
  while (out && face.width(out + '…') > max) out = out.slice(0, -1);
  return out + '…';
}

function wrap(face, text, max) {
  const lines = [];
  for (const paragraph of text.trim().split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (face.width(candidate) <= max || !line) line = candidate;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function layoutRows(d, wrapColumns, maxBodyLines, offset) {
  const t = d.text, n = t.length, bs = d.bodyStart, wrapAt = Math.max(20, wrapColumns);
  const limit = maxBodyLines > 0 ? Math.min(maxBodyLines, 100) : 100;
  const skip = Math.max(0, Math.min(offset, bodyRow(d, wrapAt, n) - limit));
  const rows = [];
  let bodyRows = 0, bodyLines = 0, overflow = 0, lineStart = 0, number = 0;
  while (lineStart < n) {
    let nl = t.indexOf('\n', lineStart);
    if (nl < 0) nl = n;
    const trailingEmpty = nl === lineStart && nl === n - 1 && lineStart >= bs;
    if (!trailingEmpty) {
      number++;
      let chunk = lineStart;
      do {
        const chunkEnd = Math.min(nl, chunk + wrapAt);
        const inBody = chunk >= bs && lineStart >= bs;
        if (inBody && bodyRows++ < skip) {
          if (bodyRows === skip) rows.push({ start: chunkEnd, end: chunkEnd, synthetic: `… ${skip} line${skip === 1 ? '' : 's'} above`, number: 0 });
        } else if (inBody && bodyLines >= limit) overflow++;
        else {
          rows.push({ start: chunk, end: chunkEnd, synthetic: null, number: chunk === lineStart ? number : 0 });
          if (inBody) bodyLines++;
        }
        chunk = chunkEnd;
      } while (chunk < nl);
    }
    lineStart = nl + 1;
  }
  if (overflow > 0) rows.push({ start: n, end: n, synthetic: `… ${overflow} more line${overflow === 1 ? '' : 's'}`, number: 0 });
  return rows;
}

function bodyRow(d, wrapAt, index) {
  const t = d.text, n = t.length;
  let rows = 0, lineStart = d.bodyStart;
  while (lineStart < n) {
    let nl = t.indexOf('\n', lineStart);
    if (nl < 0) nl = n;
    if (nl === lineStart && nl === n - 1) break;
    let chunk = lineStart;
    do {
      const chunkEnd = Math.min(nl, chunk + wrapAt);
      if (index < chunkEnd || (index === chunkEnd && chunkEnd === nl)) return rows;
      rows++;
      chunk = chunkEnd;
    } while (chunk < nl);
    lineStart = nl + 1;
  }
  return rows;
}

function loadMessage(cfg, kind, base) {
  if (cfg[`${kind}Text`] != null) return Buffer.from(cfg[`${kind}Text`], 'utf8');
  if (cfg[kind] == null) return null;
  try { return readFileSync(resolvePath(base, cfg[kind])); } catch (e) { fail(`cannot read ${kind} file ${cfg[kind]}: ${e.message}`); }
}

function makePane(index, kind, buf, cfg) {
  const msg = parseMessage(buf);
  decodeBody(msg);
  const d = buildDisplay(msg, kind, cfg);
  const hidden = new Uint8Array(d.text.length);
  const redactions = [];
  const hide = (r, reveal, why) => {
    const covered = [];
    for (let i = r.start; i < r.end; i++) if (d.text[i] !== '\n') covered.push(i);
    const keep = reveal > 0 && covered.length >= reveal * 3 ? reveal : 0;
    for (let k = 0; k < covered.length - keep; k++) hidden[covered[k]] = 1;
    redactions.push(keep ? `${why} (kept last ${keep})` : why);
  };
  const mine = (list) => list.filter((s) => s.pane === kind);
  const keepVisible = mine(cfg.unredact).map((s) => resolve(d, s, 'value'));
  if (cfg.autoRedact) {
    for (const r of autoRedactions(d, cfg)) {
      if (!keepVisible.some((s) => s.start < r.end && r.start < s.end)) hide(r, cfg.revealChars, r.why);
    }
  }
  for (const sel of mine(cfg.redact)) hide(resolve(d, sel, 'value'), 0, 'manual ' + JSON.stringify(sel));
  return { index, kind, msg, d, hidden, redactions };
}

function headerInfo(cfg, req, res) {
  const parts = req.msg.first.split(/\s+/);
  const method = parts[0] ?? '', target = parts[1] ?? '';
  const host = header(req.msg, 'Host') || header(req.msg, ':authority');
  const url = /^https?:\/\//i.test(target) ? target : host ? `${cfg.scheme}://${host}${target}` : target;
  let status = 0, reason = '';
  const m = res?.msg.first.match(/^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/i);
  if (m) { status = Number(m[1]); reason = m[2].trim() || REASONS[status] || ''; }
  return { method, url, host, status, reason, timeMs: cfg.timeMs };
}

function statusColor(status) {
  if (status >= 500) return hex(0xe5484d);
  if (status >= 400) return hex(0xf76b15);
  if (status >= 300) return hex(0x0090ff);
  if (status >= 200) return hex(0x30a46c);
  return hex(0x8b949e);
}

function markColor(m, i) {
  const c = m.color ?? PALETTE_ORDER[i % PALETTE_ORDER.length];
  if (PALETTE[c] != null) return hex(PALETTE[c]);
  if (/^#?[0-9a-f]{6}$/i.test(c)) return hex(parseInt(c.replace('#', ''), 16));
  fail(`unknown mark colour "${c}"; use ${PALETTE_ORDER.join(', ')} or #rrggbb`);
}

function render(cfg, panes) {
  const theme = Object.fromEntries(Object.entries(THEMES[cfg.theme]).map(([k, v]) => [k, Array.isArray(v) ? v.map(hex) : hex(v)]));
  const head = headerInfo(cfg, panes[0], panes[1]);
  const side = cfg.layout === 'side';
  const showcase = cfg.frame === 'showcase';

  const marks = cfg.marks.map((m, i) => {
    const p = panes.find((x) => x.kind === m.pane);
    if (!p) fail(`mark ${i + 1} needs "pane": "request" or "response"${m.pane ? ` (there is no ${m.pane})` : ''}`);
    return { ...m, p, range: resolve(p.d, m, 'all'), color: markColor(m, i), hasNote: !!(m.note && m.note.trim()) };
  });

  for (const p of panes) {
    let offset = cfg.bodyOffset[p.kind];
    if (offset == null) {
      offset = 0;
      const first = marks.find((m) => m.p === p && m.range.start >= p.d.bodyStart);
      const limit = cfg.maxBodyLines > 0 ? Math.min(cfg.maxBodyLines, 100) : 100;
      if (first) {
        const row = bodyRow(p.d, Math.max(20, cfg.wrapColumns), first.range.start);
        offset = row < limit ? 0 : row - Math.floor(limit / 2);
      }
    }
    p.rows = layoutRows(p.d, cfg.wrapColumns, cfg.maxBodyLines, offset);
    p.rowAt = new Int32Array(p.d.text.length).fill(-1);
    p.rows.forEach((r, k) => { if (!r.synthetic) for (let i = r.start; i < r.end; i++) p.rowAt[i] = k; });
    p.columns = Math.max(0, ...p.rows.map((r) => (r.synthetic ? r.synthetic.length : r.end - r.start)));
    const last = Math.max(1, ...p.rows.map((r) => r.number));
    p.gw = cfg.lineNumbers ? String(last).length * cw + 2 * GUTTER_PAD : 0;
    p.naturalW = Math.max(MIN_PANE, p.gw + p.columns * cw + 2 * PAD_X);
    p.naturalH = PANE_TITLE_H + PAD_TOP + p.rows.length * lh + PAD_BOTTOM;
  }

  const natural = side ? panes.reduce((s, p) => s + p.naturalW, 0) : Math.max(...panes.map((p) => p.naturalW));
  const contentW = Math.max(natural, MIN_CARD_W), extra = contentW - natural;
  const tallest = Math.max(...panes.map((p) => p.naturalH));
  let px = 0, py = 0;
  for (const p of panes) {
    p.x = side ? px : 0;
    p.y = side ? 0 : py;
    p.w = side ? p.naturalW + extra / panes.length : contentW;
    p.h = side ? tallest : p.naturalH;
    px += p.w;
    py += p.h;
  }
  const contentH = side ? tallest : py;

  const titleH = cfg.title.trim() ? TITLE_H : 0;
  const headerH = HEADER_H;
  const legend = cfg.notes === 'legend' ? marks.filter((m) => m.hasNote) : [];
  const legendLines = legend.map((m) => wrap(F.sans, m.note, contentW - 2 * CARD_PAD - 32));
  const legendH = legend.length ? 2 * CARD_PAD - 6 + legendLines.reduce((s, l) => s + Math.max(22, l.length * uiLH) + 6, 0) : 0;
  const captionLines = cfg.caption.trim() ? wrap(F.sans, cfg.caption, contentW - 2 * CARD_PAD) : [];
  const captionH = captionLines.length ? 2 * CARD_PAD - 4 + captionLines.length * uiLH : 0;
  const margin = showcase ? 56 : 0;
  const card = rect(margin, margin, contentW, titleH + headerH + contentH + legendH + captionH);
  const area = rect(card.x, card.y + titleH + headerH, contentW, contentH);
  for (const p of panes) {
    p.sx = area.x + p.x;
    p.sy = area.y + p.y;
    p.textX = p.sx + p.gw + PAD_X;
    p.textY = p.sy + PANE_TITLE_H + PAD_TOP;
  }

  const warnings = [];
  for (const [i, m] of marks.entries()) {
    const byRow = new Map();
    for (let k = m.range.start; k < m.range.end; k++) {
      const row = m.p.rowAt[k];
      if (row < 0 || m.p.d.text[k] === '\n') continue;
      const cell = rect(m.p.textX + (k - m.p.rows[row].start) * cw, m.p.textY + row * lh, cw, lh);
      byRow.set(row, byRow.has(row) ? union(byRow.get(row), cell) : cell);
    }
    const pad = (r) => rect(r.x - 3, r.y - 1, r.w + 6, r.h + 2);
    const segments = [...byRow.values()].map(pad);
    m.box = segments.length ? segments.reduce(union) : null;
    m.outline = segments.length > 1 ? segments : m.box ? [m.box] : [];
    if (!m.box) warnings.push(`mark ${i + 1} is outside the visible lines; raise maxBodyLines or set bodyOffset`);
  }

  let n = 0;
  for (const m of marks) m.number = m.hasNote && m.box ? ++n : 0;
  const numbered = (m) => m.number > 0 && (cfg.numberMarks || cfg.notes === 'legend');

  const ink = (a) => {
    let count = 0;
    for (const p of panes) {
      if (a.x + a.w < p.sx || a.x > p.sx + p.w) continue;
      p.rows.forEach((r, row) => {
        if (!r.number) return;
        const label = String(r.number).length * cw;
        const box = rect(p.sx + p.gw - GUTTER_PAD - label, p.textY + row * lh, label, lh);
        if (p.gw && intersects(a, box)) count += 40;
      });
      const firstRow = Math.max(0, Math.floor((a.y - p.textY) / lh));
      const lastRow = Math.min(p.rows.length - 1, Math.floor((a.y + a.h - p.textY) / lh));
      const firstCol = Math.floor((a.x - p.textX) / cw);
      const lastCol = Math.ceil((Math.min(a.x + a.w, p.sx + p.w) - p.textX) / cw);
      for (let row = firstRow; row <= lastRow; row++) {
        const r = p.rows[row], len = r.synthetic ? r.synthetic.length : r.end - r.start;
        for (let col = Math.max(0, firstCol); col < Math.min(len, lastCol); col++) {
          if (r.synthetic || !/\s/.test(p.d.text[r.start + col])) count++;
        }
      }
    }
    return count;
  };

  const callouts = [];
  const penalty = (c) => {
    let score = 0;
    if (!contains(card, c)) score += intersects(card, c) ? 100000 : 400;
    if (intersects(c, rect(card.x, area.y + area.h, card.w, legendH + captionH))) score += 20000;
    for (const m of marks) if (m.box && intersects(m.box, c)) score += 10000;
    for (const placed of callouts) if (placed && intersects(placed, rect(c.x - 8, c.y - 8, c.w + 16, c.h + 16))) score += 50000;
    return score + ink(rect(c.x - 6, c.y - 6, c.w + 12, c.h + 12)) * 25;
  };
  let bounds = { ...card };
  for (const m of marks) {
    m.lines = m.box && m.hasNote && cfg.notes === 'callout' ? wrap(F.sans, m.note, CALLOUT_W - 44) : [];
    let callout = null;
    if (m.lines.length) {
      const w = 44 + Math.max(...m.lines.map((l) => F.sans.width(l)));
      const h = 16 + m.lines.length * uiLH;
      const xs = [m.box.x + m.box.w + 28, m.box.x + 24, m.box.x - w - 28, card.x + card.w + 24];
      let best = Infinity;
      xs.forEach((x, xi) => {
        for (let k = -14; k <= 14; k++) {
          const c = rect(x, m.box.y + m.box.h / 2 - h / 2 + k * 12, w, h);
          const score = xi * 40 + Math.abs(k) * 4 + penalty(c);
          if (score < best) { best = score; callout = c; }
        }
      });
      bounds = union(bounds, rect(callout.x - 12, callout.y - 12, w + 24, h + 24));
    }
    m.callout = callout;
    callouts.push(callout);
  }
  bounds = union(bounds, rect(card.x - margin, card.y - margin, card.w + 2 * margin, card.h + 2 * margin));

  const g = new Canvas(bounds.x, bounds.y, bounds.w, bounds.h, S);

  if (showcase) {
    g.fillGradient(bounds.x, bounds.y, bounds.w, bounds.h, theme.backdropFrom, theme.backdropTo);
    for (let i = 1; i <= 12; i++) {
      g.fillRoundRect(card.x - i + 2, card.y - i + 10, card.w + 2 * i - 4, card.h + 2 * i - 4, (12 + 2 * i) / 2, SHADOW, 6 / 255);
    }
  } else g.fillRect(bounds.x, bounds.y, bounds.w, bounds.h, theme.card);

  const radius = showcase ? 12 : 6;
  g.fillRoundRect(card.x, card.y, card.w, card.h, radius, theme.card);
  g.setClipRoundRect(card.x, card.y, card.w, card.h, radius);
  let y = card.y;
  if (titleH) {
    g.fillRect(card.x, y, card.w, titleH, theme.headerBar);
    g.text(F.title, ellipsize(F.title, cfg.title, card.w - 2 * CARD_PAD), card.x + CARD_PAD, y + titleH / 2 + F.title.ascent / 2 - 1, theme.text);
    y += titleH;
  }
  paintHeaderBar(g, theme, head, card, y, showcase, cfg);
  y += headerH;
  g.line(card.x, y - 0.5, card.x + card.w, y - 0.5, 1, theme.border);
  for (const p of panes) paintPane(g, theme, p, side, cfg);
  if (legendH) {
    const top = area.y + area.h;
    g.fillRect(card.x, top, card.w, legendH, theme.headerBar);
    g.line(card.x, top + 0.5, card.x + card.w, top + 0.5, 1, theme.border);
    let ly = top + CARD_PAD - 3;
    legend.forEach((m, k) => {
      badge(g, theme, card.x + CARD_PAD + 10, ly + 11, m.number, m.color);
      let ty = ly + 11 + F.sans.ascent / 2 - 1;
      for (const line of legendLines[k]) { g.text(F.sans, line, card.x + CARD_PAD + 30, ty, theme.text); ty += uiLH; }
      ly += Math.max(22, legendLines[k].length * uiLH) + 6;
    });
  }
  if (captionH) {
    const top = area.y + area.h + legendH;
    g.fillRect(card.x, top, card.w, captionH, theme.headerBar);
    g.line(card.x, top + 0.5, card.x + card.w, top + 0.5, 1, theme.border);
    let ty = top + CARD_PAD - 2 + F.sans.ascent;
    for (const line of captionLines) { g.text(F.sans, line, card.x + CARD_PAD, ty, theme.text); ty += uiLH; }
  }
  g.clearClip();
  g.strokeRoundRect(card.x + 0.5, card.y + 0.5, card.w - 1, card.h - 1, radius, 1, theme.border);

  for (const m of marks) {
    if (!m.box) continue;
    for (const part of m.outline) g.strokeRoundRect(part.x, part.y, part.w, part.h, 3, 2, m.color);
    if (m.callout) paintCallout(g, theme, m, numbered(m));
  }
  for (const m of marks) {
    if (numbered(m)) badge(g, theme, m.outline[0].x - 3, m.outline[0].y - 3, m.number, m.color);
  }

  if (cfg.watermark) paintWatermark(g, theme, bounds, String(cfg.watermark).replace('{host}', head.host).replace('{date}', new Date().toISOString().slice(0, 10)), cfg.watermarkOpacity / 100);
  return { canvas: g, warnings, marks };
}

function pill(g, text, x, mid, color) {
  const w = F.sansBold.width(text) + 16;
  g.fillRoundRect(x, mid - 11, w, 22, 11, color, 36 / 255);
  g.text(F.sansBold, text, x + 8, mid + F.sansBold.ascent / 2 - 1, color);
  return w;
}

function paintHeaderBar(g, theme, head, card, top, showcase, cfg) {
  g.fillRect(card.x, top, card.w, HEADER_H, theme.headerBar);
  const mid = top + HEADER_H / 2;
  let x = card.x + CARD_PAD;
  if (showcase) {
    for (const dot of [0xff5f57, 0xfebc2e, 0x28c840]) { g.fillCircle(x + 6, mid, 6, hex(dot)); x += 20; }
    x += 8;
  }
  let right = card.x + card.w - CARD_PAD;
  if (head.timeMs != null) {
    const time = `${head.timeMs} ms`;
    right -= F.sans.width(time);
    g.text(F.sans, time, right, mid + F.sans.ascent / 2 - 1, theme.muted);
    right -= 12;
  }
  if (head.status > 0) {
    const status = `${head.status} ${head.reason}`.trim();
    right -= F.sansBold.width(status) + 16;
    pill(g, status, right, mid, statusColor(head.status));
    right -= 12;
  }
  if (head.method) x += pill(g, head.method, x, mid, theme.accent) + 10;
  g.text(F.mono, ellipsize(F.mono, head.url, right - x), x, mid + F.mono.ascent / 2 - 1, theme.text);
}

function paintPane(g, theme, p, side, cfg) {
  if (p.index > 0) {
    if (side) g.line(p.sx, p.sy, p.sx, p.sy + p.h, 1, theme.divider);
    else g.line(p.sx, p.sy, p.sx + p.w, p.sy, 1, theme.divider);
  }
  g.text(F.title, p.kind === 'request' ? 'Request' : 'Response', p.sx + PAD_X + 4, p.sy + PANE_TITLE_H / 2 + F.title.ascent / 2, theme.paneTitle);
  g.line(p.sx, p.sy + PANE_TITLE_H - 0.5, p.sx + p.w, p.sy + PANE_TITLE_H - 0.5, 1, theme.divider);
  const baseline = (row) => p.textY + row * lh + (lh - F.mono.height) / 2 + F.mono.ascent;
  if (p.gw) {
    g.fillRect(p.sx, p.sy + PANE_TITLE_H, p.gw, p.h - PANE_TITLE_H, theme.gutter);
    g.line(p.sx + p.gw - 0.5, p.sy + PANE_TITLE_H, p.sx + p.gw - 0.5, p.sy + p.h, 1, theme.divider);
    p.rows.forEach((r, row) => {
      if (!r.number) return;
      const label = String(r.number);
      g.text(F.mono, label, p.sx + p.gw - GUTTER_PAD - label.length * cw, baseline(row), theme.gutterText);
    });
  }
  const { text, styles } = p.d;
  p.rows.forEach((r, row) => {
    if (r.synthetic) return g.text(F.monoItalic, r.synthetic, p.textX, baseline(row), theme.muted);
    for (let i = r.start; i < r.end;) {
      let j = i + 1;
      while (j < r.end && styles[j] === styles[i] && p.hidden[j] === p.hidden[i]) j++;
      if (!p.hidden[i]) g.text(F.mono, text.slice(i, j), p.textX + (i - r.start) * cw, baseline(row), theme.styles[styles[i]]);
      i = j;
    }
  });
  const random = mulberry32(p.index * 1000003 + 7);
  const decoy = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  p.rows.forEach((r, row) => {
    for (let i = r.start; i < r.end;) {
      if (!p.hidden[i]) { i++; continue; }
      let j = i;
      while (j < r.end && p.hidden[j] && styles[j] === styles[i]) j++;
      const color = theme.styles[styles[i]];
      const box = rect(p.textX + (i - r.start) * cw, p.textY + row * lh, (j - i) * cw, lh);
      if (cfg.redactStyle === 'solid') g.fillRoundRect(box.x - 1, box.y + 2, box.w + 2, box.h - 4, 3, theme.redactSolid);
      else {
        g.fillRoundRect(box.x - 1, box.y + 2, box.w + 2, box.h - 4, 3, color, 22 / 255);
        let fake = '';
        for (let k = i; k < j; k++) fake += decoy[Math.floor(random() * decoy.length)];
        const layer = new Layer((box.w + 12) * S, (box.h + 12) * S);
        layer.text(F.mono, fake, 6 * S, (6 + (lh - F.mono.height) / 2 + F.mono.ascent) * S);
        const radius = Math.round(3 * S);
        layer.boxBlur(radius);
        layer.boxBlur(radius);
        g.composite(layer, Math.round(g.dx(box.x - 6)), Math.round(g.dy(box.y - 6)), color);
      }
      i = j;
    }
  });
}

function badge(g, theme, cx, cy, number, color) {
  const s = String(number), d = Math.max(16, F.badge.width(s) + 8);
  g.fillRoundRect(cx - d / 2 - 1.5, cy - 9.5, d + 3, 19, 9.5, theme.card);
  g.fillRoundRect(cx - d / 2, cy - 8, d, 16, 8, color);
  g.text(F.badge, s, cx - F.badge.width(s) / 2, cy + F.badge.ascent / 2 - 1, [255, 255, 255]);
}

function paintCallout(g, theme, m, isNumbered) {
  const c = m.callout, mid = center(c);
  let target = closest(m.box, mid), nearest = Infinity;
  for (const part of m.outline) {
    const p = closest(part, mid), dist = Math.hypot(p.x - mid.x, p.y - mid.y);
    if (dist < nearest) { nearest = dist; target = p; }
  }
  const source = closest(c, target);
  if (!intersects(m.box, c)) {
    g.line(source.x, source.y, target.x, target.y, 1.5, m.color);
    g.fillCircle(target.x, target.y, 3, m.color);
  }
  g.fillRoundRect(c.x + 1, c.y + 3, c.w, c.h, 6, SHADOW, 60 / 255);
  g.fillRoundRect(c.x, c.y, c.w, c.h, 6, theme.calloutBg);
  g.strokeRoundRect(c.x, c.y, c.w, c.h, 6, 1.5, m.color);
  g.fillRoundRect(c.x, c.y, 6, c.h, 3, m.color);
  let textX = c.x + 16;
  if (isNumbered) {
    badge(g, theme, c.x + 22, c.y + 8 + uiLH / 2, m.number, m.color);
    textX = c.x + 38;
  }
  let ty = c.y + 8 + F.sans.ascent + (uiLH - F.sans.height) / 2;
  for (const line of m.lines) { g.text(F.sans, line, textX, ty, theme.text); ty += uiLH; }
}

function paintWatermark(g, theme, bounds, text, alpha) {
  if (!text.trim()) return;
  const face = F.watermark, angle = (-25 * Math.PI) / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const tileW = face.width(text), tileH = face.height;
  const layer = new Layer(tileW * S + 4, tileH * S + 4);
  layer.text(face, text, 2, 2 + face.ascent * S);
  const stepX = tileW + 20 * 5, stepY = tileH * 5;
  const cx = bounds.x + bounds.w / 2, cy = bounds.y + bounds.h / 2, reach = Math.hypot(bounds.w, bounds.h);
  let row = 0;
  for (let ty = cy - reach; ty < cy + reach; ty += stepY, row++) {
    const offset = (row % 2) * stepX / 2;
    for (let tx = cx - reach - offset; tx < cx + reach; tx += stepX) {
      const dx = tx + tileW / 2 - cx, dy = ty + tileH / 2 - cy;
      const x = cx + dx * cos - dy * sin, y = cy + dx * sin + dy * cos;
      if (x < bounds.x - tileW || x > bounds.x + bounds.w + tileW || y < bounds.y - tileW || y > bounds.y + bounds.h + tileW) continue;
      g.compositeRotated(layer, g.dx(x), g.dy(y), angle, theme.watermark, alpha);
    }
  }
}

function visibleText(p) {
  const out = [];
  for (const r of p.rows) {
    if (r.synthetic) { out.push(`     ${r.synthetic}`); continue; }
    let line = '';
    for (let i = r.start; i < r.end; i++) {
      if (!p.hidden[i]) line += p.d.text[i];
      else if (i === r.start || !p.hidden[i - 1]) line += '‹redacted›';
    }
    out.push(`${r.number ? String(r.number).padStart(4) : '    '} ${line}`);
  }
  return out.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files[0] || args.includes('--help')) {
    console.error('usage: node render.mjs spec.json [out.png] [--text]');
    process.exit(files[0] ? 0 : 1);
  }
  const specPath = resolvePath(files[0]);
  let spec;
  try { spec = JSON.parse(readFileSync(specPath, 'utf8')); } catch (e) { fail(`cannot read spec ${files[0]}: ${e.message}`); }
  const unknown = Object.keys(spec).filter((k) => !(k in DEFAULTS));
  if (unknown.length) fail(`unknown spec field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  const cfg = { ...DEFAULTS, ...spec };
  const choices = { theme: ['light', 'dark'], layout: ['side', 'stacked'], frame: ['report', 'showcase'], notes: ['callout', 'legend'], redactStyle: ['blur', 'solid'] };
  for (const [k, ok] of Object.entries(choices)) if (!ok.includes(cfg[k])) fail(`${k} must be one of ${ok.join(', ')}`);

  const base = dirname(specPath);
  const reqBuf = loadMessage(cfg, 'request', base);
  if (!reqBuf) fail('the spec needs "request" (a file path) or "requestText"');
  const resBuf = loadMessage(cfg, 'response', base);
  let panes, result;
  try {
    panes = [makePane(0, 'request', reqBuf, cfg)];
    if (resBuf) panes.push(makePane(1, 'response', resBuf, cfg));
    result = render(cfg, panes);
  } catch (e) {
    fail(e.message);
  }
  const out = files[1] ? resolvePath(files[1]) : specPath.replace(/\.json$/i, '') + '.png';
  writeFileSync(out, encodePng(result.canvas));

  console.log(`wrote ${out} (${result.canvas.W}×${result.canvas.H})`);
  for (const p of panes) {
    if (p.msg.decoded.length) console.log(`${p.kind}: decoded body (${p.msg.decoded.join(', ')}); headers shown as sent`);
    if (p.d.notes.length) console.log(`${p.kind}: ${p.d.notes.join(', ')}`);
    console.log(`${p.kind}: ${p.redactions.length ? 'redacted ' + p.redactions.join('; ') : 'nothing redacted'}`);
  }
  result.marks.forEach((m, i) => {
    const row = m.p.rowAt[m.range.start];
    const where = row >= 0 ? `line ${m.p.rows.slice(0, row + 1).reverse().find((r) => r.number)?.number}` : 'not visible';
    console.log(`mark ${i + 1}: ${m.pane} ${where}: ${JSON.stringify(m.p.d.text.slice(m.range.start, m.range.end).slice(0, 60))}`);
  });
  for (const w of result.warnings) console.log(`warning: ${w}`);
  if (replaced.size) console.log(`warning: ${[...replaced].map((c) => JSON.stringify(c)).join(' ')} cannot be drawn; shown as "?"`);
  if (missing.size) console.log(`warning: no glyph for ${[...missing].map((c) => JSON.stringify(c)).join(' ')}; drawn as "?"`);
  if (args.includes('--text')) for (const p of panes) console.log(`\n${p.kind === 'request' ? 'Request' : 'Response'}\n${visibleText(p)}`);
}

main();
