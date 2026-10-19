---
name: receiving-oob-callbacks
description: Creates an out-of-band callback host on the public interactsh servers and reports the DNS and HTTP hits the target makes to it. Use when confirming blind SSRF, blind XSS, XXE, blind command injection or any bug where the target must call out, or when the user mentions OAST, interactsh or Burp Collaborator.
---

# Receiving OOB callbacks

`scripts/oob.mjs` (Node 18+, no packages) registers an inbox on one of ProjectDiscovery's public interactsh servers (`oast.fun`, `oast.pro`, `oast.live`, `oast.site`, `oast.online`, `oast.me`), hands out callback hosts, and decrypts what arrives. Interactions are encrypted to a key only this inbox holds, but the server operator sees every DNS query and HTTP request to the host, so callback URLs carry markers, never secrets.

Run every command from the working folder: the inbox lives in `oob-state.json` there, and full interactions are appended to `oob-state.log`.

## Steps

1. **Open an inbox:** `node scripts/oob.mjs new`. It tries the servers in turn and prints the base `host`. Done when a host is printed; tell the user which server it is on.

2. **Make one payload per injection point:** `node scripts/oob.mjs payload <tag>`, with a tag naming the parameter or location (`avatar-url`, `xml-doctype`, `cmd-ping`). It prints three forms; start with `https`, the one most fetchers accept, and add the others where it fits less well. Done when every place you inject has its own tag, so a hit names its source.
   - `https` (`https://<id>.oast.fun/<tag>`, tag in the path): the only form with a valid certificate. Use it for blind XSS (an https page will not load an http script), and for SSRF or webhooks where the fetcher may check TLS.
   - `http` (`http://<tag>.<id>.oast.fun/`): SSRF, XXE external entities and URL fetchers that accept plain http.
   - `host` (`<tag>.<id>.oast.fun`): command injection and anything DNS-only, e.g. `nslookup <host>`; DNS often gets out where HTTP is blocked.
   The tagged subdomain forms fail TLS checks (the certificate is a one-level wildcard), so never put a tagged host behind `https://`.

3. **Inject, then wait:** `node scripts/oob.mjs poll --wait 60`. It returns as soon as anything arrives, one JSON line per hit, or `{"interactions":0}` after the wait. Done when hits are listed or the wait ran out. Blind XSS can fire hours later when someone opens the page: keep `oob-state.json` and poll again later instead of opening a new inbox.

4. **Read the evidence.** Done when the claim you report matches the strongest hit, by tag and time:
   - `http` with `from` an address of the target: the target made the request. `oob-state.log` holds the raw request with path, headers and user agent.
   - `dns`: something resolved the name. `from` is a DNS resolver (the target's provider, Google, Cloudflare), never proof of the target's own address, so DNS alone proves the payload was processed, not that the target can reach out over HTTP.
   - One action yields many DNS hits: several resolvers, `A` plus `AAAA`/`TXT`/`NS`, and untagged hits on the bare `<id>` from resolvers walking the name label by label. Count them as one event.
   - `from` equal to your own address is either your own test or a target that shares your network (a local or VPN target). Tell them apart by the `User-Agent` and headers in the log and by timing against your injection.
   - Hits with no matching tag and time, often scanners, are noise.

5. **Close** with `node scripts/oob.mjs close` once the finding is confirmed and no delayed callbacks are expected. Done when it prints `closed`.

When no server accepts the registration, or polls keep failing, report that the public servers are unavailable with the error list; a self-hosted interactsh server works with `new --server <host> --token <token>`.
