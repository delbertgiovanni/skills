<div align="center">

# receiving-oob-callbacks

*Burp Collaborator for your agent, on the free interactsh servers*

[What it can do](#what-the-agent-can-do) • [Installation](#installation) • [Usage](#usage) • [Limitations](#limitations)

</div>

An agent skill that gives the agent its own out-of-band callback host, so it can confirm blind SSRF, blind XSS, XXE and blind command injection. It speaks the [interactsh](https://github.com/projectdiscovery/interactsh) protocol to ProjectDiscovery's public servers with a zero-dependency Node client, so there is no Go binary, account or API key to set up.

## What the agent can do

With this skill loaded, an agent can:

- open a private callback inbox on the first public interactsh server that answers
- hand out one tagged payload per injection point, so every hit names the parameter that fired
- pick the payload form that works: `https` with a valid certificate for blind XSS and TLS-checking fetchers, plain `http`, or a bare host for DNS-only channels
- wait for hits and decrypt them, with the raw HTTP request kept for the report
- tell a real callback from the target apart from resolver noise, its own tests and scanners
- keep the inbox for blind XSS that fires hours later, then close it

## Installation

The agent needs Node 18 or later. Install just this skill:

```bash
npx skills@latest add noverdy/skills --skill receiving-oob-callbacks
```

It also comes with the whole collection; see [Installation](../../README.md#installation). The skill itself lives in [`skills/testing/receiving-oob-callbacks`](../../skills/testing/receiving-oob-callbacks).

## Usage

Ask for blind testing in plain language:

```text
Check the webhook URL field for blind SSRF and tell me what the server sends.
```

The agent opens an inbox, makes a tagged payload, injects it and polls:

```text
$ node scripts/oob.mjs new
{"server":"oast.pro","host":"fzq1kkboopy6prke0aywpyeuem0cyiiv6.oast.pro", ...}
$ node scripts/oob.mjs payload webhook-url
{"host":"webhook-url.fzq1…oast.pro","http":"http://webhook-url.fzq1…oast.pro/","https":"https://fzq1…oast.pro/webhook-url"}
$ node scripts/oob.mjs poll --wait 60
{"protocol":"dns","from":"203.142.82.206","tag":"webhook-url","dnsType":"A", ...}
{"protocol":"http","from":"180.248.46.16","tag":"webhook-url","request":"GET / HTTP/1.1", ...}
```

> [!WARNING]
> The public servers belong to ProjectDiscovery. Interaction data is encrypted to your inbox's key, but the operator sees every lookup and request to your host. Callback URLs should carry markers, never secrets or target data.

## Limitations

- Only the bare `<id>.oast.*` host has a valid TLS certificate. Tagged subdomains work over http and DNS only, which is why the `https` payload carries its tag in the path.
- DNS hits show the resolver's address, not the target's. A DNS-only hit proves the payload was processed, not that the target can make HTTP requests.
- SMTP callbacks are decrypted like the others but were not tested.
- An inbox was verified to keep receiving hits 12 minutes after registration. How long the public servers keep an idle inbox, which matters for blind XSS that fires days later, was not tested.
- The public servers are free and make no uptime promises. A self-hosted interactsh server works with `new --server <host> --token <token>`.

<details>
<summary>What the research found</summary>

The protocol, verified against all six public servers (`oast.fun`, `oast.pro`, `oast.live`, `oast.site`, `oast.online`, `oast.me`) on 2026-10-19:

- `POST /register` with `{"public-key": base64(PEM SPKI RSA-2048), "secret-key": uuid, "correlation-id": 20 chars [a-z0-9]}`. The callback host is the correlation ID plus 13 more random characters, then the server's domain.
- `GET /poll?id=<correlation-id>&secret=<secret-key>` returns `data` (encrypted interactions), `extra` and `aes_key`. Polling removes what it returns.
- `aes_key` is RSA-OAEP with SHA-256. Each item in `data` is base64 of a 16-byte IV followed by **AES-256-CTR** ciphertext of a JSON interaction. Older write-ups say CFB; with CFB only the first 16 bytes decrypt correctly.
- `POST /deregister` with the correlation ID and secret closes the inbox.

Observed behaviour:

- Every server registered, and HTTP and DNS hits arrived in under a second.
- Resolvers that randomise letter case (DNS 0x20, e.g. Google Public DNS) send names like `DnS.LIVe2.U2TQ…`, so the client lowercases them before matching tags.
- One `curl` to a tagged host produced 2 to 9 DNS hits from different resolvers, including untagged queries for the bare ID from resolvers that look names up one label at a time (QNAME minimisation).
- The certificate is a one-level wildcard (`*.oast.pro`): `https://<id>.oast.pro/` verifies, `https://tag.<id>.oast.pro/` does not.

</details>
