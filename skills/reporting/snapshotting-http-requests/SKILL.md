---
name: snapshotting-http-requests
description: Renders an HTTP request and response as a Burp-style snapshot PNG for a bug bounty or pentest report, with the evidence boxed, notes, and secrets blurred. Use when a finding needs a request/response screenshot, proof image, or "Burp screenshot" without Burp.
---

# Snapshotting HTTP requests

A snapshot is one PNG of a real exchange: header bar with method, URL and status, the request and response panes with Burp's colours, numbered marks with notes, and secrets blurred. Both scripts need only Node 18+ and live in this skill's `scripts/` folder.

**Evidence rule:** a snapshot shows the exact bytes that were sent and received. Redaction, hiding noise headers, pretty-printing and trimming long bodies are the only changes, and the renderer makes them itself. When the evidence needs a different request, send that request and snapshot it.

## Steps

1. **Capture the exchange** into `request.txt` and `response.txt` in a working folder. Done when both files hold the raw messages, headers and body.
   - HTTP/1.1: write the raw request to `request.txt` (LF or CRLF line endings, any `Content-Length`), then run
     `node scripts/send.mjs request.txt [--url https://host:port]`.
     It sends the file as written, saves `response.txt`, and prints `timeMs` for the spec. It normalises line endings and fixes `Content-Length` in `request.txt` before sending, so the file stays equal to what went out. TLS certificates are not checked unless you pass `--verify-tls`.
   - HTTP/2 or anything curl does better: `curl -sS --http2 -v -i -o response.txt <args> URL 2> curl.log`, then `grep '^> ' curl.log | sed 's/^> //' > request.txt`, and append the request body (curl's log leaves it out).
   - Messages the user pasted, or exported from a proxy, go into the two files as they are.

2. **Write `spec.json`** next to the two files. Done when every piece of evidence the finding relies on has a mark, and every mark that needs explaining has a `note` written as the claim it proves.
   ```json
   {
     "request": "request.txt",
     "response": "response.txt",
     "title": "IDOR: any user's profile readable by ID",
     "timeMs": 142,
     "marks": [
       { "pane": "request", "match": "/api/users/1337", "note": "Another user's ID" },
       { "pane": "response", "key": "email", "note": "Victim's email returned" }
     ]
   }
   ```
   A mark picks its text with one selector: `match` (exact text; compact JSON also matches the pretty-printed body), `key` (JSON member), `header`, `param` (query, form or cookie) or `line`. Add `occurrence` for the nth hit. Every other option (theme, layout, legend, manual redaction, body window) is in [`reference/spec.md`](reference/spec.md).

3. **Render:** `node scripts/render.mjs spec.json [out.png] --text`. Done when it exits 0 and the printed summary shows each mark on the intended line and each secret in the exchange in the `redacted` list. A secret is any credential (session cookie, token, password, API key) and any personal data the finding does not rely on; add the ones auto-redaction missed under `redact`. Values the finding relies on stay visible, even personal data such as a leaked email; list them under `unredact` when auto-redaction hid them. A selector that matches nothing exits 1 and names it; fix the selector, not the evidence.

4. **Look at the PNG** with your image reader. Done when each box sits on its evidence, no callout covers code or line numbers, nothing secret is readable, and every warning in the summary is resolved or acceptable. When callouts land outside the card with long leader lines across the panes, switch to `"notes": "legend"` or `"layout": "stacked"`. Adjust the spec and render again until all four hold.

5. **Hand over** the PNG path, plus the `request.txt`, `response.txt` and `spec.json` that produced it, so the snapshot can be re-rendered.
