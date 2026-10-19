#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const API = 'https://api.wordpress.org/plugins/info/1.2/';
const SVN = 'https://plugins.svn.wordpress.org';
const DOWNLOADS = 'https://downloads.wordpress.org/plugin';
const STATS = 'https://api.wordpress.org/stats/plugin/1.0';

const USAGE = `usage: node wp.mjs <command> [args] [--json]

  info <slug>                       installs, Wordfence band, versions, dates, closed status
  versions <slug>                   every SVN tag with its release date and revision
  download <slug> [version|trunk]   fetch and extract the code       [--out dir]
  diff <slug> <from> <to>           diff two versions (tags or trunk) [--out dir]
  log <slug> [--limit 20]           SVN commits: revision, date, author, message, files
  changeset <slug> <revision>       diff of one SVN commit            [--out dir]
  find [--min N] [--max N]          plugins whose real install range lies inside min–max
                                    (marked "?" when it only overlaps); both default to open
       [--tag t | --search q | --author a] [--updated-within days]
       [--sort installs|updated|relevance] [--limit 50]

--out defaults to ./wp-plugins. Diffs are written to files; the summary goes to stdout.`;

const BANDS = [
  [0, 24, '<25'], [25, 499, '25-499'], [500, 999, '500-999'], [1000, 4999, '1,000-4,999'],
  [5000, 9999, '5,000-9,999'], [10000, 14999, '10,000-14,999'], [15000, 29999, '15,000-29,999'],
  [30000, 49999, '30,000-49,999'], [50000, 99999, '50,000-99,999'], [100000, 499999, '100,000-499,999'],
  [500000, 999999, '500,000-999,999'], [1000000, 4999999, '1,000,000-4,999,999'], [5000000, Infinity, '5,000,000+'],
];

const LIGHT_FIELDS = ['description', 'short_description', 'icons', 'tags', 'ratings', 'author_profile', 'homepage', 'donate_link']
  .map((f) => `request[fields][${f}]=0`).join('&');

function fail(message) {
  console.error(`wp: ${message}`);
  process.exit(1);
}

async function request(url, options = {}, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...options, headers: { 'User-Agent': 'looking-up-wordpress-plugins', ...options.headers } });
    } catch (e) {
      if (attempt >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    return res;
  }
}

async function api(params) {
  const res = await request(`${API}?${params}`);
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`api.wordpress.org returned ${res.status} without JSON`);
  return json;
}

function installRange(v) {
  if (v >= 10000000) return [10000000, Infinity];
  if (v <= 0) return [0, 9];
  const step = 10 ** Math.floor(Math.log10(v));
  return [v, v + step - 1];
}

function bandsFor(v) {
  const [lo, hi] = installRange(v);
  return BANDS.filter(([a, b]) => a <= hi && b >= lo).map(([, , label]) => label);
}

function fmt(n) {
  return n === Infinity ? '∞' : n.toLocaleString('en-US');
}

function parseUpdated(s) {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})(am|pm) GMT$/);
  if (!m) return null;
  let h = Number(m[2]) % 12;
  if (m[4] === 'pm') h += 12;
  return new Date(`${m[1]}T${String(h).padStart(2, '0')}:${m[3]}:00Z`);
}

function sortVersions(list) {
  const key = (v) => v.toLowerCase().split(/[.+_-]/).map((p) => (/^\d+$/.test(p) ? p.padStart(8, '0') : `!${p}`));
  return list.sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      if (ka[i] === undefined) return kb[i].startsWith('!') ? 1 : -1;
      if (kb[i] === undefined) return ka[i].startsWith('!') ? -1 : 1;
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return 0;
  });
}

