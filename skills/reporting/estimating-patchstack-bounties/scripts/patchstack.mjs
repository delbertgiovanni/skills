#!/usr/bin/env node
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; patchstack-estimator)' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const INSTALL_TIERS = [
  [10000000, 15, '10M+ (inferred, not published)'], [5000000, 10, '5M+'], [3200000, 9, '3.2M+'], [1600000, 8, '1.6M+'],
  [800000, 7, '800K+'], [400000, 6, '400K+'], [200000, 5, '200K+'], [100000, 4, '100K+'], [50000, 3, '50K+'],
  [25000, 2, '25K+'], [10000, 1, '10K+'], [5000, 0.75, '5K+'], [1000, 0.5, '1K+'], [0, 0.25, 'under 1K (mVDP only)'],
];

const TYPES = {
  rce: [3, 'Remote code execution'], 'code-exec': [3, 'Arbitrary code execution'], 'file-upload': [3, 'Arbitrary file upload'],
  'file-delete': [3, 'Arbitrary file deletion'], 'privesc-admin': [3, 'Privilege escalation to admin'],
  sqli: [2, 'SQL injection'], deserialization: [2, 'Insecure deserialization'],
  'file-download': [1.5, 'Arbitrary file download'], privesc: [1.5, 'Privilege escalation to non-admin'],
  poi: [1, 'PHP object injection'], lfi: [1, 'Local file inclusion'], xss: [1, 'Cross-site scripting'],
  bac: [1, 'Broken access control'], idor: [1, 'IDOR'], sde: [1, 'Sensitive data exposure'], ssrf: [1, 'SSRF'],
  settings: [1, 'Arbitrary settings change'], other: [1, 'Other (unlisted types score x1)'],
  csrf: [0.25, 'CSRF'], race: [0.2, 'Race condition'],
};

const PRIV = {
  unauth: [2, 'Unauthenticated'], subscriber: [1, 'Subscriber / Customer'], contributor: [0.75, 'Contributor (mVDP only)'],
  author: [0, 'Author'], editor: [0, 'Editor'], admin: [0, 'Administrator'], 'shop-manager': [0, 'Shop Manager'],
};

const ZERODAY = [
  [15000000, 33000, 16500], [10000000, 24000, 12000], [5000000, 14400, 7200], [3000000, 10800, 5040],
  [1000000, 7200, 3600], [500000, 4900, 2450], [100000, 2600, 1300], [50000, 1400, 700], [10000, 600, 300],
  [5000, 400, 200], [1000, 250, 125],
];

const USAGE = `usage: node patchstack.mjs <command> [options]

  product <slug> [--theme]           installs, VDP status and boost for a plugin or theme
  estimate --cvss N --type T --priv P [--slug s [--theme] | --installs N --vdp no|yes|boost]
           [--ui-required] [--ac-high] [--poi-no-chain] [--chain T]
                                     eligibility, XP and the dollar range for one finding
  rates [--months 12]                monthly pool, total XP and dollars per XP from the leaderboards

types: ${Object.keys(TYPES).join(', ')}
priv:  ${Object.keys(PRIV).join(', ')}
Add --json to any command for machine-readable output.`;

function fail(message) {
  console.error(`patchstack: ${message}`);
  process.exit(1);
}

function option(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (i + 1 >= args.length) fail(`${name} needs a value`);
  return args.splice(i, 2)[1];
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

async function get(url, type = 'json') {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!res.ok && type === 'json') throw new Error(`${res.status} from ${url}`);
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

const fmt = (n) => Number(n).toLocaleString('en-US');
const unescape = (s) => s && s.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c)).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'");
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

function installTier(n) {
  return INSTALL_TIERS.find(([min]) => n >= min);
}

