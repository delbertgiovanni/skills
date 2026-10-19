#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; wp-duplicate-check)' };

const TYPES = {
  xss: /cross[- ]?site scripting|\bxss\b/i,
  sqli: /sql injection|\bsqli\b/i,
  csrf: /cross[- ]?site request forgery|\bcsrf\b/i,
  bac: /missing authori[sz]ation|broken access control|access control|authori[sz]ation bypass|unauthori[sz]ed/i,
  idor: /insecure direct object|\bidor\b|user[- ]controlled key/i,
  'file-upload': /file upload/i,
  'file-delete': /file deletion|delete arbitrary files|arbitrary file delet/i,
  'file-read': /file (read|download)|arbitrary file (read|download)|path traversal|directory traversal/i,
  lfi: /local file inclusion|\blfi\b|file inclusion/i,
  rce: /remote code execution|code execution|code injection|\brce\b|command injection/i,
  poi: /object injection|deserializ/i,
  ssrf: /server[- ]side request forgery|\bssrf\b/i,
  privesc: /privilege escalation|account takeover|role/i,
  'auth-bypass': /authentication bypass|auth(entication)? bypass|2fa|two[- ]factor|otp|broken authentication|login bypass|account takeover/i,
  sde: /sensitive (information|data) (exposure|disclosure)|information (exposure|disclosure)/i,
  redirect: /open redirect/i,
  dos: /denial of service|\bdos\b/i,
  settings: /settings? (change|update|modification)|options? update|update arbitrary options/i,
};

const USAGE = `usage: node dupes.mjs check <slug> [--theme] [--version X] [--type T] [--keyword k]... [--json]

Looks the plugin or theme up in every source it can reach and lists known vulnerabilities,
marking which ones overlap the version, type and keywords of your finding.

  --version X    the version you found the bug in
  --type T       ${Object.keys(TYPES).join(', ')}
  --keyword k    a parameter, action, endpoint, shortcode or function name; repeatable

Sources: Patchstack and NVD need no key. Wordfence is read from its public page through a local
Chrome or Chromium (set CHROME_PATH if it is not found), or from the v3 feed when WORDFENCE_API_KEY
is set. WPScan is used when WPSCAN_API_TOKEN is set.`;

function fail(message) {
  console.error(`dupes: ${message}`);
  process.exit(1);
}

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (i + 1 >= args.length) fail(`${name} needs a value`);
  return args.splice(i, 2)[1];
}

function options(args, name) {
  const out = [];
  for (let v = option(args, name); v !== undefined; v = option(args, name)) out.push(v);
  return out;
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

async function get(url, headers = {}, type = 'json') {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return type === 'json' ? res.json() : res.text();
}

function nuxtData(html) {
  const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const arr = JSON.parse(m[1]);
  const wrappers = new Set(['ShallowReactive', 'Reactive', 'Ref', 'ShallowRef', 'EmptyRef', 'Set', 'Map', 'Date']);
  const seen = new Map();
  const ref = (v, depth) => (Number.isInteger(v) && v >= 0 && v < arr.length ? decode(v, depth + 1) : v);
  const decode = (i, depth) => {
    if (depth > 40) return null;
    if (seen.has(i)) return seen.get(i);
    const x = arr[i];
    let out = x;
    if (Array.isArray(x)) {
      if (typeof x[0] === 'string' && wrappers.has(x[0])) out = x.length > 1 ? ref(x[1], depth) : null;
      else out = x.map((v) => ref(v, depth));
    } else if (x && typeof x === 'object') {
      out = {};
      for (const [k, v] of Object.entries(x)) out[k] = ref(v, depth);
    }
    seen.set(i, out);
    return out;
  };
  return decode(0, 0)?.data ?? null;
}

function unescape(s) {
  return String(s ?? '').replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c)).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function cmp(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const V = '(\\d+(?:\\.\\d+)*)';

function parseRange(text, fixed) {
  const t = String(text || '');
  let m;
  if ((m = t.match(new RegExp(`${V}\\s*(?:-|–|to)\\s*${V}`)))) return { from: m[1], fromInc: true, to: m[2], toInc: true };
  if ((m = t.match(new RegExp(`(?:from\\s+${V}\\s+)?(?:through|<=|≤|up to and including)\\s*${V}`, 'i')))) return { from: m[1], fromInc: true, to: m[2], toInc: true };
  if ((m = t.match(new RegExp(`(?:before|<|prior to|below|up to)\\s*${V}`, 'i')))) return { to: m[1], toInc: false };
  if ((m = t.match(new RegExp(`^\\s*${V}\\s*$`)))) return { from: m[1], fromInc: true, to: m[1], toInc: true };
  if (fixed && (m = String(fixed).match(new RegExp(V)))) return { to: m[1], toInc: false };
  return null;
}

function rangeText(r) {
  if (!r) return '?';
  const lo = r.from ? `${r.from} ${r.fromInc ? '≤' : '<'} ` : '';
  return `${lo}v ${r.toInc ? '≤' : '<'} ${r.to}`;
}

function inRange(version, r) {
  if (!version || !r) return null;
  if (r.from && cmp(version, r.from) < (r.fromInc ? 0 : 1)) return false;
  return cmp(version, r.to) < (r.toInc ? 1 : 0);
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((p) => p && existsSync(p));
}

function renderPage(url) {
  const chrome = chromePath();
  if (!chrome) return Promise.reject(new Error('no Chrome or Chromium found; set CHROME_PATH'));
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=15000', '--dump-dom', url], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Chrome timed out')); }, 90000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => { clearTimeout(timer); out ? resolve(out) : reject(new Error('Chrome returned nothing')); });
  });
}

