import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';

export const ST = {
  PLAIN: 0, MUTED: 1, FIRST: 2, HNAME: 3, HVALUE: 4, PNAME: 5, PVALUE: 6, PUNCT: 7,
  KEY: 8, STRING: 9, NUMBER: 10, LITERAL: 11, TAG: 12, ATTR: 13, ATTRV: 14, COMMENT: 15,
};

export function parseMessage(buf) {
  let at = buf.indexOf('\r\n\r\n'), sep = 4;
  const lf = buf.indexOf('\n\n');
  if (at < 0 || (lf >= 0 && lf < at)) { at = lf; sep = 2; }
  const head = (at < 0 ? buf : buf.subarray(0, at)).toString('utf8');
  const body = at < 0 ? Buffer.alloc(0) : buf.subarray(at + sep);
  const lines = head.split(/\r?\n/);
  const headers = [];
  for (const raw of lines.slice(1)) {
    if (!raw) continue;
    const c = raw.indexOf(':');
    headers.push({ name: c > 0 ? raw.slice(0, c).trim() : '', value: c > 0 ? raw.slice(c + 1).trim() : raw, raw });
  }
  return { first: lines[0] ?? '', headers, body, decoded: [] };
}

export function header(msg, name) {
  const h = msg.headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function dechunk(b) {
  const out = [];
  let p = 0;
  for (;;) {
    const e = b.indexOf('\r\n', p);
    if (e < 0) throw new Error('bad chunk');
    const n = parseInt(b.subarray(p, e).toString('latin1').split(';')[0].trim(), 16);
    if (Number.isNaN(n)) throw new Error('bad chunk size');
    p = e + 2;
    if (n === 0) return Buffer.concat(out);
    if (p + n > b.length) throw new Error('short chunk');
    out.push(b.subarray(p, p + n));
    p += n + 2;
  }
}

export function decodeBody(msg) {
  if (/chunked/i.test(header(msg, 'Transfer-Encoding'))) {
    try { msg.body = dechunk(msg.body); msg.decoded.push('chunked'); } catch {}
  }
  const enc = header(msg, 'Content-Encoding').toLowerCase().trim();
  const fns = { gzip: gunzipSync, 'x-gzip': gunzipSync, br: brotliDecompressSync, deflate: (b) => { try { return inflateSync(b); } catch { return inflateRawSync(b); } } };
  if (fns[enc] && msg.body.length) {
    try { msg.body = fns[enc](msg.body); msg.decoded.push(enc); } catch {}
  }
}

function isBinary(b) {
  const n = Math.min(b.length, 4096);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) bad++;
  }
  return n > 0 && bad / n > 0.02;
}

export const replaced = new Set();

