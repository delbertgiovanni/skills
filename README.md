<div align="center">

# Skills

*Agent skills I actually use for bug bounty and pentesting*

[Installation](#installation) • [Layout](#layout) • [Skills](#skills) • [Rules of engagement](#rules-of-engagement)

</div>

These are small agent skills, each built for one job that keeps coming up during bug bounty hunting and pentests. They're plain Markdown and work with any agent that supports skills (Claude Code, Codex, Gemini CLI and others). I only add a skill once I've used it on real work.

## Installation

**Claude Code**: add this repo as a plugin marketplace, then install the plugin:

```bash
claude plugin marketplace add noverdy/skills
claude plugin install noverdy-skills@noverdy
```

**Other agents**: use the [skills CLI](https://skills.sh), and add `--skill <name>` to install just one:

```bash
npx skills@latest add noverdy/skills
```

**By hand**: clone the repo and symlink the skill folders you want into your agent's skills directory:

```bash
git clone https://github.com/noverdy/skills.git
ln -s "$PWD/skills/skills/reporting/snapshotting-http-requests" ~/.claude/skills/snapshotting-http-requests
```

## Layout

- `skills/<category>/<name>/` holds only what the agent loads: `SKILL.md` and the files it points to.
- `docs/<category>/<name>.md` is the human write-up for each skill: what it does, usage and limitations.
- `scripts/` holds repo tooling, such as the build script for the snapshot skill's glyph atlas.
- `.claude-plugin/` makes the repo installable as a Claude Code plugin; `plugin.json` lists every skill.

## Skills

### Recon

- **[looking-up-wordpress-plugins](docs/recon/looking-up-wordpress-plugins.md)**: looks up a wordpress.org plugin's real install range and Wordfence band, its versions (including closed plugins and deleted malicious releases), the code of any version, and what a patch changed, all over plain HTTPS. Also lists plugins to hunt in an install band. *Needs Node 18+, no npm packages.*

### Accounts and access

- **[receiving-temp-email](docs/accounts/receiving-temp-email.md)**: creates a throwaway inbox (Mail.tm, with Maildrop as backup) and reads the verification code or magic link from it. Useful for making extra test accounts on a target, e.g. for IDOR or access-control testing. *Needs `curl`.*

### Testing

- **[receiving-oob-callbacks](docs/testing/receiving-oob-callbacks.md)**: gives the agent its own out-of-band callback host on the public interactsh servers to confirm blind SSRF, blind XSS, XXE and blind command injection, with tagged payloads so each hit names its injection point. *Needs Node 18+, no npm packages.*

### Triage and reporting

- **[estimating-wordfence-bounties](docs/reporting/estimating-wordfence-bounties.md)**: estimates the Wordfence bug bounty payout for a WordPress plugin or theme vulnerability and checks whether it's in scope, using a snapshot of Wordfence's estimator config. Useful for pricing a finding or deciding which bug classes and install bands are worth hunting.
- **[estimating-patchstack-bounties](docs/reporting/estimating-patchstack-bounties.md)**: estimates what a WordPress plugin or theme finding earns on Patchstack, as XP and dollars, from live install, VDP and leaderboard data, checks scope and flags flat zero-day bounties. Useful for deciding between Patchstack and Wordfence. *Needs Node 18+, no npm packages.*
- **[snapshotting-http-requests](docs/reporting/snapshotting-http-requests.md)**: renders a request and response as a Burp-style PNG for the report, with the evidence boxed, numbered notes and secrets blurred. Also sends raw HTTP/1.1 requests exactly as written. *Needs Node 18+, no npm packages.*

## Rules of engagement

Use these skills only on targets you're authorized to test: an in-scope bug bounty program, or a pentest with written permission. Follow the program's rules, such as limits on how many test accounts you create or how fast you send requests.