async function product(slug, theme) {
  const kind = theme ? 'theme' : 'plugin';
  const wporg = theme
    ? `https://api.wordpress.org/themes/info/1.2/?action=theme_information&request[slug]=${encodeURIComponent(slug)}&request[fields][active_installs]=1&request[fields][sections]=0`
    : `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(slug)}&request[fields][sections]=0&request[fields][versions]=0`;
  const [info, eligibility, directory, page] = await Promise.all([
    get(wporg).catch(() => null),
    get(`https://vdp-api.patchstack.com/reports/vdp-eligibility?slug=${encodeURIComponent(slug)}`).catch(() => null),
    get('https://patchstack.com/database/vdp', 'text').catch(() => ''),
    get(`https://patchstack.com/database/wordpress/${kind}/${encodeURIComponent(slug)}`, 'text').catch(() => ''),
  ]);
  const featured = Object.values(nuxtData(directory) || {}).find((v) => v?.featured)?.featured?.results || [];
  const boosted = featured.find((f) => f.slug === slug);
  const details = Object.entries(nuxtData(page) || {}).find(([k]) => k.startsWith(`pluginDetails-wordpress-${kind}-`))?.[1];
  const vulns = Object.entries(nuxtData(page) || {}).find(([k]) => k.startsWith(`pluginVulnerabilities-wordpress-${kind}-`))?.[1];
  const installs = info && !info.error ? info.active_installs ?? null : details?.api_data?.obj?.active_installs ?? null;
  const vdp = eligibility?.vdp ?? details?.product?.has_vdp ?? null;
  const boost = boosted ? Number(boosted.boost) : vdp ? 15 : 0;
  return {
    slug, kind, name: unescape(info?.name || details?.product?.name || null),
    onWordpressOrg: !!(info && !info.error), closed: info?.error === 'closed',
    version: info?.version || null, lastUpdated: info?.last_updated || null, installs,
    vdp, boostPercent: boost, vdpMultiplier: 1 + boost / 100,
    knownVulnerabilities: vulns?.vulnerabilities?.data?.length ?? (vulns ? 0 : null),
    patchstackPage: `https://patchstack.com/database/wordpress/${kind}/${slug}`,
  };
}

async function monthRates(count) {
  const now = new Date();
  const keys = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`);
  }
  const rows = await Promise.all(keys.map(async (key) => {
    try {
      const data = nuxtData(await get(`https://patchstack.com/database/leaderboard/${key}`, 'text'));
      const board = data?.[`leaderboard-${key}`];
      if (!board) return { month: key, error: 'no data' };
      const [name, year] = key.split('-');
      const pool = Object.values(board.leaderboardAll || {}).flat().find((p) => p?.name?.toLowerCase() === `${name} ${year}`)?.bounty_total ?? null;
      const researchers = board.leaderboardResearchers || [];
      const totalXp = researchers.reduce((s, r) => s + Number(r.xp || 0), 0);
      const reports = researchers.reduce((s, r) => s + Number(r.reports_validated || 0), 0);
      return { month: key, pool, totalXp: Math.round(totalXp), researchers: researchers.length, reports, usdPerXp: totalXp > 0 && pool ? +(pool / totalXp).toFixed(3) : null };
    } catch (e) {
      return { month: key, error: e.message };
    }
  }));
  return rows;
}