function sanitize(s) {
  return s.replace(/\t/g, '    ').replace(/[\u0000-\u0009\u000b-\u001f\u007f]|[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g, (c) => {
    replaced.add(c);
    return '?';
  });
}

class Builder {
  constructor() { this.s = ''; this.st = []; this.tokens = []; this.scalars = []; }
  get pos() { return this.s.length; }
  add(str, style) {
    str = sanitize(str);
    this.s += str;
    for (let i = 0; i < str.length; i++) this.st.push(str[i] === '\n' ? ST.PLAIN : style);
  }
}

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

function addParams(b, s, kind) {
  s.split('&').forEach((p, i) => {
    if (i) b.add('&', ST.PUNCT);
    const start = b.pos, eq = p.indexOf('=');
    if (eq < 0) {
      b.add(p, ST.PNAME);
      b.tokens.push({ kind, name: safeDecode(p), start, end: b.pos, valueStart: b.pos, valueEnd: b.pos });
      return;
    }
    b.add(p.slice(0, eq), ST.PNAME);
    b.add('=', ST.PUNCT);
    const vs = b.pos;
    b.add(p.slice(eq + 1), ST.PVALUE);
    b.tokens.push({ kind, name: safeDecode(p.slice(0, eq)), start, end: b.pos, valueStart: vs, valueEnd: b.pos });
  });
}

function addRequestLine(b, line) {
  const m = line.match(/^(\S+)(\s+)(\S+)(?:(\s+)(.*))?$/);
  if (!m) return b.add(line, ST.FIRST);
  b.add(m[1], ST.FIRST);
  b.add(m[2], ST.PLAIN);
  const q = m[3].indexOf('?');
  if (q < 0) b.add(m[3], ST.FIRST);
  else {
    b.add(m[3].slice(0, q), ST.FIRST);
    b.add('?', ST.PUNCT);
    addParams(b, m[3].slice(q + 1), 'param');
  }
  if (m[4]) { b.add(m[4], ST.PLAIN); b.add(m[5], ST.FIRST); }
}

function addCookies(b, v, isSet) {
  v.split(';').forEach((p, i) => {
    if (i) b.add(';', isSet ? ST.HVALUE : ST.PUNCT);
    if (isSet && i > 0) return b.add(p, ST.HVALUE);
    const lead = p.match(/^\s*/)[0], rest = p.slice(lead.length), eq = rest.indexOf('=');
    b.add(lead, ST.HVALUE);
    const start = b.pos;
    if (eq < 0) {
      b.add(rest, ST.PNAME);
      b.tokens.push({ kind: 'cookie', name: rest.trim(), start, end: b.pos, valueStart: b.pos, valueEnd: b.pos });
      return;
    }
    b.add(rest.slice(0, eq), ST.PNAME);
    b.add('=', ST.PUNCT);
    const vs = b.pos;
    b.add(rest.slice(eq + 1), ST.PVALUE);
    b.tokens.push({ kind: 'cookie', name: rest.slice(0, eq).trim(), start, end: b.pos, valueStart: vs, valueEnd: b.pos });
  });
}

function addHeader(b, h) {
  const start = b.pos, c = h.raw.indexOf(':');
  if (c <= 0) return b.add(h.raw, ST.HVALUE);
  b.add(h.raw.slice(0, c), ST.HNAME);
  b.add(':', ST.PUNCT);
  const rest = h.raw.slice(c + 1), lead = rest.match(/^\s*/)[0], value = rest.slice(lead.length);
  b.add(lead, ST.HVALUE);
  const vs = b.pos, lower = h.name.toLowerCase();
  if (lower === 'cookie' || lower === 'set-cookie') addCookies(b, value, lower === 'set-cookie');
  else b.add(value, ST.HVALUE);
  b.tokens.push({ kind: 'header', name: h.name, start, end: b.pos, valueStart: vs, valueEnd: b.pos });
}

function lexJson(src) {
  const re = /\s*(?:("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\]:,]))/y;
  const out = [];
  let m;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    out.push(m[1] ? { t: 'str', v: m[1] } : m[2] ? { t: 'num', v: m[2] } : m[3] ? { t: 'lit', v: m[3] } : { t: 'p', v: m[4] });
  }
  return out;
}

function addJson(b, src) {
  const toks = lexJson(src);
  let i = 0;
  const value = (depth) => {
    const t = toks[i++], start = b.pos;
    if (t.v === '{' || t.v === '[') {
      const obj = t.v === '{', close = obj ? '}' : ']';
      b.add(t.v, ST.PUNCT);
      if (toks[i].v === close) { i++; b.add(close, ST.PUNCT); return { start, end: b.pos }; }
      b.add('\n', ST.PLAIN);
      for (;;) {
        b.add('  '.repeat(depth + 1), ST.PLAIN);
        if (obj) {
          const k = toks[i++], ks = b.pos;
          b.add(k.v, ST.KEY);
          i++;
          b.add(':', ST.PUNCT);
          b.add(' ', ST.PLAIN);
          const v = value(depth + 1);
          b.tokens.push({ kind: 'json', name: JSON.parse(k.v), start: ks, end: b.pos, valueStart: v.start, valueEnd: v.end, scalar: v.scalar });
        } else value(depth + 1);
        const sep = toks[i++];
        if (sep.v === ',') { b.add(',', ST.PUNCT); b.add('\n', ST.PLAIN); continue; }
        b.add('\n' + '  '.repeat(depth), ST.PLAIN);
        b.add(close, ST.PUNCT);
        return { start, end: b.pos };
      }
    }
    b.add(t.v, t.t === 'str' ? ST.STRING : t.t === 'num' ? ST.NUMBER : ST.LITERAL);
    b.scalars.push({ start, end: b.pos, str: t.t === 'str' });
    return { start, end: b.pos, scalar: t.t };
  };
  value(0);
}

function addMarkup(b, s) {
  const re = /<!--[\s\S]*?-->|<\/?[A-Za-z!?][^>]*>/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    b.add(s.slice(last, m.index), ST.PLAIN);
    const tag = m[0];
    if (tag.startsWith('<!--')) b.add(tag, ST.COMMENT);
    else {
      const t = tag.match(/^(<\/?[!?]?[^\s>/]*)([\s\S]*?)(\/?\??>)$/);
      if (!t) b.add(tag, ST.TAG);
      else {
        b.add(t[1], ST.TAG);
        const attr = /(\s+)([^\s=]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"']+))?/gy;
        let a, end = 0;
        while ((a = attr.exec(t[2]))) {
          b.add(a[1], ST.PLAIN);
          b.add(a[2], ST.ATTR);
          if (a[3]) { b.add(a[3], ST.PUNCT); b.add(a[4], ST.ATTRV); }
          end = attr.lastIndex;
        }
        b.add(t[2].slice(end), ST.PLAIN);
        b.add(t[3], ST.TAG);
      }
    }
    last = re.lastIndex;
  }
  b.add(s.slice(last), ST.PLAIN);
}

function globs(list) {
  return list.map((g) => new RegExp('^' + g.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'));
}

export function buildDisplay(msg, kind, cfg) {
  const b = new Builder();
  const hide = globs(cfg.hideHeaders), show = globs(cfg.showHeaders);
  if (kind === 'request') addRequestLine(b, msg.first);
  else b.add(msg.first, ST.FIRST);
  const notes = [];
  for (const h of msg.headers) {
    if (hide.some((r) => r.test(h.name)) && !show.some((r) => r.test(h.name))) { notes.push(`hid ${h.name}`); continue; }
    b.add('\n', ST.PLAIN);
    addHeader(b, h);
  }
  let bodyStart = b.pos;
  if (msg.body.length) {
    b.add('\n\n', ST.PLAIN);
    bodyStart = b.pos;
    const type = header(msg, 'Content-Type').toLowerCase();
    if (isBinary(msg.body)) b.add(`[binary body, ${msg.body.length} bytes]`, ST.MUTED);
    else {
      const text = msg.body.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
      const trimmed = text.trim();
      let json = false;
      if (cfg.prettyJson && (/json/.test(type) || /^[[{]/.test(trimmed))) {
        try { JSON.parse(trimmed); json = true; } catch {}
      }
      if (json) addJson(b, trimmed);
      else if (/x-www-form-urlencoded/.test(type) || (!type && /^[^\s=&]+=[^\s]*(&[^\s=&]+=?[^\s]*)*$/.test(trimmed))) addParams(b, trimmed, 'param');
      else if (/html|xml|svg/.test(type) || /^</.test(trimmed)) addMarkup(b, text);
      else b.add(text, ST.PLAIN);
    }
  }
  return { text: b.s, styles: Uint8Array.from(b.st), tokens: b.tokens, scalars: b.scalars, bodyStart, notes };
}

function lineRange(text, n) {
  let start = 0;
  for (let k = 1; k < n; k++) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) return null;
    start = nl + 1;
  }
  const nl = text.indexOf('\n', start);
  return { start, end: nl < 0 ? text.length : nl };
}

function innerValue(d, t) {
  if (t.kind === 'header' && /^(proxy-)?authorization$/i.test(t.name)) {
    const m = d.text.slice(t.valueStart, t.valueEnd).match(/^[A-Za-z-]+\s+(?=\S)/);
    if (m) return { start: t.valueStart + m[0].length, end: t.valueEnd };
  }
  if (t.kind === 'json' && t.scalar === 'str') return { start: t.valueStart + 1, end: t.valueEnd - 1 };
  return { start: t.valueStart, end: t.valueEnd };
}

function describe(sel) {
  return JSON.stringify(Object.fromEntries(Object.entries(sel).filter(([k]) => !['note', 'color'].includes(k))));
}

export function resolve(d, sel, defaultPart) {
  const nth = sel.occurrence ?? 1, part = sel.part ?? defaultPart;
  const pick = (list) => {
    const t = list[nth - 1];
    if (!t) return null;
    return part === 'value' ? innerValue(d, t) : { start: t.start, end: t.end };
  };
  let r = null;
  if (sel.match != null) {
    let at = -1;
    for (let k = 0, from = 0; k < nth; k++) {
      at = d.text.indexOf(sel.match, from);
      if (at < 0) break;
      from = at + 1;
    }
    if (at >= 0) r = { start: at, end: at + sel.match.length };
    else {
      const pattern = sel.match.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*').replace(/([:,])/g, '$1\\s*');
      const re = new RegExp(pattern, 'g');
      let m, k = 0;
      while ((m = re.exec(d.text))) { if (++k === nth) { r = { start: m.index, end: m.index + m[0].length }; break; } }
    }
  } else if (sel.key != null) r = pick(d.tokens.filter((t) => t.kind === 'json' && t.name === sel.key));
  else if (sel.header != null) r = pick(d.tokens.filter((t) => t.kind === 'header' && t.name.toLowerCase() === sel.header.toLowerCase()));
  else if (sel.param != null) r = pick(d.tokens.filter((t) => (t.kind === 'param' || t.kind === 'cookie') && t.name === sel.param));
  else if (sel.line != null) r = lineRange(d.text, sel.line);
  else throw new Error(`selector needs match, key, header, param or line: ${describe(sel)}`);
  if (!r || r.end <= r.start) throw new Error(`nothing in the ${sel.pane ?? 'pane'} matches ${describe(sel)}`);
  return r;
}

export function autoRedactions(d, cfg) {
  const headers = cfg.redactHeaders.map((h) => h.toLowerCase());
  const words = cfg.redactParams.map((w) => w.toLowerCase());
  const hit = (name) => words.some((w) => name.toLowerCase().includes(w));
  const out = [];
  const add = (r, why) => { if (r.end > r.start && !out.some((o) => o.start === r.start && o.end === r.end)) out.push({ ...r, why }); };
  for (const t of d.tokens) {
    if (t.kind === 'header' && headers.includes(t.name.toLowerCase())) {
      if (/^(set-)?cookie$/i.test(t.name)) {
        for (const c of d.tokens) {
          if (c.kind === 'cookie' && c.start >= t.start && c.end <= t.end) add(innerValue(d, c), `${t.name} ${c.name}`);
        }
      } else add(innerValue(d, t), t.name);
    } else if ((t.kind === 'param' || t.kind === 'cookie') && hit(t.name)) {
      add(innerValue(d, t), `${t.kind} ${t.name}`);
    } else if (t.kind === 'json' && hit(t.name)) {
      if (t.scalar) add(innerValue(d, t), `JSON ${t.name}`);
      else {
        for (const s of d.scalars) {
          if (s.start >= t.valueStart && s.end <= t.valueEnd) add(s.str ? { start: s.start + 1, end: s.end - 1 } : s, `JSON ${t.name}`);
        }
      }
    }
  }
  return out;
}
