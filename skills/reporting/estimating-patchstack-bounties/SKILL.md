---
name: estimating-patchstack-bounties
description: Estimate what a WordPress plugin or theme vulnerability earns on the Patchstack bug bounty, as XP and dollars, check it is in scope, and spot zero-day bounties. Use when pricing a finding for Patchstack, deciding between Patchstack and Wordfence, or reading Patchstack's XP, VDP or leaderboard rules.
---

# Estimating Patchstack bounties

Patchstack pays in two ways:
- **Monthly competition:** each valid report earns XP, and each month's pool is split by share of all researchers' XP, minus your rejection rate. A finding has no fixed price: its dollars depend on how much XP everyone else submits that month.
- **Zero-day program:** a flat bounty, separate from XP, for full site compromise by an unauthenticated or Subscriber attacker.

`scripts/patchstack.mjs` (Node 18+, no packages) reads live data: install counts from wordpress.org, VDP status from Patchstack's own API, and each month's pool and total XP from the public leaderboards. The rules below were checked on 2026-10-19 against the guidelines, which were updated on 2026-10-01, and against the published XP of 400+ real reports.

## Steps

1. **Pin the inputs.** Done when each has one value:
   - CVSS v3.1 **base** score and vector (from the FIRST calculator)
   - vulnerability type: one of the `--type` keys in `--help`
   - the lowest role the attacker needs
   - the plugin or theme slug, or for premium software, an install figure

2. **Look up the product:** `node scripts/patchstack.mjs product <slug>` (add `--theme` for themes). Done when you know its installs and VDP status. VDP software earns +15% XP, and Patchstack's featured VDP products earn +35%.

3. **Check scope** against [`reference/scope.md`](reference/scope.md). Done when the finding passes every rule there, or you can name the rule it breaks. These rules fail most often:
   - **Role:** only unauthenticated, Subscriber or Customer. Contributor counts only on VDP software. Author and above are always out.
   - **Installs:** at least 1,000, unless the software is in VDP.
   - **Version:** the latest version only, last updated within three years.
   - **Impact:** some types qualify only with a stated impact. For example, XSS must affect the whole site or be reflected, file bugs need full path and extension control, and IDOR must have real security impact; PII leakage alone doesn't count.

4. **Estimate:**
   ```
   node scripts/patchstack.mjs estimate --slug <slug> --cvss <score> --type <type> --priv <role> [flags]
   ```
   Done when it prints XP, a dollar range and any zero-day line. The script checks role, installs and AC:H only; the impact rules from step 3 stay your call. Add flags that match the vector:
   - `--ui-required` if the vector has UI:R
   - `--ac-high` if it has AC:H
   - `--poi-no-chain` for PHP object injection without a POP chain of your own
   - `--chain <type>` when CSRF leads to another type

   Each of the first three conditions halves XP; two or more cut it to a quarter. For premium software, pass `--installs N --vdp no|yes|boost` instead of `--slug`.

5. **Report the number with its limits.** Done when the user has:
   - the XP and the formula line
   - the dollar figure at the latest finished month's rate, plus the 6-month range
   - that the payout is a share of a pool and is cut by their rejection rate
   - any zero-day amount with its conditions. Zero-day and XP are alternatives, not added together: when the finding meets every zero-day condition, the flat amount is almost always worth more, so recommend submitting it as a zero-day.

## The formula

```
XP = CVSS base × installs × privilege × type × penalty × VDP
```

The guidelines describe the multipliers as "added" to CVSS, but published XP only matches multiplication: 262 of 264 reports since 2025-07 do.

- **Unlisted types use ×1:** XSS, broken access control, IDOR, sensitive data exposure, SSRF, settings changes and others.
- **10M+ installs:** the published table stops at ×10 for 5M+. Elementor's published XP fits ×15 for 10M+, so the script uses ×15 as a best guess from that one plugin. Treat XP for 10M+ software as approximate.

## Dollars per XP

Run `node scripts/patchstack.mjs rates` for current figures. They have moved a lot:

| Period | Monthly pool | $ per XP |
|---|---|---|
| 2025 | $10k–32k | $1.82–3.69 |
| 2026-01 to 04 | $14.5k–25k | $1.02–1.73 |
| 2026-05 to 08 | $5.3k–8.9k | $0.79–1.11 |
| 2026-09 | $10k | $1.12 |

## Zero-day bounties

| Installs | Unauthenticated | Subscriber |
|---|---|---|
| 1K+ | $250 | $125 |
| 5K+ | $400 | $200 |
| 10K+ | $600 | $300 |
| 50K+ | $1,400 | $700 |
| 100K+ | $2,600 | $1,300 |
| 500K+ | $4,900 | $2,450 |
| 1M+ | $7,200 | $3,600 |
| 3M+ | $10,800 | $5,040 |
| 5M+ | $14,400 | $7,200 |
| 10M+ | $24,000 | $12,000 |
| 15M+ or core | $33,000 | $16,500 |

To qualify, a finding needs all of:
- full site compromise, with a working exploit
- no other prerequisites, vulnerabilities or user interaction
- the latest version, on default settings
- software updated within three years
- not reported or disclosed anywhere before
- for object injection, a POP chain inside core or the component itself

Zero-day findings earn no XP.