async function fromPatchstack(slug, kind) {
  const html = await get(`https://patchstack.com/database/wordpress/${kind}/${encodeURIComponent(slug)}`, {}, 'text');
  const data = nuxtData(html) || {};
  const list = Object.entries(data).find(([k]) => k.startsWith(`pluginVulnerabilities-wordpress-${kind}-`))?.[1]?.vulnerabilities?.data;
  const details = Object.entries(data).find(([k]) => k.startsWith(`pluginDetails-wordpress-${kind}-`))?.[1];
  if (!list) return { records: [], name: null, note: 'not tracked by Patchstack' };
  return {
    name: details?.product?.name || null,
    records: list.map((v) => ({
      source: 'patchstack', cve: v.cve ? `CVE-${String(v.cve).replace(/^CVE-/i, '')}` : null,
      title: unescape(v.clean_title || v.slug), type: v.type, cvss: v.cvss,
      affected: v.affected_in, fixed: v.fixed_in, range: parseRange(v.affected_in, v.fixed_in),
      date: (v.disclosure_date || v.report_date || '').slice(0, 10),
      url: `https://patchstack.com/database/wordpress/${kind}/${slug}/vulnerability/${v.slug}`,
      text: unescape(`${v.clean_title} ${v.type}`),
    })),
  };
}

function wordfenceRecords(feed, slug, kind) {
  const out = [];
  for (const v of Object.values(feed)) {
    for (const s of v.software || []) {
      if (s.slug !== slug || s.type !== kind) continue;
      const ranges = Object.values(s.affected_versions || {});
      const r = ranges.length ? ranges[ranges.length - 1] : null;
      out.push({
        source: 'wordfence', cve: v.cve || null, title: unescape(v.title), type: v.cwe?.name || '', cvss: v.cvss?.score ?? null,
        affected: Object.keys(s.affected_versions || {}).join(', '), fixed: (s.patched_versions || []).join(', '),
        range: r ? { from: r.from_version === '*' ? undefined : r.from_version, fromInc: r.from_inclusive, to: r.to_version, toInc: r.to_inclusive } : null,
        date: (v.published || '').slice(0, 10), url: (v.references || []).find((u) => /wordfence\.com/.test(u)) || null,
        text: unescape(`${v.title} ${v.description || ''} ${v.cwe?.name || ''}`),
      });
    }
  }
  return out;
}