function estimateXp(o) {
  const notes = [], blockers = [];
  const [typeMult, typeName] = TYPES[o.chain || o.type];
  const [privMult, privName] = PRIV[o.priv];
  const tier = installTier(o.installs);
  let penalties = 0;
  if (o.uiRequired) penalties++;
  if (o.acHigh) penalties++;
  if (o.type === 'poi' && o.poiNoChain) penalties++;
  const penalty = penalties >= 2 ? 0.25 : penalties === 1 ? 0.5 : 1;

  if (privMult === 0) blockers.push(`${privName} is out of scope: only unauthenticated, Subscriber/Customer, or Contributor on mVDP software`);
  if (o.priv === 'contributor' && !o.vdp) blockers.push('Contributor-level findings are accepted only for mVDP software');
  if (o.installs < 1000 && !o.vdp) blockers.push('under 1,000 active installs is accepted only for mVDP software');
  if (o.acHigh && !o.vdp) blockers.push('AC:H is out of scope unless the software is in mVDP (then x0.5)');
  if (o.cvss === 5.3 && o.priv === 'unauth') notes.push('unauthenticated with a single low CIA impact (CVSS 5.3) is out of scope');
  if ((o.cvss === 5.4 || o.cvss === 6.3) && o.priv !== 'unauth') notes.push('Subscriber+ with only low CIA impacts (CVSS 5.4 / 6.3) is out of scope');
  if (o.type === 'xss' && o.priv === 'contributor') notes.push('Contributor stored XSS is out of scope except on mVDP software');
  if (o.type === 'csrf' && o.chain) notes.push(`CSRF chained to ${TYPES[o.chain][1]} uses the higher type multiplier`);
  if (o.installs >= 10000000) notes.push('the x15 tier for 10M+ is inferred from published XP, not from the rules; x10 is the documented maximum');
  if (o.vdp && o.priv === 'contributor') notes.push('mVDP reports may not earn XP at all; Patchstack decides per report');

  const xp = o.cvss * tier[1] * privMult * typeMult * penalty * o.vdpMultiplier;
  return {
    eligible: blockers.length === 0, blockers, notes,
    factors: { cvss: o.cvss, installs: `${tier[1]} (${tier[2]})`, privilege: `${privMult} (${privName})`, type: `${typeMult} (${typeName})`, penalty: `${penalty}${penalties ? ` (${penalties} condition${penalties > 1 ? 's' : ''})` : ''}`, vdp: o.vdpMultiplier },
    xp: blockers.length ? 0 : +xp.toFixed(2),
  };
}

