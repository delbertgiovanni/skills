#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync } from 'node:fs';
import net from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_VERSION = process.env.WP_LAB_CLI_VERSION || '3.1.54';
const ROLES = ['subscriber', 'contributor', 'author', 'editor'];

const USAGE = `usage: node lab.mjs <command> [options]

  start [plugin[@version] ...] [--theme slug[@version]] [--zip file.zip] [--mount-plugin dir]
        [--wp latest|6.8] [--php 8.3] [--port 9400]
                                start WordPress with those plugins active and one user per role
  status                        URL, WordPress and PHP versions, plugins and whether they are active
  login <role>                  log in; prints a Cookie value for curl -b (admin, subscriber, contributor,
                                author, editor, customer when WooCommerce is active)
  nonce <action> [--as role]    a nonce for an action, plus the REST nonce, for that role
  surface                       the plugins' and themes' AJAX actions, REST routes and shortcodes,
                                with handler file:line and REST permission callbacks
  php '<code>' | --file f.php   run PHP inside WordPress as admin, for setup: options, roles, posts
  log [--lines 40]              the PHP debug log
  stop                          stop the server

  --lab dir                     lab folder (default ./wp-lab)`;

function fail(message) {
  console.error(`lab: ${message}`);
  process.exit(1);
}

function option(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (i + 1 >= args.length) fail(`${name} needs a value`);
  return args.splice(i, 2)[1];
}

