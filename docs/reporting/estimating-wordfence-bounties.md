<div align="center">

# estimating-wordfence-bounties

*Price a WordPress plugin or theme finding before you write the report*

[What it can do](#what-the-agent-can-do) • [Installation](#installation) • [Usage](#usage) • [Limitations](#limitations)

</div>

An agent skill that reproduces the [Wordfence bug bounty estimator](https://www.wordfence.com/threat-intel/bug-bounty-program/#rewards) offline. It carries a snapshot of the estimator's public config and the formula the page uses, so the agent can work out a payout range, and whether a finding is in scope at all, without opening a browser.

## What the agent can do

With this skill loaded, an agent can:

- check a finding against the install floors and login-level rules, and say when it pays $0
- give the Low to Critical payout range for a bug type, install band, login level and researcher tier
- compare bug classes or install bands to decide which targets are worth hunting
- list the discounts Wordfence applies at triage, so the range reads as a ceiling
- refresh the snapshot from the live config when the numbers may have changed

## Installation

The skill needs no tools for estimating. Refreshing the snapshot needs web access, ideally a headless browser. Install just this skill:

```bash
npx skills@latest add noverdy/skills --skill estimating-wordfence-bounties
```

It also comes with the whole collection; see [Installation](../../README.md#installation). The skill itself lives in [`skills/reporting/estimating-wordfence-bounties`](../../skills/reporting/estimating-wordfence-bounties).

## Usage

Ask in plain language:

```text
What would Wordfence pay for an unauthenticated stored XSS in a plugin with 3k installs?
```

```text
Is a Subscriber-level SQLi in a 400-install plugin in scope for a Standard researcher?
```

The agent pins the inputs, checks eligibility and gives the range:

```text
Stored XSS, 1,000-4,999 installs, no login, Standard tier:
120 × 0.25 ÷ 0.75 → $10 (Low) to $40 (Critical).
```

## Limitations

- The tables are a snapshot taken on 2026-10-19. Wordfence can change values or run promotions at any time, so refresh the snapshot before relying on a number.
- The estimate is a ceiling. Wordfence sets the impact level at triage and pays less for findings that need special configuration, user interaction, or a bug in other software.
- wordfence.com sometimes answers plain HTTP clients with an empty `202`, so refreshing may need a headless browser.
