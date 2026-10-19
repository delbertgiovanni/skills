# Patchstack scope rules

From the guidelines at https://patchstack.com/articles/bug-bounty-guidelines-rules/ as updated on 2026-10-01 (section numbers in brackets). A finding that breaks any rule here earns nothing and counts toward the rejection rate.

## In scope

- **Software:** WordPress core, plugins and themes, free or premium, distributed publicly through WordPress.org, the vendor's site, GitHub, CodeCanyon or ThemeForest [3.1, 3.6]. For premium software, attach the original archive [3.3].
- **Version:** the latest released version, updated within the last three years [3.6].
- **Installs:** 1,000 or more [3.5]. For premium software, Patchstack estimates installs from wpoptic.com and PublicWWW, and uses sales only as a fallback [12.2].
- **Attacker:** unauthenticated, or the default Subscriber or Customer role [3.7]. A plugin's custom role counts only if it is close to Subscriber and isn't granted by an admin [3.8].
- **VDP software** is also accepted below 1,000 installs, at Contributor level, and for other types, but such reports may earn no XP [3.9].

Types accepted, with their conditions [3.9]:

| Type | Condition |
|---|---|
| SQL injection | none |
| XSS | affects the entire site, or is reflected |
| Arbitrary file upload, deletion, download | full control over path and extension |
| Remote or arbitrary code execution | none |
| PHP object injection | none (×0.5 XP without your own POP chain) |
| Arbitrary settings change | WordPress options or settings with significant site impact |
| Privilege escalation | to Contributor or higher |
| LFI / RFI | full control over path and extension |
| Broken access control | access to significant objects, e.g. API keys with demonstrated impact, password hashes, backup or SQL files |
| IDOR | significant security impact; PII leakage alone and attachments, tickets, events, orders or appointments do not count |
| CSRF | must reach file upload or deletion, privilege escalation, RCE with a working PoC, or a settings change leading to wider compromise [4.7] |

## Out of scope [4]

- **Configuration:** bugs that exist only because an admin configured them, or because the plugin's permission screen lets an admin grant a capability to a lower role. Expected functionality. Authenticated shortcode issues without sensitive data disclosure.
- **Scoring:**
  - any AC:H finding
  - Subscriber-or-higher findings with only minor impact (CVSS 5.4 with two Low impacts, 6.3 with three)
  - unauthenticated findings with one Low impact (CVSS 5.3)
  - actions that need an unguessable identifier
  - re-ordering data, clearing caches, or triggering cron jobs
- **Submission:**
  - several findings of the same type not merged into one report
  - vendor self-submissions
  - unverifiable or unrealistic reports
  - closed or non-public software
  - CSV injection
  - CAPTCHA bypass and IP spoofing, unless that is the plugin's main function
- **Information disclosure:**
  - full path disclosure
  - private or draft content, unless it holds PII or enables takeover
  - low-impact enumeration
  - API keys without significant impact
- **XSS and injection:** Contributor-or-higher stored XSS, HTML injection without script execution, CSS injection.
- **Authentication:**
  - 2FA bypass
  - missing brute-force protection, except TOTP and sequential filenames
  - registration below Contributor
  - arbitrary registration that doesn't reach Contributor
- **CSRF:** multi-step CSRF, or CSRF that only dismisses admin notices or bypasses a non-critical IP check.
- **Files:** LFI without full path and extension control, constrained-path LFI without working traversal (Windows-only tricks excluded), uploads that rely on legacy extensions such as `.phtml`.
- **Other:**
  - open redirect
  - race conditions below CVSS 7.1
  - DoS without high availability impact on any environment
  - blind SSRF without concrete impact
  - AI token exhaustion

## Duplicates and quality [5, 6]

- **Duplicates:** the first valid report wins, even when a later one uses a different parameter or endpoint. A publicly disclosed incomplete patch is not new unless it opens a new attack vector.
- **Reported elsewhere first:** a bug already reported to the vendor is accepted only if the vendor confirms to triage@patchstack.com. Automattic software must go through Automattic's HackerOne program first.
- **What a report needs:** a step-by-step PoC from installation to exploitation, the raw HTTP requests as text, and the exact payloads.
- **Rejection rate:** a rejection rate of 50% or more in a month removes you from the leaderboard for a month.
- **One-week ban:** for reports that clearly break the rules, contain AI hallucinations, or were not tested against the real plugin.
