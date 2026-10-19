---
name: estimating-wordfence-bounties
description: Estimate the Wordfence bug bounty payout for a WordPress plugin or theme vulnerability, and check whether it is in scope. Use when pricing a finding, comparing which bug class or install band is worth hunting, or reading the Wordfence bounty estimator.
---

# Estimating Wordfence bounties

This copies the estimator at https://www.wordfence.com/threat-intel/bug-bounty-program/#rewards. The page
computes everything in the browser from one public config:

    https://www.wordfence.com/api/threat-intel/bounty-calculator-config

The tables below are a snapshot of that config taken on **2026-10-19**. They were checked against the live
estimator, including the advertised maximums of $31,200 (Standard) and $32,760 (1337).

## Steps

1. **Pin the four inputs.** Done when each one has exactly one value from the tables below:
   - researcher tier (Standard for a new account)
   - install band (wordpress.org active installs; for premium software, sales count as installs)
   - bug type (use the closest row in the bug type table)
   - login level the attacker needs
2. **Check eligibility.** The bounty is $0 if any of these holds:
   - the login level is Contributor/Author or higher
   - the install band's upper bound is below the **install floor**, which is the lower of the bug type's
     own floor and the tier's floor (see "Install floor" below)
3. **Compute both ends of the range** with the formula, using impact Low (×0.25) and Critical (×1).
   Done when you have a min and a max, each rounded up to a whole dollar and at least $5.
4. **Name the discounts** that apply on top of the estimate (see "What the estimate leaves out"), so the
   range is read as a ceiling, not a promise.

## Formula

```
bounty = ceil( max( 5,
           type_value
         × install_multiplier
         ÷ auth_divisor
         × impact_multiplier
         × (1 + tier_bonus) ) )
```

The config also carries a per-type bonus multiplier, threat-level multipliers, promotional values and a
global multiplier. In the snapshot they are all neutral (1, empty or null). When a fresh config shows a
`promotional_value` or `promotional_multiplier` on a type, the page shows a separate promotional estimate
using those numbers.

The range on the page is the formula at the four impact levels; Wordfence assigns the impact at triage.

## Reference

### Bug type value and install floor

| Bug type | Value | Floor for unauth or Subscriber |
|---|---|---|
| Remote code execution / code injection | 975 | 25 |
| Arbitrary file upload | 975 | 25 |
| Arbitrary options update | 975 | 25 |
| Authentication bypass to admin | 975 | 25 |
| Privilege escalation to admin | 975 | 25 |
| Arbitrary file deletion | 675 | 25 |
| Intentional backdoor | 480 | tier floor |
| Authentication bypass to non-admin | 300 | tier floor |
| Privilege escalation to non-admin | 300 | tier floor |
| Local / remote file include | 250 | tier floor |
| SQL injection | 200 | 500 |
| Arbitrary file read | 200 | 25 |
| Sensitive information disclosure | 200 | tier floor |
| Stored XSS | 120 | 500 |
| Directory traversal | 45 | tier floor |

### Install multiplier

| Installs | × |
|---|---|
| < 25 | 0 |
| 25 - 499 | 0.025 |
| 500 - 999 | 0.075 |
| 1,000 - 4,999 | 0.25 |
| 5,000 - 9,999 | 0.35 |
| 10,000 - 14,999 | 0.5 |
| 15,000 - 29,999 | 0.75 |
| 30,000 - 49,999 | 1 |
| 50,000 - 99,999 | 1.5 |
| 100,000 - 499,999 | 3 |
| 500,000 - 999,999 | 6 |
| 1,000,000 - 4,999,999 | 8 |
| 5,000,000+ | 24 |

Same table for every tier. Software under 1,000 installs must be on wordpress.org to count.

### Login level divisor

| Attacker needs | ÷ | Net effect |
|---|---|---|
| No login | 0.75 | × 1.33 |
| Subscriber / Customer / Student | 1.25 | × 0.8 |
| Contributor / Author | none | $0 |
| Shop Manager / Admin / Editor | none | $0 |

### Impact (set by Wordfence)

| Impact | × |
|---|---|
| Low | 0.25 |
| Medium | 0.5 |
| High | 0.75 |
| Critical | 1 |

### Researcher tier

| Tier | Bonus | Tier floor |
|---|---|---|
| Standard | 0 | 50,000 |
| Resourceful | 0 | 10,000 |
| 1337 | +5% | 500 |

### Install floor

The finding qualifies when the install band reaches the lower of two floors: the bug type's own floor (only
for unauth or Subscriber attackers, from the bug type table) and the tier floor. "Tier floor" in the bug type
table means the type has no floor of its own.

## Worked examples

| Case | Calculation | Low - Critical |
|---|---|---|
| Stored XSS, 1k-5k installs, no login, Standard | 120 × 0.25 ÷ 0.75 | $10 - $40 |
| SQLi, 1k-5k installs, Subscriber, Standard | 200 × 0.25 ÷ 1.25 | $10 - $40 |
| Auth bypass to admin, 5k-10k, no login, Standard | 975 × 0.35 ÷ 0.75 | $114 - $455 |
| Arbitrary file upload, 100k-500k, Subscriber, Standard | 975 × 3 ÷ 1.25 | $585 - $2,340 |
| RCE, 5M+, no login, 1337 | 975 × 24 ÷ 0.75 × 1.05 | $8,190 - $32,760 |

## What the estimate leaves out

The page lists these as reasons the real payout lands lower:

- a required setting or server configuration
- exploitation that is hard to reproduce or automate
- active user interaction, or unlikely passive interaction
- limited overall impact on the site's confidentiality, integrity or availability
- dependence on a bug in other software, usually paid at half or less

PHP object injection pays at full impact only with a newly documented, demonstrated gadget chain; otherwise
it pays at a lower rate.

## Refreshing the snapshot

Fetch the config URL and compare its `vulnerability_types`, `install_count_tiers`, `authentication_levels`,
`impact_levels` and `researcher_tiers` with the tables above. The formula lives in the page's
`/assets/site-*.js` bundle (search for `calculateAmount`). wordfence.com can answer plain HTTP clients with an
empty `202`; a headless browser loads it normally.