function zeroday(o) {
  if (!['unauth', 'subscriber'].includes(o.priv)) return null;
  if (o.type === 'poi' && o.poiNoChain) return null;
  if (o.uiRequired || o.acHigh) return null;
  if (!['rce', 'code-exec', 'file-upload', 'privesc-admin', 'deserialization', 'file-delete', 'poi', 'lfi'].includes(o.chain || o.type)) return null;
  const row = ZERODAY.find(([min]) => o.installs >= min);
  if (!row) return null;
  return { amount: o.priv === 'unauth' ? row[1] : row[2], tier: `${fmt(row[0])}+`, requires: 'full site compromise with a working exploit, no other prerequisites or user interaction, latest version, default settings, unreported anywhere' };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === 'help') {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }
  const json = flag(args, '--json');
  const print = (data, text) => console.log(json ? JSON.stringify(data, null, 2) : text);

  if (command === 'product') {
    const theme = flag(args, '--theme');
    if (!args[0]) fail('product needs a slug');
    const p = await product(args[0], theme);
    print(p, [
      `${p.name || p.slug} (${p.kind} ${p.slug})${p.closed ? ' CLOSED on wordpress.org' : ''}${p.onWordpressOrg ? '' : p.closed ? '' : ' (not on wordpress.org: pass --installs for premium software)'}`,
      `version ${p.version || '?'}, last updated ${p.lastUpdated || '?'}`,
      `installs: ${p.installs == null ? 'unknown' : `${fmt(p.installs)}+ → install multiplier x${installTier(p.installs)[1]} (${installTier(p.installs)[2]})`}`,
      `VDP: ${p.vdp == null ? 'unknown' : p.vdp ? `yes, +${p.boostPercent}% XP (x${p.vdpMultiplier})` : 'no'}`,
      `known Patchstack entries: ${p.knownVulnerabilities ?? 'none tracked'}  ${p.patchstackPage}`,
    ].join('\n'));
    return;
  }

  if (command === 'rates') {
    const months = Number(option(args, '--months', '12'));
    const rows = await monthRates(months);
    print(rows, ['month            pool      total XP  reports  $/XP', ...rows.map((r) => r.error
      ? `${r.month.padEnd(16)} ${r.error}`
      : `${r.month.padEnd(16)} ${(r.pool ? money(r.pool) : '?').padStart(8)}  ${fmt(r.totalXp).padStart(8)}  ${String(r.reports).padStart(7)}  ${r.usdPerXp ?? 'open month'}`)].join('\n'));
    return;
  }

  if (command === 'estimate') {
    const cvss = Number(option(args, '--cvss'));
    const type = option(args, '--type');
    const priv = option(args, '--priv');
    const chain = option(args, '--chain');
    const slug = option(args, '--slug');
    const theme = flag(args, '--theme');
    let installs = option(args, '--installs');
    let vdpArg = option(args, '--vdp');
    const o = { cvss, type, priv, chain, uiRequired: flag(args, '--ui-required'), acHigh: flag(args, '--ac-high'), poiNoChain: flag(args, '--poi-no-chain') };
    if (!(cvss > 0 && cvss <= 10)) fail('--cvss must be the CVSS v3.1 base score, 0.1 to 10');
    if (!TYPES[type]) fail(`--type must be one of: ${Object.keys(TYPES).join(', ')}`);
    if (chain && !TYPES[chain]) fail(`--chain must be one of: ${Object.keys(TYPES).join(', ')}`);
    if (!PRIV[priv]) fail(`--priv must be one of: ${Object.keys(PRIV).join(', ')}`);
    let p = null;
    if (slug) p = await product(slug, theme);
    if (installs == null) installs = p?.installs;
    if (installs == null) fail('install count unknown: pass --installs N (for premium software use the vendor\'s active install or sales figure)');
    o.installs = Number(installs);
    if (vdpArg == null) vdpArg = p?.vdp ? (p.boostPercent === 35 ? 'boost' : 'yes') : 'no';
    if (!['no', 'yes', 'boost'].includes(vdpArg)) fail('--vdp must be no, yes or boost');
    o.vdp = vdpArg !== 'no';
    o.vdpMultiplier = vdpArg === 'boost' ? 1.35 : vdpArg === 'yes' ? 1.15 : 1;
    const est = estimateXp(o);
    const rows = (await monthRates(7)).filter((r) => r.usdPerXp);
    const latest = rows[0];
    const lo = Math.min(...rows.map((r) => r.usdPerXp)), hi = Math.max(...rows.map((r) => r.usdPerXp));
    const zd = est.eligible ? zeroday(o) : null;
    const result = {
      product: p, ...est,
      dollars: est.xp && latest ? { latestMonth: latest.month, atLatestRate: +(est.xp * latest.usdPerXp).toFixed(2), rangeLast6Months: [+(est.xp * lo).toFixed(2), +(est.xp * hi).toFixed(2)], usdPerXp: { latest: latest.usdPerXp, min: lo, max: hi } } : null,
      zeroday: zd,
    };
    const f = est.factors;
    print(result, [
      p ? `${p.name || p.slug}: ${fmt(o.installs)}+ installs, VDP ${o.vdp ? (o.vdpMultiplier === 1.35 ? 'yes (boosted)' : 'yes') : 'no'}` : `${fmt(o.installs)}+ installs, VDP ${vdpArg}`,
      est.eligible ? 'passes the role, install and AC:H checks; check the impact rules in reference/scope.md by hand' : `NOT eligible: ${est.blockers.join('; ')}`,
      `XP = ${f.cvss} × ${f.installs} × ${f.privilege} × ${f.type} × ${f.penalty} × ${f.vdp} = ${est.xp}`,
      result.dollars ? `≈ ${money(result.dollars.atLatestRate)} at ${latest.month}'s rate ($${latest.usdPerXp}/XP); ${money(result.dollars.rangeLast6Months[0])}–${money(result.dollars.rangeLast6Months[1])} over the last 6 finished months` : '',
      result.dollars ? 'before your monthly rejection-rate reduction, and paid only as a share of that month\'s pool' : '',
      zd ? `zero-day candidate: ${money(zd.amount)} flat (${zd.tier} installs) if it is ${zd.requires}` : '',
      ...est.notes.map((n) => `note: ${n}`),
    ].filter(Boolean).join('\n'));
    return;
  }

  fail(`unknown command "${command}"\n\n${USAGE}`);
}

main().catch((e) => fail(e.message));