async function propfind(path) {
  const body = '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:version-name/><D:creator-displayname/><D:getlastmodified/><D:resourcetype/></D:prop></D:propfind>';
  const res = await request(`${SVN}${path}`, { method: 'PROPFIND', headers: { Depth: '1', 'Content-Type': 'text/xml' }, body });
  if (res.status === 404) return null;
  if (res.status !== 207) throw new Error(`PROPFIND ${path}: HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<D:response[^>]*>([\s\S]*?)<\/D:response>/g)].map(([, r]) => ({
    href: decodeURIComponent((r.match(/<D:href>([^<]*)<\/D:href>/) || [])[1] || ''),
    revision: Number((r.match(/<lp1:version-name>(\d+)</) || [])[1]),
    author: (r.match(/<lp1:creator-displayname>([^<]*)</) || [])[1] || '',
    date: new Date((r.match(/<lp1:getlastmodified>([^<]*)</) || [])[1]),
    dir: /<D:collection\/>/.test(r),
  }));
}

async function svnTags(slug) {
  const entries = await propfind(`/${slug}/tags/`);
  if (!entries) return null;
  const root = `/${slug}/tags/`;
  return entries.filter((e) => e.href !== root && e.dir).map((e) => ({ ...e, version: e.href.slice(root.length).replace(/\/$/, '') }));
}

async function deletedTags(slug) {
  const root = await propfind(`/${slug}/tags/`);
  if (!root) return [];
  const items = await svnLog(`/${slug}/tags/`, root[0].revision, 0);
  const added = new Map(), deleted = new Map();
  const re = new RegExp(`^/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/tags/([^/]+)$`);
  for (const item of [...items].reverse()) {
    for (const p of item.paths) {
      const m = p.path.match(re);
      if (!m) continue;
      if (p.action === 'deleted') deleted.set(m[1], item);
      else { added.set(m[1], item); deleted.delete(m[1]); }
    }
  }
  return [...deleted].map(([version, item]) => ({
    version, deletedRevision: item.revision, deletedDate: item.date.slice(0, 10), deletedBy: item.author, deleteMessage: item.message,
    date: added.has(version) ? new Date(added.get(version).date) : null, revision: added.get(version)?.revision, author: added.get(version)?.author || '',
  }));
}

async function svnLog(path, start, limit, end = 0) {
  const body = `<?xml version="1.0"?><S:log-report xmlns:S="svn:"><S:start-revision>${start}</S:start-revision><S:end-revision>${end}</S:end-revision>${limit ? `<S:limit>${limit}</S:limit>` : ''}<S:discover-changed-paths/><S:path></S:path></S:log-report>`;
  const res = await request(`${SVN}${path}`, { method: 'REPORT', headers: { 'Content-Type': 'text/xml' }, body });
  if (res.status !== 200) throw new Error(`log ${path}: HTTP ${res.status}`);
  const xml = await res.text();
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return [...xml.matchAll(/<S:log-item>([\s\S]*?)<\/S:log-item>/g)].map(([, item]) => ({
    revision: Number((item.match(/<D:version-name>(\d+)</) || [])[1]),
    date: (item.match(/<S:date>([^<]*)</) || [])[1] || '',
    author: (item.match(/<D:creator-displayname>([^<]*)</) || [])[1] || '',
    message: unescape((item.match(/<D:comment>([\s\S]*?)<\/D:comment>/) || [])[1] || ''),
    paths: [...item.matchAll(/<S:(added|modified|deleted|replaced)-path([^>]*)>([^<]*)</g)].map(([, action, attrs, p]) => ({
      action, path: unescape(p), kind: (attrs.match(/node-kind="(\w+)"/) || [])[1] || 'file',
    })),
  }));
}

function unzip(buf, outDir) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const root = resolve(outDir);
  let files = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    const target = resolve(root, name);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`zip entry escapes the output folder: ${name}`);
    if (name.endsWith('/')) { mkdirSync(target, { recursive: true }); continue; }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`unsupported zip compression ${method} for ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    files++;
  }
  return files;
}

