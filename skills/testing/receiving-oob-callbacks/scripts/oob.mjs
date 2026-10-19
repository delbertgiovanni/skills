#!/usr/bin/env node
import crypto from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SERVERS = ['oast.fun', 'oast.pro', 'oast.live', 'oast.site', 'oast.online', 'oast.me'];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const USAGE = `usage: node oob.mjs <command> [options]

  new [--server host] [--token t]   register an inbox; tries the public servers in turn
  payload [tag]                     print a callback host; the tag shows which injection fired
  poll [--wait seconds]             wait for interactions (default 60 s) and print them
  close                             deregister the inbox and delete its state file

  --state file                      state file (default oob-state.json in the current folder)`;

function fail(message) {
  console.error(`oob: ${message}`);
  process.exit(1);
}

function take(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (i + 1 >= args.length) fail(`${name} needs a value`);
  return args.splice(i, 2)[1];
}

function random(n) {
  return Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % 36]).join('');
}

function base(server) {
  return /^https?:\/\//.test(server) ? server.replace(/\/$/, '') : `https://${server}`;
}

function hostOf(server) {
  return new URL(base(server)).hostname;
}

async function call(state, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = state.token;
  const res = await fetch(base(state.server) + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 120).trim()}`);
  try { return JSON.parse(text); } catch { return {}; }
}

function load(file) {
  if (!existsSync(file)) fail(`no inbox in ${file}; run "node oob.mjs new" first`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function create(file, server, token) {
  if (existsSync(file)) fail(`${file} already holds an inbox; run "close" first or pass --state`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const errors = [];
  for (const candidate of server ? [server] : SERVERS) {
    const state = {
      server: candidate,
      token: token || null,
      correlationId: random(20),
      secret: crypto.randomUUID(),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      created: new Date().toISOString(),
    };
    try {
      await call(state, '/register', {
        'public-key': Buffer.from(pem).toString('base64'),
        'secret-key': state.secret,
        'correlation-id': state.correlationId,
      });
      state.host = `${state.correlationId}${random(13)}.${hostOf(candidate)}`;
      writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
      return { state, errors };
    } catch (e) {
      errors.push(`${candidate}: ${e.cause?.code || e.message}`);
    }
  }
  fail(`no server accepted the registration:\n  ${errors.join('\n  ')}`);
}

function decrypt(state, aesKey, item) {
  const key = crypto.privateDecrypt(
    { key: state.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(aesKey, 'base64'),
  );
  const raw = Buffer.from(item, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-ctr', key, raw.subarray(0, 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8'));
}

function summary(i, state) {
  const host = state.host;
  const full = (i['full-id'] || i['unique-id'] || '').toLowerCase();
  let tag = full.endsWith(host.split('.')[0]) ? full.slice(0, -host.split('.')[0].length).replace(/\.$/, '') : '';
  const path = (i['raw-request'] || '').match(/^\S+ \/([a-z0-9-]+)/i);
  if (!tag && i.protocol === 'http' && path && (state.tags || []).includes(path[1].toLowerCase())) tag = path[1].toLowerCase();
  const out = {
    time: i.timestamp,
    protocol: i.protocol,
    from: i['remote-address'],
    tag: tag || null,
  };
  out.host = `${full}.${state.server.replace(/^https?:\/\//, '').replace(/[:/].*$/, '')}`;
  if (i['q-type']) out.dnsType = i['q-type'];
  const first = (i['raw-request'] || '').split(/\r?\n/)[0];
  if (first && i.protocol !== 'dns') out.request = first.slice(0, 200);
  if (i['smtp-from']) out.smtpFrom = i['smtp-from'];
  return out;
}

async function poll(file, wait) {
  const state = load(file);
  const log = file.replace(/\.json$/, '') + '.log';
  const deadline = Date.now() + wait * 1000;
  let found = 0;
  for (;;) {
    let res;
    try {
      res = await call(state, `/poll?id=${state.correlationId}&secret=${state.secret}`);
    } catch (e) {
      if (/^(400|401|403|404)/.test(e.message)) fail(`${state.server} no longer knows this inbox (${e.message}); run "close", then "new"`);
      console.error(`oob: poll failed (${e.cause?.code || e.message}); retrying`);
      res = {};
    }
    const items = [...(res.data || []), ...(res.extra || [])];
    for (const item of items) {
      let interaction;
      try {
        interaction = res.aes_key ? decrypt(state, res.aes_key, item) : JSON.parse(item);
      } catch {
        console.error('oob: could not decrypt one interaction; skipped');
        continue;
      }
      appendFileSync(log, JSON.stringify(interaction) + '\n');
      console.log(JSON.stringify(summary(interaction, state)));
      found++;
    }
    if (found || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, Math.min(5000, Math.max(0, deadline - Date.now()))));
  }
  if (!found) console.log(JSON.stringify({ interactions: 0, waited: wait }));
  else console.error(`oob: full interactions (raw requests, DNS records) appended to ${log}`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === 'help') {
    console.error(USAGE);
    process.exit(command ? 0 : 1);
  }
  const file = resolve(take(args, '--state', 'oob-state.json'));
  if (command === 'new') {
    const { state, errors } = await create(file, take(args, '--server'), take(args, '--token'));
    for (const e of errors) console.error(`oob: skipped ${e}`);
    console.log(JSON.stringify({ server: state.server, host: state.host, state: file }));
  } else if (command === 'payload') {
    const state = load(file);
    const tag = (args[0] || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (tag && !(state.tags || []).includes(tag)) {
      state.tags = [...(state.tags || []), tag];
      writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
    }
    const host = tag ? `${tag}.${state.host}` : state.host;
    console.log(JSON.stringify({ host, http: `http://${host}/`, https: `https://${state.host}/${tag}` }));
  } else if (command === 'poll') {
    const wait = Number(take(args, '--wait', '60'));
    if (!(wait >= 0)) fail('--wait must be a number of seconds');
    await poll(file, wait);
  } else if (command === 'close') {
    const state = load(file);
    try {
      await call(state, '/deregister', { 'correlation-id': state.correlationId, 'secret-key': state.secret });
    } catch (e) {
      console.error(`oob: deregister failed (${e.cause?.code || e.message}); deleting the local state anyway`);
    }
    rmSync(file);
    console.log(JSON.stringify({ closed: state.host }));
  } else {
    fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main();
