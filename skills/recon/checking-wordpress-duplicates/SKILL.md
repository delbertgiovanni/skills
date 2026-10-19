---
name: checking-wordpress-duplicates
description: Checks whether a WordPress plugin or theme vulnerability is already known before it is reported, by merging Patchstack, Wordfence, NVD and optionally WPScan records for the slug and matching version range, bug type and parameter. Use before submitting a WordPress finding to Patchstack, Wordfence or a CVE request, or when asked whether a bug is new, a duplicate, or already patched.
---

# Checking WordPress duplicates

A duplicate earns nothing, and on Patchstack it also raises your rejection rate. `scripts/dupes.mjs` (Node 18+, no packages) collects every public record for a slug and marks which ones overlap your finding.

## Sources

| Source | Needs | What it gives |
|---|---|---|
| Patchstack | nothing | every disclosed issue for the slug, with type, affected and fixed versions, and CVE, from its public product page |
| Wordfence | Chrome or Chromium, or `WORDFENCE_API_KEY` | without a key, its public plugin page, rendered in headless Chrome (plain HTTP clients get an empty 202); with a free v3 key, the full feed, cached for 6 hours |
| NVD | nothing | CVE text, the only place that often names the vulnerable parameter, action or endpoint; about 5 requests per 30 seconds without a key |
| WPScan | `WPSCAN_API_TOKEN` | its own database; the free account allows about 25 requests a day, so it's off unless the token is set |

Every source only sees **disclosed** issues. A report still in triage at Patchstack, Wordfence or WPScan is invisible to all of them, so a clean result is "not publicly known", never "nobody has reported it".

## Steps

1. **Run the check** with what you know about the finding:
   ```
   node scripts/dupes.mjs check <slug> [--theme] --version <tested version> --type <type> --keyword <parameter|action|route|shortcode>
   ```
   `--version` takes a number, or `latest`. Repeat `--keyword` for each identifier involved; keywords match whole identifiers, so prefer specific names (`skip_onboarding`, `wpcf7_delete_file`) over generic words (`rest`, `nonce`). Done when the `sources:` line shows Patchstack, Wordfence and NVD with counts, not `FAILED`. If one failed, rerun once, then say in your answer which source is missing.

2. **Read the likely duplicates.** These records overlap your version and type, and mention at least one keyword. Open each link and compare the actual root cause: the same function, parameter or endpoint, and a role no stricter than yours. The script doesn't compare roles, so an Editor+ advisory can appear next to your unauthenticated finding. Done when each likely duplicate is labelled **same bug**, **same class but a different spot**, or **unrelated**, with the reason.

3. **Check the rest:**
   - The **same type, keyword not found** list: most advisories don't name the parameter or route, so a missing keyword match is weak evidence. Read each one: the Patchstack and Wordfence pages, the NVD text, and the plugin's changelog or the fix diff (`looking-up-wordpress-plugins` can diff the fixed version) usually show the root cause.
   - Under **other known issues**, look for a record whose fixed version is above the version you tested and that touches the same code. Your bug may be an incomplete fix of it. Patchstack counts an incomplete patch as new only if it opens a new attack vector.

   Done when nothing there describes your bug.

4. **Check the version.** Confirm the bug still exists in the plugin's latest version, which is printed on the first line. Both bounty programs only accept findings in the latest release. Done when you've tested the latest version, or said that you haven't.

5. **Give a verdict:**
   - **duplicate:** cite the CVE or link
   - **variant of a known issue:** say what differs
   - **not publicly known:** list the sources that were checked and any that were skipped
