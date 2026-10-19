<div align="center">

# checking-wordpress-duplicates

*Find out whether your WordPress bug is already known, before a triager tells you*

[What it can do](#what-the-agent-can-do) • [Installation](#installation) • [Usage](#usage) • [Limitations](#limitations)

</div>

An agent skill that checks a WordPress plugin or theme finding against every public vulnerability source it can reach: Patchstack, Wordfence, NVD and optionally WPScan. It merges their records by CVE and marks which ones overlap the version you tested, the bug type, and the parameter or endpoint involved. A duplicate earns nothing on either bounty program, and on Patchstack it also raises your rejection rate.

## What the agent can do

With this skill loaded, an agent can:

- list every disclosed issue for a slug, merged across sources, with affected and fixed versions and CVE
- flag likely duplicates by version range, type, and keywords such as a parameter, AJAX action or REST route
- pick out records whose fix sits above your tested version, which may mean your bug is an incomplete patch
- read Wordfence with no API key, through a local headless Chrome, or through the v3 feed when a key is set
- say which sources it checked and which it skipped

## Installation

The agent needs Node 18 or later. Chrome or Chromium is needed to read Wordfence without an API key. Install just this skill:

```bash
npx skills@latest add noverdy/skills --skill checking-wordpress-duplicates
```

It also comes with the whole collection; see [Installation](../../README.md#installation). The skill itself lives in [`skills/recon/checking-wordpress-duplicates`](../../skills/recon/checking-wordpress-duplicates).

Optional keys, set as environment variables:

- `WORDFENCE_API_KEY`: free, from the Integrations section of your wordfence.com account. It replaces the headless-browser read with the official feed.
- `WPSCAN_API_TOKEN`: free, from a wpscan.com account (about 25 requests a day). It adds WPScan's database.

## Usage

```text
I found a broken access control bug in file-manager-advanced 5.4.14. Is it already known?
```

```text
$ node scripts/dupes.mjs check file-manager-advanced --version 5.4.14 --type bac
Advanced File Manager – … (plugin file-manager-advanced), latest 6.0.0
sources: wpscan skipped, patchstack 13, wordfence 11, nvd 7

LIKELY DUPLICATES (1): known issues matching your version, type and at least one keyword
  2026-10-16  CVE-2026-110365  6.5  Broken Access Control vulnerability
      affected v ≤ 5.4.14, fixed 6.0.0  [patchstack]  version ✓ type ✓
      https://patchstack.com/database/wordpress/plugin/file-manager-advanced/vulnerability/…

other known issues (12):
  2026-08-28  CVE-2026-11565   7.5  Authenticated Arbitrary File Read and Write via fma_load_fma_ui vulnerability
      affected v < 5.4.13, fixed 5.4.13  [patchstack, wordfence, nvd]  version ✗ type ✓
  …
```

The agent then opens each likely duplicate and compares the root cause and the required role before giving a verdict.

## Limitations

- **Only disclosed issues are visible.** Reports still in triage at any program can't be seen, so "not publicly known" is the strongest possible answer.
- **Type and keyword matching is text matching.** Advisories often describe the same bug in different words, so the agent still reads the near misses.
- **Roles aren't compared.** An Editor+ advisory can be flagged next to an unauthenticated finding.
- **The keyless Wordfence route needs a browser.** It depends on a local Chrome and on Wordfence continuing to render for headless browsers. A free API key avoids both.
- **Some sources were never tested.** The WPScan path and the Wordfence v3 feed path were built from their documentation but not run, because no keys were available.

<details>
<summary>What the research found</summary>

Checked on 2026-10-19:

- **Patchstack:** `patchstack.com/database/wordpress/{plugin|theme}/<slug>` embeds every disclosed issue in its `__NUXT_DATA__` payload, with no pagination: the list length always equals the page's own patched plus unpatched count, for example 42 for Elementor. It includes issues first published by other databases. The per-issue pages add only a one-line generic description, with no parameter or endpoint details.
- **Wordfence:**
  - The v1 and v2 feeds return **410 Gone**.
  - v3 (`/api/intelligence/v3/vulnerabilities/production` and `/scanner`) needs `Authorization: Bearer <key>`, with a free key from the Integrations section of a wordfence.com account. Both feeds return the whole database with no filters, and too many requests get a 429.
  - The public pages (`/threat-intel/vulnerabilities/wordpress-plugins/<slug>`) return an empty **202** to curl and other plain clients, but render fully in headless Chrome, listing each advisory's title, CVSS, CVE, date and researcher. Unknown slugs render a normal "404 Page Not Found".
- **WPScan:** `/api/v3/plugins/<slug>` returns 403 without a token. The free plan is widely reported as 25 requests a day.
- **NVD:**
  - `keywordSearch` works without a key. A query for the slug finds CVEs that Patchstack wrote; a query for the plugin name finds those from Wordfence and WPScan.
  - A plugin name like "Contact Form 7" also matches dozens of add-ons, so the name must open the description ("The Contact Form 7 plugin …"), and the slug must stand alone, not inside a REST route.
  - NVD's CPEs are sometimes assigned to the wrong plugin, so they are used only for version ranges, never to decide which plugin a CVE belongs to.
- **Ruled out:** OSV has no WordPress ecosystem. GitHub's advisory database can only be searched by CVE ID, so it adds nothing NVD doesn't have.

</details>
