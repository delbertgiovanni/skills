<div align="center">

# receiving-temp-email

*Give your AI agent a disposable inbox for test sign-ups*

[What it can do](#what-the-agent-can-do) • [Installation](#installation) • [Usage](#usage) • [Limitations](#limitations)

</div>

An agent skill that creates a throwaway email address, waits for the verification email, and reads out the code or magic link. It talks to [Mail.tm](https://mail.tm) and [Maildrop](https://maildrop.cc) over plain HTTP, so there's no API key, browser or captcha involved.

## What the agent can do

With this skill loaded, an agent can:

- create a private Mail.tm inbox, or a public Maildrop one when a site rejects the Mail.tm domain
- wait for a site's email and read the verification code or magic link from it
- tell the real email apart from unrelated mail in the same inbox
- recover from Mail.tm rate limits by retrying, then falling back to Maildrop
- report back when nothing arrives, instead of creating inbox after inbox

## Installation

The agent needs to be able to run `curl`. Install just this skill:

```bash
npx skills@latest add noverdy/skills --skill receiving-temp-email
```

It also comes with the whole collection; see [Installation](../../README.md#installation). The skill itself lives in [`skills/accounts/receiving-temp-email`](../../skills/accounts/receiving-temp-email).

## Usage

Ask for a temp inbox in plain language:

```text
Sign up for a second test account on the target with a temp email and get the verification code.
```

```text
Give me a throwaway email address for this form.
```

The agent creates an inbox, tells you the address, and waits. Once the site sends its email, the agent polls the inbox every 5 seconds and reads back the code or link:

```text
Your address is agent3f9a1c2e@uberip.com (Mail.tm).
...
The Acme Cloud verification code is 482730.
```

If the site rejects the address, just say so. The agent switches to a Maildrop address and carries on.

> [!WARNING]
> Maildrop inboxes are public. Anyone who guesses the name can read them. Only use these inboxes for test and throwaway accounts, never for real credentials or personal data.

## Limitations

- Many sites refuse known disposable-email domains, including the ones Mail.tm and Maildrop use. If a site blocks both, use a custom domain with catch-all forwarding (such as Cloudflare Email Routing) instead.
- Both services are free and make no uptime promises. Mail.tm changes its domain from time to time, and either API could change.
- The skill only receives mail. It can't send any.

> [!TIP]
> Testing your own app? A local capture server like [Mailpit](https://mailpit.axllent.org) is a better fit. Point the app's SMTP settings at it and no mail leaves your machine.

<details>
<summary>Why Mail.tm and Maildrop?</summary>

We tested ten temp-mail services by sending them real mail. These two were the only ones with a free API that worked reliably without a key, a browser or a captcha. Mail arrived in about 3 seconds on both.

The others fell short for different reasons:
- Mailinator's free endpoint started failing after repeated polling.
- Guerrilla Mail's API is unofficial and returned an empty subject.
- GoneBox needs an API key to read an inbox.
- YOPmail, Temp-Mail.org and 10MinuteMail sit behind Cloudflare challenges.
- ThrowAwayMail's domain no longer resolves.
- DisposableMail has no API.

The skill was then tested with fresh Claude Haiku and Claude Sonnet agents in five scenarios:
- a normal sign-up
- a rejected domain
- a decoy email arriving after the real one
- a code that never arrives
- rate limiting

</details>