async function fromWordfenceFeed(slug, kind, key) {
  const cache = join(tmpdir(), 'wordfence-v3-production.json');
  let feed;
  if (existsSync(cache) && Date.now() - statSync(cache).mtimeMs < 6 * 3600 * 1000) feed = JSON.parse(readFileSync(cache, 'utf8'));
  else {
    const res = await fetch('https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production', { headers: { ...UA, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`${res.status} ${res.status === 401 ? 'bad WORDFENCE_API_KEY' : res.status === 429 ? 'rate limited; the feed is cached for 6 hours after one success' : res.statusText}`);
    const text = await res.text();
    writeFileSync(cache, text);
    feed = JSON.parse(text);
  }
  return { records: wordfenceRecords(feed, slug, kind), note: `v3 feed, cached in ${cache}` };
}

async function fromWordfencePage(slug, kind) {
  const html = await renderPage(`https://www.wordfence.com/threat-intel/vulnerabilities/wordpress-${kind}s/${encodeURIComponent(slug)}`);
  const text = unescape(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<\/(tr|p|li|div|h\d|a|span|td)>/gi, '\n').replace(/<[^>]+>/g, '')).split('\n').map((l) => l.trim()).filter(Boolean);
  const records = [];
  for (let i = 0; i < text.length; i++) {
    const cve = text.slice(i + 1, i + 4).find((l) => /^CVE-\d{4}-\d+$/.test(l));
    const cvss = text[i + 1];
    if (!/ (<=|<|≤|-|–) ?\d|\d+(\.\d+)* - /.test(text[i]) || !/^\d{1,2}(\.\d)?$/.test(cvss || '')) continue;
    const date = text.slice(i + 1, i + 5).find((l) => /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(l));
    const title = text[i];
    const affected = (title.match(/(?:<=|<|≤)\s*\d+(?:\.\d+)*|\d+(?:\.\d+)*\s*-\s*\d+(?:\.\d+)*/) || [])[0] || '';
    records.push({
      source: 'wordfence', cve: cve || null, title, type: '', cvss: Number(cvss), affected, fixed: '',
      range: parseRange(affected), date: date ? new Date(`${date} UTC`).toISOString().slice(0, 10) : '',
      url: `https://www.wordfence.com/threat-intel/vulnerabilities/wordpress-${kind}s/${slug}`, text: title,
    });
  }
  if (!records.length && /404 Page Not Found/.test(text.join(' '))) return { records, note: 'not in the Wordfence database' };
  if (!records.length && !/Software Slug/.test(text.join(' '))) throw new Error('page did not render; Wordfence may have blocked the headless browser');
  return { records, note: 'public page rendered in headless Chrome' };
}

async function fromWpscan(slug, kind, token) {
  const j = await get(`https://wpscan.com/api/v3/${kind}s/${encodeURIComponent(slug)}`, { Authorization: `Token token=${token}` });
  const vulns = j?.[slug]?.vulnerabilities || [];
  return {
    records: vulns.map((v) => ({
      source: 'wpscan', cve: v.references?.cve?.[0] ? `CVE-${String(v.references.cve[0]).replace(/^CVE-/i, '')}` : null,
      title: unescape(v.title), type: v.vuln_type || '', cvss: v.cvss?.score ?? null, affected: v.fixed_in ? `< ${v.fixed_in}` : '',
      fixed: v.fixed_in || '', range: parseRange('', v.fixed_in), date: (v.published_date || v.created_at || '').slice(0, 10),
      url: `https://wpscan.com/vulnerability/${v.id}`, text: unescape(`${v.title} ${v.vuln_type || ''}`),
    })),
    note: 'API, counts against the daily limit',
  };
}

async function fromNvd(slug, names) {
  const terms = [...new Set([slug, ...names].filter(Boolean))].slice(0, 3);
  const seen = new Map();
  for (const [n, term] of terms.entries()) {
    if (n) await new Promise((r) => setTimeout(r, 1500));
    const j = await get(`https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(term)}&resultsPerPage=2000`);
    for (const { cve } of j.vulnerabilities || []) {
      const desc = cve.descriptions?.find((d) => d.lang === 'en')?.value || '';
      if (!/wordpress/i.test(desc)) continue;
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const slugHit = new RegExp(`(^|[^a-z0-9/_-])${esc(slug)}([^a-z0-9/_-]|$)`, 'i').test(desc);
      const nameHit = names.some((nm) => new RegExp(`^\\s*(the\\s+)?${esc(nm)}(\\s*\\([^)]*\\))?\\s+(wordpress\\s+)?(plugin|theme)s?\\b`, 'i').test(desc));
      if (!slugHit && !nameHit) continue;
      const cpe = (cve.configurations || []).flatMap((c) => c.nodes || []).flatMap((n2) => n2.cpeMatch || []).find((c) => c.versionEndIncluding || c.versionEndExcluding);
      const range = cpe ? { from: cpe.versionStartIncluding || cpe.versionStartExcluding, fromInc: !!cpe.versionStartIncluding, to: cpe.versionEndIncluding || cpe.versionEndExcluding, toInc: !!cpe.versionEndIncluding } : parseRange(desc);
      const metric = cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore ?? cve.metrics?.cvssMetricV40?.[0]?.cvssData?.baseScore ?? null;
      seen.set(cve.id, {
        source: 'nvd', cve: cve.id, title: desc.length > 160 ? `${desc.slice(0, 157)}…` : desc, type: (cve.weaknesses?.[0]?.description?.[0]?.value) || '',
        cvss: metric, affected: range ? rangeText(range) : '', fixed: '', range, date: (cve.published || '').slice(0, 10),
        url: `https://nvd.nist.gov/vuln/detail/${cve.id}`, text: desc,
      });
    }
  }
  return { records: [...seen.values()], note: `keyword search for ${terms.map((t) => `"${t}"`).join(', ')}` };
}

function merge(all) {
  const byCve = new Map(), loose = [];
  for (const r of all) {
    if (!r.cve) { loose.push({ ...r, sources: [r.source], urls: [r.url].filter(Boolean) }); continue; }
    const cur = byCve.get(r.cve);
    if (!cur) { byCve.set(r.cve, { ...r, sources: [r.source], urls: [r.url].filter(Boolean) }); continue; }
    cur.sources.push(r.source);
    if (r.url) cur.urls.push(r.url);
    cur.text += ` ${r.text}`;
    if (!cur.range && r.range) { cur.range = r.range; cur.affected = r.affected; }
    if (!cur.fixed && r.fixed) cur.fixed = r.fixed;
    if (!cur.type && r.type) cur.type = r.type;
    if (r.source === 'nvd' && r.text.length > cur.text.length / 2) cur.description = r.text;
  }
  for (const r of loose) {
    const days = (x, y) => Math.abs(new Date(x) - new Date(y)) / 86400000;
    const twin = [...byCve.values()].find((c) => !c.sources.includes(r.source) && ((c.title && r.title && c.title.toLowerCase().slice(0, 40) === r.title.toLowerCase().slice(0, 40))
      || (c.date && r.date && days(c.date, r.date) <= 3 && c.range && r.range && cmp(c.range.to, r.range.to) === 0)));
    if (twin) { twin.sources.push(r.source); if (r.url) twin.urls.push(r.url); } else byCve.set(`${r.source}:${r.url}:${r.title}`, r);
  }
  return [...byCve.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function check(args) {
  const theme = flag(args, '--theme');
  const json = flag(args, '--json');
  let version = option(args, '--version');
  const type = option(args, '--type');
  const keywords = options(args, '--keyword');
  const slug = args[0];
  if (!slug) fail('check needs a slug');
  if (type && !TYPES[type]) fail(`--type must be one of: ${Object.keys(TYPES).join(', ')}`);
  const kind = theme ? 'theme' : 'plugin';

  const wporg = await get(theme
    ? `https://api.wordpress.org/themes/info/1.2/?action=theme_information&request[slug]=${encodeURIComponent(slug)}`
    : `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(slug)}&request[fields][sections]=0&request[fields][versions]=0`).catch(() => null);
  const wpName = unescape(wporg?.name || '').split(/ [–—|:-] /)[0].trim();
  if (version === 'latest') {
    if (!wporg?.version) fail('--version latest needs the plugin on wordpress.org; pass the version number');
    version = wporg.version;
  }
  if (version && !/^\d+(\.\w+)*$/.test(version)) fail(`--version must be a version number such as 6.2.2, or latest`);

  const sources = {};
  const run = async (name, fn) => {
    try { sources[name] = { ok: true, ...(await fn()) }; } catch (e) { sources[name] = { ok: false, records: [], note: e.message }; }
  };
  const wfKey = process.env.WORDFENCE_API_KEY, wpsToken = process.env.WPSCAN_API_TOKEN;
  await Promise.all([
    run('patchstack', () => fromPatchstack(slug, kind)),
    run('wordfence', () => (wfKey ? fromWordfenceFeed(slug, kind, wfKey) : fromWordfencePage(slug, kind))),
    wpsToken ? run('wpscan', () => fromWpscan(slug, kind, wpsToken)) : (sources.wpscan = { ok: false, skipped: true, records: [], note: 'skipped: set WPSCAN_API_TOKEN (free account at wpscan.com, about 25 requests a day)' }),
  ]);
  const names = [wpName, sources.patchstack?.name].filter((n) => n && n.length > 3);
  await run('nvd', () => fromNvd(slug, names));

  const records = merge(Object.values(sources).flatMap((s) => s.records || []));
  const typeRe = type ? TYPES[type] : null;
  for (const r of records) {
    r.versionMatch = inRange(version, r.range);
    r.typeMatch = typeRe ? typeRe.test(`${r.title} ${r.type} ${r.text}`) : null;
    r.keywordMatch = keywords.length ? keywords.filter((k) => new RegExp(`(^|[^a-z0-9_])${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_])`).test(`${r.text} ${r.description || ''}`.toLowerCase())) : null;
  }
  const strong = records.filter((r) => r.versionMatch !== false && r.typeMatch !== false && (!keywords.length || r.keywordMatch.length));
  const typeOnly = records.filter((r) => !strong.includes(r) && r.versionMatch !== false && r.typeMatch);

  const result = {
    slug, kind, name: unescape(wporg?.name || sources.patchstack?.name || slug), latest: wporg?.version || null,
    finding: { version: version || null, type: type || null, keywords },
    sources: Object.fromEntries(Object.entries(sources).map(([k, s]) => [k, { ok: s.ok, count: (s.records || []).length, note: s.note || '' }])),
    likelyDuplicates: strong.length && (version || type || keywords.length) ? strong : [],
    sameTypeInRange: typeOnly, all: records,
  };
  if (json) return console.log(JSON.stringify(result, (k, v) => (k === 'text' ? undefined : v), 2));

  const line = (r) => {
    const marks = [r.versionMatch === true ? 'version ✓' : r.versionMatch === false ? 'version ✗' : '', r.typeMatch === true ? 'type ✓' : r.typeMatch === false ? 'type ✗' : '', r.keywordMatch?.length ? `keyword ✓ (${r.keywordMatch.join(', ')})` : r.keywordMatch ? 'keyword ✗' : ''].filter(Boolean).join(' ');
    return `  ${r.date || '????-??-??'}  ${(r.cve || 'no CVE').padEnd(16)} ${r.cvss ?? '-'}  ${r.title}\n      affected ${r.range ? rangeText(r.range) : r.affected || '?'}${r.fixed ? `, fixed ${r.fixed}` : ''}  [${[...new Set(r.sources)].join(', ')}]${marks ? `  ${marks}` : ''}\n      ${r.urls[0] || ''}`;
  };
  const out = [`${result.name} (${kind} ${slug})${result.latest ? `, latest ${result.latest}` : ''}`];
  out.push('sources: ' + Object.entries(result.sources).map(([k, s]) => `${k} ${s.ok ? `${s.count}` : s.note.startsWith('skipped') ? 'skipped' : 'FAILED'}`).join(', '));
  for (const [k, s] of Object.entries(result.sources)) if (!s.ok || s.note) out.push(`  ${k}: ${s.note}`);
  if (version || type || keywords.length) {
    out.push('', result.likelyDuplicates.length ? `LIKELY DUPLICATES (${result.likelyDuplicates.length}): known issues matching your version, type and at least one keyword` : 'no known issue matches every detail you gave');
    for (const r of result.likelyDuplicates) out.push(line(r));
    if (typeOnly.length) { out.push('', `same type, overlapping versions, keywords not found in the advisory text (${typeOnly.length}):`); for (const r of typeOnly) out.push(line(r)); }
  }
  const rest = records.filter((r) => !result.likelyDuplicates.includes(r) && !typeOnly.includes(r));
  out.push('', `${version || type || keywords.length ? 'other known issues' : 'known issues'} (${rest.length}):`);
  for (const r of rest) out.push(line(r));
  console.log(out.join('\n'));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === 'help') {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }
  if (command === 'check') return check(args);
  fail(`unknown command "${command}"\n\n${USAGE}`);
}

main().catch((e) => fail(e.message));