async function svnExport(path, outDir) {
  const queue = [path];
  let files = 0, busy = 0;
  const worker = async () => {
    for (;;) {
      const dir = queue.shift();
      if (!dir) {
        if (!busy) return;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      busy++;
      try {
        const entries = await propfind(dir.split('/').map(encodeURIComponent).join('/'));
        if (!entries) throw new Error(`${dir} not found in SVN`);
        for (const e of entries) {
          if (e.href === dir) continue;
          if (e.dir) {
            mkdirSync(join(outDir, e.href.slice(path.length)), { recursive: true });
            queue.push(e.href);
            continue;
          }
          const res = await request(`${SVN}${e.href.split('/').map(encodeURIComponent).join('/')}`);
          if (!res.ok) throw new Error(`${e.href}: HTTP ${res.status}`);
          const target = join(outDir, e.href.slice(path.length));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, Buffer.from(await res.arrayBuffer()));
          files++;
        }
      } finally {
        busy--;
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return files;
}

async function fetchCode(slug, version, outRoot) {
  const dir = join(outRoot, slug, version);
  if (existsSync(dir)) return { dir, cached: true };
  const tmp = `${dir}.part`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    return await fillCode(slug, version, dir, tmp);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

async function fillCode(slug, version, dir, tmp) {
  let files, source;
  if (version === 'trunk') {
    source = `${SVN}/${slug}/trunk/`;
    files = await svnExport(`/${slug}/trunk/`, tmp);
  } else {
    source = `${DOWNLOADS}/${slug}.${version}.zip`;
    const res = await request(source);
    if (res.ok) {
      files = unzip(Buffer.from(await res.arrayBuffer()), tmp);
      const inner = join(tmp, slug);
      if (existsSync(inner) && readdirSync(tmp).length === 1) {
        renameSync(inner, dir);
        rmSync(tmp, { recursive: true, force: true });
        return { dir, files, source };
      }
    } else {
      const tags = await svnTags(slug);
      if (tags && tags.some((t) => t.version === version)) {
        source = `${SVN}/${slug}/tags/${version}/`;
        files = await svnExport(`/${slug}/tags/${version}/`, tmp);
      } else {
        const gone = (await deletedTags(slug)).find((t) => t.version === version);
        if (!gone) throw new Error(`no zip (HTTP ${res.status}) and no SVN tag "${version}" for ${slug}; run "versions ${slug}"`);
        const path = `/!svn/bc/${gone.deletedRevision - 1}/${slug}/tags/${version}/`;
        source = `${SVN}${path} (tag deleted in r${gone.deletedRevision})`;
        files = await svnExport(path, tmp);
      }
    }
  }
  renameSync(tmp, dir);
  return { dir, files, source };
}

function runDiff(cwd, a, b, outFile) {
  const run = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { cwd, maxBuffer: 1 << 30 }).toString();
    } catch (e) {
      if (e.status === 1 && e.stdout) return e.stdout.toString();
      throw e;
    }
  };
  let stat, full;
  try {
    stat = run('git', ['diff', '--no-index', '--no-color', '--stat=200,150', a, b]);
    full = run('git', ['diff', '--no-index', '--no-color', a, b]);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    full = run('diff', ['-ruN', a, b]);
    stat = `${(full.match(/^diff -ruN /gm) || []).length} files changed (install git for a per-file summary)`;
  }
  writeFileSync(outFile, full);
  return stat;
}

function shown(p) {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith('..') ? r : p;
}

function option(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (i + 1 >= args.length) fail(`${name} needs a value`);
  return args.splice(i, 2)[1];
}

function print(json, data, text) {
  if (json) console.log(JSON.stringify(data, null, 2));
  else console.log(text);
}

async function info(slug, json) {
  const fields = 'request[fields][versions]=1&request[fields][sections]=0&request[fields][description]=0&request[fields][screenshots]=0&request[fields][banners]=0&request[fields][reviews]=0';
  const p = await api(`action=plugin_information&request[slug]=${encodeURIComponent(slug)}&${fields}`);
  if (p.error === 'Plugin not found.') fail(`no plugin with slug "${slug}" on wordpress.org (it may never have existed, or the slug differs from the folder name)`);
  if (p.error === 'closed') {
    const tags = (await svnTags(slug)) || [];
    const last = sortVersions(tags.map((t) => t.version)).pop();
    const data = { slug, name: p.name, closed: true, closedDate: p.closed_date, reason: p.reason_text, permanent: /permanent/i.test(p.description || ''), tags: tags.length, lastTag: last, svn: `${SVN}/${slug}/` };
    return print(json, data, [
      `${p.name} (${slug}) is CLOSED since ${p.closed_date}: ${p.reason_text}${data.permanent ? ' (permanent)' : ''}`,
      'The API hides installs and versions for closed plugins, but the code is still downloadable:',
      `  ${tags.length} SVN tags, latest ${last || 'none'}; run "versions ${slug}" for dates, "download ${slug} ${last || 'trunk'}" for code`,
      `  SVN: ${SVN}/${slug}/`,
    ].join('\n'));
  }
  if (p.error) fail(`api.wordpress.org: ${p.error}`);
  const [lo, hi] = installRange(p.active_installs);
  const bands = bandsFor(p.active_installs);
  const versions = sortVersions(Object.keys(p.versions || {}).filter((v) => v !== 'trunk'));
  let share = null;
  try { share = await (await request(`${STATS}/${encodeURIComponent(slug)}`)).json(); } catch {}
  const data = {
    slug, name: p.name.replace(/&#8211;/g, '–').replace(/&amp;/g, '&'), version: p.version, activeInstalls: p.active_installs, installRange: [lo, hi === Infinity ? null : hi],
    wordfenceBands: bands, lastUpdated: p.last_updated, added: p.added, requires: p.requires, tested: p.tested, requiresPhp: p.requires_php,
    author: (p.author || '').replace(/<[^>]+>/g, ''), versions: versions.length, recentVersions: versions.slice(-10),
    versionShare: share, download: p.download_link, svn: `${SVN}/${slug}/`, page: `https://wordpress.org/plugins/${slug}/`,
  };
  print(json, data, [
    `${data.name} (${slug}) ${p.version} by ${data.author}`,
    `installs: API says ${fmt(p.active_installs)}+ → real count ${fmt(lo)}–${fmt(hi)}`,
    `Wordfence band: ${bands.join(' OR ')}${bands.length > 1 ? '  (ambiguous: the API rounds down to one significant digit)' : ''}`,
    `updated ${p.last_updated}, added ${p.added}, WP ${p.requires}–${p.tested}, PHP ${p.requires_php || '?'}`,
    `versions: ${versions.length} still listed by the API; latest ${versions.slice(-6).join(', ')} ("versions" shows every SVN tag, deleted ones included)`,
    share ? `installs by branch: ${Object.entries(share).map(([k, v]) => `${k} ${v}%`).join(', ')}` : '',
    `code: ${p.download_link}`,
    `svn:  ${SVN}/${slug}/`,
  ].filter(Boolean).join('\n'));
}

async function versionsCmd(slug, json) {
  const tags = await svnTags(slug);
  if (!tags) fail(`no SVN repository for "${slug}"`);
  const gone = await deletedTags(slug);
  const all = [...tags, ...gone];
  const rows = sortVersions(all.map((t) => t.version)).map((v) => all.find((t) => t.version === v));
  const day = (d) => (d ? d.toISOString().slice(0, 10) : '?         ');
  print(json, rows.map((t) => ({ version: t.version, date: t.date ? day(t.date) : null, revision: t.revision, author: t.author, ...(t.deletedRevision ? { deletedRevision: t.deletedRevision, deletedDate: t.deletedDate, deleteMessage: t.deleteMessage } : {}) })),
    rows.map((t) => `${t.version.padEnd(14)} ${day(t.date)}  r${t.revision ?? '?'}  ${t.author}${t.deletedRevision ? `  DELETED in r${t.deletedRevision} ${t.deletedDate} by ${t.deletedBy}: ${t.deleteMessage.split('\n')[0].slice(0, 80)}` : ''}`).join('\n')
      + `\n${rows.length} tags${gone.length ? `, ${gone.length} of them deleted from SVN (still downloadable)` : ''}. The date is the last commit to the tag folder, normally its release.`);
}

async function download(slug, version, outRoot, json) {
  if (!version) {
    const p = await api(`action=plugin_information&request[slug]=${encodeURIComponent(slug)}&request[fields][sections]=0`);
    if (p.error === 'closed') {
      const tags = (await svnTags(slug)) || [];
      version = sortVersions(tags.map((t) => t.version)).pop() || 'trunk';
    } else if (p.error) fail(`api.wordpress.org: ${p.error}`);
    else version = p.version;
  }
  const r = await fetchCode(slug, version, outRoot);
  print(json, { slug, version, ...r }, `${r.cached ? 'already downloaded' : `downloaded ${r.files} files from ${r.source}`}\n${shown(r.dir)}`);
}

async function diff(slug, from, to, outRoot, json) {
  const [a, b] = await Promise.all([fetchCode(slug, from, outRoot), fetchCode(slug, to, outRoot)]);
  const outFile = join(outRoot, slug, `${from}..${to}.diff`);
  const stat = runDiff(join(outRoot, slug), from, to, outFile);
  print(json, { slug, from, to, diff: resolve(outFile), stat: stat && stat.trim() },
    `${(stat || '').trim() || 'no differences'}\nfull diff: ${shown(outFile)}`);
}

async function log(slug, limit, json) {
  const root = await propfind(`/${slug}/`);
  if (!root) fail(`no SVN repository for "${slug}"`);
  const head = root[0].revision;
  const items = await svnLog(`/${slug}/`, head, limit);
  print(json, items, items.map((i) => {
    const files = i.paths.map((p) => `${p.action[0].toUpperCase()} ${p.path.replace(`/${slug}/`, '')}`);
    const shown = files.length > 8 ? [...files.slice(0, 8), `… ${files.length - 8} more`] : files;
    return `r${i.revision}  ${i.date.slice(0, 10)}  ${i.author}  ${i.message.split('\n')[0].slice(0, 100)}\n    ${shown.join('\n    ')}`;
  }).join('\n'));
}

async function changeset(slug, rev, outRoot, json) {
  const [item] = await svnLog(`/${slug}/`, rev, 1, rev).catch((e) => (/HTTP 404/.test(e.message) ? [] : Promise.reject(e)));
  if (!item || item.revision !== rev) fail(`r${rev} did not touch ${slug}; run "log ${slug}" to list its revisions`);
  const before = join(outRoot, slug, `r${rev}`, 'before'), after = join(outRoot, slug, `r${rev}`, 'after');
  rmSync(join(outRoot, slug, `r${rev}`), { recursive: true, force: true });
  mkdirSync(before, { recursive: true });
  mkdirSync(after, { recursive: true });
  const files = item.paths.filter((p) => p.kind === 'file');
  const skipped = item.paths.filter((p) => p.kind !== 'file').map((p) => `${p.action} ${p.path}`);
  await Promise.all(files.map(async (f) => {
    const rel = f.path.replace(`/${slug}/`, '');
    const url = (r) => `${SVN}/!svn/bc/${r}${f.path.split('/').map(encodeURIComponent).join('/')}`;
    for (const [r, dir] of [[rev - 1, before], [rev, after]]) {
      if ((f.action === 'added' && r === rev - 1) || (f.action === 'deleted' && r === rev)) continue;
      const res = await request(url(r));
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`${url(r)}: HTTP ${res.status}`);
      const target = join(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    }
  }));
  const outFile = join(outRoot, slug, `r${rev}.diff`);
  const stat = runDiff(join(outRoot, slug, `r${rev}`), 'before', 'after', outFile);
  print(json, { slug, revision: rev, date: item.date, author: item.author, message: item.message, diff: resolve(outFile), skipped },
    [`r${rev} ${item.date.slice(0, 10)} ${item.author}: ${item.message.split('\n')[0]}`,
      (stat || '').trim() || 'no file changes',
      skipped.length ? `not diffed (folders or copies, e.g. a new tag): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ' …' : ''}` : '',
      `full diff: ${shown(outFile)}`].filter(Boolean).join('\n'));
}

async function find(args, json) {
  const min = Number(option(args, '--min', '0'));
  const max = Number(option(args, '--max', 'Infinity'));
  const tag = option(args, '--tag'), search = option(args, '--search'), author = option(args, '--author');
  const within = option(args, '--updated-within');
  const limit = Number(option(args, '--limit', '50'));
  const sortBy = option(args, '--sort', args.includes('--search') ? 'relevance' : 'installs');
  if (!['installs', 'updated', 'relevance'].includes(sortBy)) fail('--sort must be installs, updated or relevance');
  if (Number.isNaN(min) || Number.isNaN(max) || min > max) fail('--min and --max must be numbers with min <= max');
  const cutoff = within ? Date.now() - Number(within) * 86400000 : null;
  const fit = (v) => {
    const [lo, hi] = installRange(v);
    if (lo >= min && hi <= max) return 'yes';
    if (lo <= max && hi >= min) return 'maybe';
    return null;
  };
  const filter = tag ? `request[tag]=${encodeURIComponent(tag)}` : search ? `request[search]=${encodeURIComponent(search)}` : author ? `request[author]=${encodeURIComponent(author)}` : 'request[browse]=popular';
  const perPage = search ? 100 : 250;
  const page = (n) => api(`action=query_plugins&${filter}&request[per_page]=${perPage}&request[page]=${n}&${LIGHT_FIELDS}`);
  let first = 1, last;
  const firstPage = await page(1);
  if (firstPage.error) fail(`api.wordpress.org: ${firstPage.error}`);
  last = firstPage.info.pages || 1;
  if (search) last = Math.min(last, 5);
  if (!tag && !search && !author) {
    let lo = 1, hi = last;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const p = await page(mid);
      const tail = p.plugins[p.plugins.length - 1]?.active_installs ?? 0;
      if (tail > max) lo = mid + 1; else hi = mid;
    }
    first = Math.max(1, lo - 1);
  }
  const hits = [];
  let scanned = 0, stop = false;
  for (let n = first; n <= last && !stop; n += 4) {
    const batch = await Promise.all([n, n + 1, n + 2, n + 3].filter((x) => x <= last).map((x) => (x === 1 ? firstPage : page(x))));
    for (const p of batch) {
      for (const x of p.plugins) {
        scanned++;
        const f = fit(x.active_installs);
        const updated = parseUpdated(x.last_updated);
        if (f && (!cutoff || (updated && updated.getTime() >= cutoff))) {
          hits.push({ slug: x.slug, installs: x.active_installs, fit: f, version: x.version, updated: x.last_updated.slice(0, 10), tested: x.tested, name: x.name });
        }
      }
      const tail = p.plugins[p.plugins.length - 1]?.active_installs ?? 0;
      if (!tag && !search && !author && installRange(tail)[1] < min) stop = true;
    }
    if (sortBy !== 'updated' && hits.filter((h) => h.fit === 'yes').length >= limit) stop = true;
  }
  const order = sortBy === 'updated' ? (a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0) : sortBy === 'relevance' ? () => 0 : (a, b) => b.installs - a.installs;
  const shown = hits.sort((a, b) => (a.fit === b.fit ? order(a, b) : a.fit === 'yes' ? -1 : 1)).slice(0, limit);
  print(json, shown, shown.map((h) => `${h.fit === 'yes' ? ' ' : '?'} ${h.slug.padEnd(48)} ${fmt(h.installs).padStart(10)}+  ${h.version.padEnd(10)} ${h.updated}  WP ${h.tested}`).join('\n')
    + `\n${shown.length} shown (${hits.length} matched, ${scanned} plugins scanned of ${firstPage.info.results} in the listing). "?" = the rounded install count may fall outside ${fmt(min)}–${fmt(max)}.`);
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  const outRoot = resolve(option(rest, '--out', 'wp-plugins'));
  const [cmd, ...pos] = rest;
  if (!cmd || cmd === '--help' || cmd === 'help') { console.error(USAGE); process.exit(cmd ? 0 : 1); }
  const slug = pos[0] && pos[0].toLowerCase();
  const need = (n) => { if (pos.length < n) fail(`${cmd} needs ${n} argument${n > 1 ? 's' : ''}\n${USAGE}`); };
  try {
    if (cmd === 'info') { need(1); await info(slug, json); }
    else if (cmd === 'versions') { need(1); await versionsCmd(slug, json); }
    else if (cmd === 'download') { need(1); await download(slug, pos[1], outRoot, json); }
    else if (cmd === 'diff') { need(3); await diff(slug, pos[1], pos[2], outRoot, json); }
    else if (cmd === 'log') { need(1); await log(slug, Number(option(rest, '--limit', '20')), json); }
    else if (cmd === 'changeset') { need(2); await changeset(slug, Number(String(pos[1]).replace(/^r/, '')), outRoot, json); }
    else if (cmd === 'find') { await find(rest.slice(1), json); }
    else fail(`unknown command "${cmd}"\n${USAGE}`);
  } catch (e) {
    fail(e.message);
  }
}

main();
