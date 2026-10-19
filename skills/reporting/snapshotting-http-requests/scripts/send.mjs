#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

const USAGE = `usage: node send.mjs request.txt [--url https://host:port] [--out response.txt] [--timeout 30] [--verify-tls]

Sends the raw HTTP/1.1 request in request.txt exactly as written and saves the raw response.
The host, port and scheme come from --url, or from the Host header over https.
If Content-Length does not match the body, it is corrected in request.txt before sending,
so the file always matches what was sent.`;

function fail(message) {
  console.error(`send: ${message}`);
  process.exit(1);
}

function option(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (i + 1 >= args.length) fail(`${name} needs a value`);
  return args.splice(i, 2)[1];
}

function splitMessage(buf) {
  let at = buf.indexOf('\r\n\r\n'), sep = 4;
  const lf = buf.indexOf('\n\n');
  if (at < 0 || (lf >= 0 && lf < at)) { at = lf; sep = 2; }
  if (at < 0) return { head: buf.toString('latin1').replace(/\r?\n$/, ''), body: Buffer.alloc(0) };
  return { head: buf.subarray(0, at).toString('latin1'), body: buf.subarray(at + sep) };
}

function prepare(raw) {
  const { head, body } = splitMessage(raw);
  const lines = head.split(/\r?\n/);
  const first = lines[0].match(/^(\S+)\s+(\S+)\s+(HTTP\/[\d.]+)$/);
  if (!first) fail(`the first line must look like "GET /path HTTP/1.1", got ${JSON.stringify(lines[0])}`);
  if (first[3] !== 'HTTP/1.1' && first[3] !== 'HTTP/1.0') {
    fail(`send.mjs speaks HTTP/1.x only; change ${first[3]} to HTTP/1.1, or use curl for HTTP/2 (see SKILL.md)`);
  }
  const notes = [];
  const index = (name) => lines.findIndex((l, i) => i > 0 && l.toLowerCase().startsWith(name.toLowerCase() + ':'));
  const cl = index('Content-Length');
  const chunked = index('Transfer-Encoding') > 0 && /chunked/i.test(lines[index('Transfer-Encoding')]);
  if (cl > 0) {
    const stated = Number(lines[cl].split(':')[1].trim());
    if (stated !== body.length) {
      lines[cl] = `Content-Length: ${body.length}`;
      notes.push(`Content-Length corrected from ${stated} to ${body.length}`);
    }
  } else if (body.length && !chunked) {
    lines.push(`Content-Length: ${body.length}`);
    notes.push(`Content-Length: ${body.length} added`);
  }
  const host = index('Host') > 0 ? lines[index('Host')].slice(5).trim() : '';
  const bytes = Buffer.concat([Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1'), body]);
  return { bytes, method: first[1], host, notes };
}

function framing(buf, method) {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const head = buf.subarray(0, end).toString('latin1');
  const status = Number((head.match(/^HTTP\/[\d.]+\s+(\d{3})/) || [])[1]);
  if (status >= 100 && status < 200 && status !== 101) return { skip: end + 4 };
  const bodyAt = end + 4;
  if (method === 'HEAD' || status === 204 || status === 304) return { complete: bodyAt };
  const cl = head.match(/^content-length:\s*(\d+)/im);
  if (/^transfer-encoding:.*chunked/im.test(head)) {
    let p = bodyAt;
    for (;;) {
      const e = buf.indexOf('\r\n', p);
      if (e < 0) return {};
      const size = parseInt(buf.subarray(p, e).toString('latin1'), 16);
      if (Number.isNaN(size)) return {};
      if (size === 0) {
        const t = buf.indexOf('\r\n\r\n', e - 2);
        return t < 0 ? {} : { complete: t + 4 };
      }
      p = e + 2 + size + 2;
      if (p > buf.length) return {};
    }
  }
  if (cl) return buf.length >= bodyAt + Number(cl[1]) ? { complete: bodyAt + Number(cl[1]) } : {};
  return {};
}

function send({ url, bytes, method, timeout, verify }) {
  return new Promise((resolveSend, rejectSend) => {
    const secure = url.protocol === 'https:';
    const port = Number(url.port) || (secure ? 443 : 80);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const socket = secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: verify, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host, port });
    let chunks = [], started = 0, done = false;
    const finish = (complete) => {
      if (done) return;
      done = true;
      socket.destroy();
      clearTimeout(timer);
      const all = Buffer.concat(chunks);
      if (!all.length) return rejectSend(new Error('the server closed the connection without a response'));
      resolveSend({ response: complete ? all.subarray(0, complete) : all, timeMs: Math.round(performance.now() - started), whole: !!complete });
    };
    const timer = setTimeout(() => {
      if (!chunks.length) { socket.destroy(); rejectSend(new Error(`no response within ${timeout} s`)); } else finish(0);
    }, timeout * 1000);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      started = performance.now();
      socket.write(bytes);
    });
    socket.on('data', (d) => {
      chunks.push(d);
      let all = Buffer.concat(chunks);
      let f = framing(all, method);
      while (f && f.skip) {
        all = all.subarray(f.skip);
        chunks = [all];
        f = framing(all, method);
      }
      if (f && f.complete) finish(f.complete);
    });
    socket.on('end', () => finish(Buffer.concat(chunks).length));
    socket.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); rejectSend(e); } });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) { console.error(USAGE); process.exit(args.length ? 0 : 1); }
  const verify = args.includes('--verify-tls');
  const rest = args.filter((a) => a !== '--verify-tls');
  const urlArg = option(rest, '--url');
  const out = option(rest, '--out');
  const timeout = Number(option(rest, '--timeout', '30'));
  if (rest.length !== 1) fail(USAGE);
  const file = rest[0];
  let raw;
  try { raw = readFileSync(file); } catch (e) { fail(`cannot read ${file}: ${e.message}`); }
  const req = prepare(raw);
  if (!urlArg && !req.host) fail('no Host header; pass --url https://host');
  const url = new URL(urlArg || `https://${req.host}`);
  if (!raw.equals(req.bytes)) writeFileSync(file, req.bytes);
  let result;
  try {
    result = await send({ url, bytes: req.bytes, method: req.method, timeout, verify });
  } catch (e) {
    fail(`${url.origin}: ${e.message}`);
  }
  const target = out || file.replace(/request(?=[^/]*$)/, 'response').replace(/^(?!.*response)(.*?)(\.[^./]*)?$/, '$1.response$2');
  writeFileSync(target, result.response);
  const status = Number((result.response.toString('latin1').match(/^HTTP\/[\d.]+\s+(\d{3})/) || [])[1]) || null;
  console.log(JSON.stringify({ status, timeMs: result.timeMs, bytes: result.response.length, response: target, complete: result.whole, notes: req.notes }));
}

main();
