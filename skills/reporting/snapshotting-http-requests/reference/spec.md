# spec.json reference

Paths are relative to the spec file. An unknown field is an error, so a typo fails loudly.

## Messages

| Field | Default | Meaning |
|---|---|---|
| `request` | required | Path to the raw request. `requestText` takes the raw text inline instead. |
| `response` | none | Path to the raw response. `responseText` inline. Leave out for a request-only snapshot. |
| `scheme` | `https` | Used to build the URL in the header bar when the request line has only a path. |
| `timeMs` | none | Response time shown in the header bar; `send.mjs` prints it. |

Chunked and gzip/deflate/br bodies are decoded for display; the headers still show what was sent. JSON is pretty-printed with every token kept as sent. Binary bodies show as `[binary body, N bytes]`.

## Marks

Each entry in `marks`:

| Field | Meaning |
|---|---|
| `pane` | `request` or `response`. Required. |
| `match` / `key` / `header` / `param` / `line` | The selector; exactly one. `header` and `param` box the whole `name: value` or `name=value`; `line` is the number in the gutter. |
| `occurrence` | Which hit, from 1. |
| `part` | `"value"` to box only the value of a `key`, `header` or `param`. |
| `note` | Text for the callout or legend. Marks without a note get a box only, no number. |
| `color` | `red`, `orange`, `amber`, `green`, `blue`, `purple` or `#rrggbb`. Default cycles in that order. |

A mark inside a long body pulls the visible window to it: the first marked body line is centred, with `… N lines above` and `… N more lines` rows.

## Redaction

On by default (`autoRedact`). It hides the values of `redactHeaders` (cookies one by one, `Authorization` after the scheme word) and of any query, form, cookie or JSON field whose name contains a `redactParams` word. A value of 12 characters or more keeps its last `revealChars` (4) so the reader can match it to other evidence.

| Field | Default | Meaning |
|---|---|---|
| `redact` | `[]` | Extra selectors to hide fully, e.g. `{ "pane": "response", "key": "email" }`. Defaults to the value part. |
| `unredact` | `[]` | Selectors whose automatic redaction is lifted, when the value itself is the evidence. |
| `redactStyle` | `blur` | `blur` draws blurred random characters, never the secret; `solid` draws a bar. |
| `redactHeaders` | Authorization, Proxy-Authorization, Cookie, Set-Cookie, X-Api-Key, X-Auth-Token, X-CSRF-Token, X-XSRF-Token | Replaces the list. |
| `redactParams` | password, passwd, secret, token, api_key, apikey, session | Replaces the list; matched as substrings, case-insensitive. |
| `revealChars` | `4` | Characters kept at the end of long redacted values; `0` hides all. |

## Look and layout

| Field | Default | Choices |
|---|---|---|
| `title` | none | Bold line above the header bar. |
| `caption` | none | Paragraph under the panes. |
| `theme` | `light` | `light`, `dark` |
| `layout` | `side` | `side` (panes side by side), `stacked` |
| `frame` | `report` | `report` (flat card), `showcase` (window dots, gradient backdrop, shadow) |
| `notes` | `callout` | `callout` (boxes beside the code), `legend` (numbered list under the panes) |
| `numberMarks` | `true` | Number badges on marks with notes in callout mode. |
| `lineNumbers` | `true` | Gutter line numbers. |
| `hideHeaders` | Sec-Ch-Ua\*, Sec-Fetch-\*, Accept-Language, Accept-Encoding, Priority, Upgrade-Insecure-Requests | Glob list of headers left out; replaces the list. |
| `showHeaders` | `[]` | Globs kept even when `hideHeaders` matches. |
| `prettyJson` | `true` | Re-indent JSON bodies. |
| `maxBodyLines` | `40` | Body rows shown per pane, at most 100. |
| `wrapColumns` | `100` | Long lines wrap at this column. |
| `bodyOffset` | `{}` | Rows to skip at the top of a body, e.g. `{ "response": 120 }`; overrides the automatic window. |
| `watermark` | `CONFIDENTIAL` | Tiled text; `{host}` and `{date}` are filled in. `false` turns it off. |
| `watermarkOpacity` | `12` | Percent. |

## Characters

The fonts cover ASCII, Latin-1 and a few symbols (`… • ✓ ✗ – — → ←`). Anything else, such as CJK text or emoji, is drawn as `?`, and the summary lists the characters it replaced.
