<div align="center">

# estimating-patchstack-bounties

*What a WordPress finding is worth on Patchstack, in XP and dollars*

[What it can do](#what-the-agent-can-do) • [Installation](#installation) • [Usage](#usage) • [Limitations](#limitations)

</div>

An agent skill that prices a WordPress plugin or theme vulnerability for the [Patchstack bug bounty](https://patchstack.com/bug-bounty/). It pairs with [estimating-wordfence-bounties](estimating-wordfence-bounties.md), so you can compare the two programs before choosing where to report. Patchstack's monthly payouts are a share of a pool, not a fixed price, so the skill pulls live data instead of carrying a snapshot: install counts from wordpress.org, VDP status from Patchstack's own API, and each month's pool and total XP from the public leaderboards.

## What the agent can do

With this skill loaded, an agent can:

- check a finding against Patchstack's scope rules as updated on 2026-10-01
- look up a plugin's or theme's installs, VDP status and XP bonus
- compute XP with the formula Patchstack actually uses, and convert it to dollars at recent rates
- show how the rate per XP has moved month by month
- flag findings that could earn a flat zero-day bounty instead

## Installation

The agent needs Node 18 or later and web access. Install just this skill:

```bash
npx skills@latest add noverdy/skills --skill estimating-patchstack-bounties
```

It also comes with the whole collection; see [Installation](../../README.md#installation). The skill itself lives in [`skills/reporting/estimating-patchstack-bounties`](../../skills/reporting/estimating-patchstack-bounties).

## Usage

```text
What would Patchstack pay for an unauthenticated file upload to RCE in file-manager-advanced?
```

```text
$ node scripts/patchstack.mjs estimate --slug file-manager-advanced --cvss 9.8 --type file-upload --priv unauth
Advanced File Manager – …: 100,000+ installs, VDP yes
passes the role, install and AC:H checks; check the impact rules in reference/scope.md by hand
XP = 9.8 × 4 (100K+) × 2 (Unauthenticated) × 3 (Arbitrary file upload) × 1 × 1.15 = 270.48
≈ $303 at september-2026's rate ($1.122/XP); $212–$350 over the last 6 finished months
before your monthly rejection-rate reduction, and paid only as a share of that month's pool
zero-day candidate: $2,600 flat (100,000+ installs) if it is full site compromise with a working exploit, …
```

## Limitations

- **Dollar figures are estimates.** A monthly payout is your share of that month's XP pool minus your rejection rate, so the real amount depends on everyone else's reports that month.
- **The 10M+ multiplier is inferred.** Patchstack doesn't publish a multiplier above ×10 (5M+). The ×15 used for 10M+ comes from Elementor's published XP.
- **Premium installs need your input.** Patchstack estimates premium installs from third-party sources; pass `--installs` with your best figure.
- **The rules change.** The October 2026 update changed scope, so check the guidelines when a decision is close.

<details>
<summary>What the research found</summary>

- **The formula multiplies.** The guidelines say multipliers are "added" to the CVSS base score, but published XP matches `CVSS × installs × privilege × type × penalty × VDP` for 262 of 264 reports since July 2025. That's 400+ reports in total, collected from top researchers' public profiles, each of which lists CVSS and XP per report. The two misses fit once the plugin's install count at report time is used.
- **Unlisted types use ×1.** XSS, broken access control, IDOR, sensitive data exposure and SSRF are not in the type table.
- **The VDP bonus is ×1.15**, or ×1.35 for the five products featured on the [VDP directory](https://patchstack.com/database/vdp) (Elementor, Elementor Pro, Activity Log, Document Library Pro, Progress Planner). The leaderboard advertises the +15%; the +35% is visible only in published XP.
- **VDP status for any slug**, no login needed: `https://vdp-api.patchstack.com/reports/vdp-eligibility?slug=<slug>` returns `{"vdp":true|false}`.
- **Monthly data:** the leaderboard pages embed every month's pool, and each researcher's XP, report counts and rejection rate, in their Nuxt payload. Dollars per XP fell from $1.82–3.69 in 2025 to $0.79–1.12 from May 2026. Pools in June to August 2026 were $5,300, below the advertised $10,000 minimum.

</details>