function options(args, name) {
  const out = [];
  for (let v = option(args, name); v != null; v = option(args, name)) out.push(v);
  return out;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function freePort(start) {
  return new Promise((ok) => {
    const s = net.createServer();
    s.once('error', () => ok(freePort(start + 1)));
    s.listen(start, '127.0.0.1', () => s.close(() => ok(start)));
  });
}

function spec(value) {
  const at = value.lastIndexOf('@');
  return at > 0 ? { slug: value.slice(0, at), version: value.slice(at + 1) } : { slug: value, version: null };
}

function zipUrl(kind, { slug, version }) {
  return `https://downloads.wordpress.org/${kind}/${slug}${version ? `.${version}` : ''}.zip`;
}

async function download(url, file) {
  if (existsSync(file) && statSync(file).size > 0) return true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return true;
    } catch (e) {
      if (attempt === 3) fail(`could not download ${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return false;
}

function loadState(lab) {
  const file = join(lab, 'state.json');
  if (!existsSync(file)) fail(`no lab in ${lab}; run "node lab.mjs start" first`);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (!alive(state.pid)) fail(`the lab server (pid ${state.pid}) is not running; run start again`);
  return state;
}

async function call(state, params, cookie, body) {
  const url = `${state.url}/wp-admin/admin-ajax.php?action=wp_lab&${new URLSearchParams(params)}`;
  const headers = cookie ? { Cookie: cookie } : {};
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? new URLSearchParams(body) : undefined, signal: AbortSignal.timeout(30000) }).catch((e) => fail(`the lab did not answer (${e.cause?.code || e.message}); a hung request may have used up its workers: run stop, then start`));
  const text = await res.text();
  try { return JSON.parse(text); } catch { fail(`unexpected answer from the lab (${res.status}): ${text.slice(0, 200)}`); }
}

async function login(state, role) {
  const user = role === 'admin' ? 'admin' : role;
  const pass = role === 'admin' ? 'password' : role;
  const res = await fetch(`${state.url}/wp-login.php`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'wordpress_test_cookie=WP%20Cookie%20check' },
    body: new URLSearchParams({ log: user, pwd: pass, testcookie: '1', 'wp-submit': 'Log In' }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status !== 302) fail(`login as ${role} failed (HTTP ${res.status}); roles: admin, ${state.users.join(', ')}`);
  const jar = new Map([['wordpress_test_cookie', 'WP%20Cookie%20check']]);
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function cookieFor(lab, role) {
  const file = join(lab, `cookie-${role}.txt`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
}

async function start(args, lab) {
  const wp = option(args, '--wp', 'latest');
  const php = option(args, '--php', '8.3');
  const port = await freePort(Number(option(args, '--port', '9400')));
  const themes = options(args, '--theme').map(spec);
  const zips = options(args, '--zip').map((z) => resolve(z));
  const dirs = options(args, '--mount-plugin').map((d) => resolve(d));
  const plugins = args.filter((a) => !a.startsWith('--')).map(spec);
  if (existsSync(join(lab, 'state.json'))) {
    const old = JSON.parse(readFileSync(join(lab, 'state.json'), 'utf8'));
    if (alive(old.pid)) fail(`a lab is already running at ${old.url} (pid ${old.pid}); run stop first`);
  }
  for (const z of zips) if (!existsSync(z)) fail(`no such zip: ${z}`);
  for (const d of dirs) if (!existsSync(d) || !statSync(d).isDirectory()) fail(`no such folder: ${d}`);
  mkdirSync(join(lab, 'cache'), { recursive: true });
  const missing = [];
  const fetched = async (kind, x) => {
    const name = `${kind}-${x.slug}${x.version ? `.${x.version}` : `.latest-${new Date().toISOString().slice(0, 10)}`}.zip`;
    if (!(await download(zipUrl(kind, x), join(lab, 'cache', name)))) missing.push(`${kind} ${x.slug}${x.version ? `@${x.version}` : ''}`);
    return `./cache/${name}`;
  };
  for (const p of plugins) p.zip = await fetched('plugin', p);
  for (const t of themes) t.zip = await fetched('theme', t);
  if (missing.length) fail(`not on downloads.wordpress.org: ${missing.join(', ')}`);

  mkdirSync(join(lab, 'mu-plugins'), { recursive: true });
  mkdirSync(join(lab, 'logs'), { recursive: true });
  copyFileSync(join(HERE, '..', 'assets', 'wp-lab.php'), join(lab, 'mu-plugins', 'wp-lab.php'));
  rmSync(join(lab, 'logs', 'debug.log'), { force: true });

  const steps = [];
  for (const p of plugins) steps.push({ step: 'installPlugin', pluginData: { resource: 'bundled', path: p.zip }, options: { activate: true } });
  for (const z of zips) {
    copyFileSync(z, join(lab, basename(z)));
    steps.push({ step: 'installPlugin', pluginData: { resource: 'bundled', path: `./${basename(z)}` }, options: { activate: true } });
  }
  for (const d of dirs) steps.push({ step: 'activatePlugin', pluginPath: `/wordpress/wp-content/plugins/${basename(d)}` });
  for (const t of themes) steps.push({ step: 'installTheme', themeData: { resource: 'bundled', path: t.zip }, options: { activate: true } });
  steps.push({
    step: 'runPHP',
    code: `<?php require '/wordpress/wp-load.php'; $roles = ${JSON.stringify(ROLES)}; if (get_role('customer')) { $roles[] = 'customer'; } foreach ($roles as $r) { if (!username_exists($r)) { wp_insert_user(array('user_login' => $r, 'user_pass' => $r, 'user_email' => $r . '@lab.test', 'role' => $r)); } } file_put_contents('/wordpress/wp-content/lab-logs/users.json', json_encode($roles));`,
  });
  writeFileSync(join(lab, 'blueprint.json'), JSON.stringify({ preferredVersions: { php, wp }, steps }, null, 2));

  const cli = [
    '-y', `@wp-playground/cli@${CLI_VERSION}`, 'server',
    '--port', String(port), '--wp', wp, '--php', php,
    '--blueprint', join(lab, 'blueprint.json'), '--blueprint-may-read-adjacent-files',
    '--mount', `${join(lab, 'mu-plugins')}:/wordpress/wp-content/mu-plugins`,
    '--mount', `${join(lab, 'logs')}:/wordpress/wp-content/lab-logs`,
    '--define', 'WP_DEBUG_LOG', '/wordpress/wp-content/lab-logs/debug.log',
    '--define-bool', 'WP_DEBUG', 'true', '--define-bool', 'WP_DEBUG_DISPLAY', 'false',
  ];
  for (const d of dirs) cli.push('--mount', `${d}:/wordpress/wp-content/plugins/${basename(d)}`);
  const logFile = join(lab, 'server.log');
  writeFileSync(logFile, '');
  const out = openSync(logFile, 'a');
  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', cli, { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    const log = readFileSync(logFile, 'utf8');
    if (log.includes('Ready!')) break;
    if (!alive(child.pid) || /Error:|error:|failed/i.test(log.split('\n').filter((l) => !/npm warn/i.test(l)).join('\n'))) {
      try { process.kill(-child.pid); } catch { }
      fail(`Playground did not start:\n${log.split('\n').filter((l) => l.trim() && !/npm warn/i.test(l)).slice(-15).join('\n')}`);
    }
    if (Date.now() - started > 300000) {
      try { process.kill(-child.pid); } catch { }
      fail(`Playground was not ready after 5 minutes; see ${logFile}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const usersFile = join(lab, 'logs', 'users.json');
  const users = existsSync(usersFile) ? JSON.parse(readFileSync(usersFile, 'utf8')) : ROLES;
  const state = { pid: child.pid, url, port, wp, php, plugins, themes, zips: zips.map((z) => basename(z)), mounted: dirs, users, started: new Date().toISOString() };
  writeFileSync(join(lab, 'state.json'), JSON.stringify(state, null, 2));
  const status = await call(state, { wp_lab: 'status' });
  console.log(`ready in ${Math.round((Date.now() - started) / 1000)} s: ${url}  (WordPress ${status.wordpress}, PHP ${status.php})`);
  for (const p of status.plugins) console.log(`  plugin ${p.file} ${p.version} ${p.active ? 'active' : 'INACTIVE'}`);
  console.log(`  theme ${status.theme.slug} ${status.theme.version}`);
  console.log(`users (password = user name): admin/password, ${users.join(', ')}`);
  const wanted = [...plugins.map((p) => p.slug), ...dirs.map((d) => basename(d)), ...zips.map((z) => basename(z).replace(/(\.\d[\w.-]*)?\.zip$/i, ''))];
  const inactive = status.plugins.filter((p) => !p.active && wanted.some((w) => p.file.startsWith(`${w}/`)));
  if (inactive.length) console.log(`warning: ${inactive.map((p) => p.file).join(', ')} did not activate; run "log" for PHP errors`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === 'help') {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }
  const lab = resolve(option(args, '--lab', 'wp-lab'));
  if (command === 'start') return start(args, lab);
  if (command === 'stop') {
    const file = join(lab, 'state.json');
    if (!existsSync(file)) fail(`no lab in ${lab}`);
    const state = JSON.parse(readFileSync(file, 'utf8'));
    try { process.kill(-state.pid); } catch { try { process.kill(state.pid); } catch { } }
    rmSync(file);
    for (const role of ['admin', ...state.users]) rmSync(join(lab, `cookie-${role}.txt`), { force: true });
    console.log(`stopped ${state.url}`);
    return;
  }
  if (command === 'log') {
    const lines = Number(option(args, '--lines', '40'));
    const file = join(lab, 'logs', 'debug.log');
    if (!existsSync(file)) return console.log('debug log is empty');
    console.log(readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n'));
    return;
  }
  const state = loadState(lab);
  if (command === 'status') {
    const s = await call(state, { wp_lab: 'status' });
    console.log(`${state.url}  WordPress ${s.wordpress}, PHP ${s.php}`);
    for (const p of s.plugins) console.log(`  plugin ${p.file} ${p.version} ${p.active ? 'active' : 'INACTIVE'}`);
    console.log(`  theme ${s.theme.slug} ${s.theme.version}`);
    console.log(`users: admin/password, ${state.users.join(', ')} (password = user name)`);
  } else if (command === 'login') {
    const role = args[0];
    if (!role) fail('login needs a role');
    const cookie = await login(state, role);
    writeFileSync(join(lab, `cookie-${role}.txt`), cookie + '\n');
    const who = await call(state, { wp_lab: 'whoami' }, cookie);
    if (who.user !== (role === 'admin' ? 'admin' : role)) fail(`logged in, but the session is not recognised (${JSON.stringify(who)})`);
    console.log(`logged in as ${who.user} (${who.roles.join(', ')}); cookie saved to ${join(lab, `cookie-${role}.txt`)}`);
    console.log(`use: curl -b "$(cat ${join(lab, `cookie-${role}.txt`)})" ${state.url}/...`);
  } else if (command === 'nonce') {
    const role = option(args, '--as');
    const action = args[0];
    if (!action) fail('nonce needs the action name the plugin passes to wp_verify_nonce or check_ajax_referer');
    let cookie = null;
    if (role) cookie = cookieFor(lab, role) || (await login(state, role));
    if (role) writeFileSync(join(lab, `cookie-${role}.txt`), cookie + '\n');
    const n = await call(state, { wp_lab: 'nonce', nonce_action: action }, cookie);
    console.log(JSON.stringify({ as: n.user || 'logged out', action: n.action, nonce: n.nonce, rest_nonce: n.rest_nonce }));
    if (!role) console.error('lab: logged-out nonces are shared by every visitor; pass --as <role> for a user\'s nonce');
  } else if (command === 'php') {
    const file = option(args, '--file');
    const code = file ? readFileSync(resolve(file), 'utf8') : args[0];
    if (!code) fail("php needs code, e.g. php 'update_option(\"x\", 1); return get_option(\"x\");', or --file setup.php");
    const cookie = cookieFor(lab, 'admin') || (await login(state, 'admin'));
    writeFileSync(join(lab, 'cookie-admin.txt'), cookie + '\n');
    const r = await call(state, { wp_lab: 'php' }, cookie, { code });
    if (r.output) process.stdout.write(r.output.endsWith('\n') ? r.output : r.output + '\n');
    if (r.return !== undefined && r.return !== null) console.log(`return: ${JSON.stringify(r.return)}`);
    if (r.error) fail(r.error);
  } else if (command === 'surface') {
    const s = await call(state, { wp_lab: 'surface' });
    const row = (x) => `${x.file}:${x.line}`;
    const checks = (c) => !c ? '' : `  [nonce: ${c.nonce.length ? c.nonce.join(' | ') : 'NONE'}; cap: ${c.caps.length ? c.caps.join(' | ') : 'NONE'}]`;
    console.log(`AJAX actions (${s.ajax.length}):`);
    for (const a of s.ajax.sort((x, y) => Number(y.nopriv) - Number(x.nopriv) || x.action.localeCompare(y.action))) console.log(`  ${a.nopriv ? 'NOPRIV' : 'priv  '} ${a.action.padEnd(36)}${checks(a.checks)}  ${a.handler}  ${row(a)}`);
    console.log(`REST routes (${s.rest.length}):`);
    for (const r of s.rest) console.log(`  ${r.methods.padEnd(16)} ${r.route.padEnd(45)} permission: ${r.permission}${checks(r.checks)}  ${row(r)}`);
    console.log('[nonce/cap] are the checks written in the handler body itself; helpers it calls are not followed.');
    console.log(`shortcodes (${s.shortcodes.length}):`);
    for (const c of s.shortcodes) console.log(`  [${c.tag}] ${c.handler}  ${row(c)}`);
  } else {
    fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((e) => fail(e.message));
