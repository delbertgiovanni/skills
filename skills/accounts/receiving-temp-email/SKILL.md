---
name: receiving-temp-email
description: Creates a disposable email inbox (Mail.tm, with Maildrop as backup) and reads incoming mail such as verification codes and magic links. Use when a task needs a temp, throwaway or burner email address, e.g. for test sign-ups or grabbing an OTP.
---

# Receiving temp email

Mail.tm is the default: its inboxes are private (password + token). Maildrop is the backup, for when a site rejects the Mail.tm domain or Mail.tm is failing. If any Mail.tm request returns `429` (rate limited), wait about 10 seconds and try again. Make 3 attempts in total (the first try plus 2 retries). Switch to Maildrop only if the third attempt also fails. Maildrop inboxes are **public**, and anyone who guesses the name can read them. Neither needs an API key or a browser.

## Rules

- Use these inboxes only for throwaway or test accounts, never for real credentials or personal data.
- Only read inboxes you created or the user gave you.
- Tell the user the address you picked.

## Making requests

Use `curl`. The examples are for sh/bash/zsh. In PowerShell, call `curl.exe` (plain `curl` there is `Invoke-WebRequest`). On Windows, if inline JSON quoting fails, write the body to a file and pass it with `--data @body.json`.

## 1. Mail.tm (default)

1. **Get a domain.** Don't hardcode it, because it changes:
   ```bash
   curl -s https://api.mail.tm/domains
   ```
   Use `hydra:member[0].domain`.

2. **Create the inbox.** Pick a random name (e.g. `agent` + 8 hex characters, lowercase) and a random password:
   ```bash
   curl -s https://api.mail.tm/accounts -H 'Content-Type: application/json' \
     -d '{"address":"agent3f9a1c2e@example-domain.com","password":"k8d2j4h6f9s1"}'
   ```
   `201` means created. `422` means the name is taken or the domain is wrong, so pick another name.

   **Write down the address, password and `id` (from the response) where you'll see them later**: in your reply to the user, or in a file. The email often arrives turns later, and without the password you can't get a token or read the inbox.

3. **Get a token.** Send the same body:
   ```bash
   curl -s https://api.mail.tm/token -H 'Content-Type: application/json' \
     -d '{"address":"agent3f9a1c2e@example-domain.com","password":"k8d2j4h6f9s1"}'
   ```
   Send `token` from the response as `Authorization: Bearer <token>` on every request below.

4. **List mail.** `curl -s https://api.mail.tm/messages -H "Authorization: Bearer <token>"`. Each item in `hydra:member` has `id`, `from.address`, `subject` and `intro` (a short preview).

5. **Read a message.** `curl -s https://api.mail.tm/messages/<id> -H "Authorization: Bearer <token>"`.
   - `text` is the plain-text body. `html` is a **list** of HTML strings. Use `html[0]` when `text` is empty or the link only appears in the HTML.
   - `text` turns bold into `*...*` (e.g. `*358102*`), so take only the digits.

**Cleanup (optional):** `curl -s -X DELETE https://api.mail.tm/accounts/<id> -H "Authorization: Bearer <token>"`.

## 2. Maildrop (backup)

There's no setup: `<name>@maildrop.cc` exists as soon as mail arrives. Pick a random name as above. Every request is a GraphQL POST:

```bash
curl -s https://api.maildrop.cc/graphql -H 'Content-Type: application/json' \
  -d '{"query":"query { inbox(mailbox: \"agent3f9a1c2e\") { id headerfrom subject date } }"}'
```

- **List:** the query above. Results are in `data.inbox`, and an empty list means nothing has arrived yet.
- **Read:** `query { message(mailbox: "<name>", id: "<id>") { subject html } }`. The body is in `data.message.html`. Don't use the `data` field: it's the raw MIME source.
- The address must be in the To field. Maildrop drops mail sent to it only by Bcc.

## Waiting for mail and checking it

1. After the site sends the email, list the inbox every 5 seconds, for up to 2 minutes.
   - In tests, mail arrived within 1 to 6 seconds.
   - Polling faster risks rate limits. Mail.tm answers `429`; if you get it, wait longer before the next check.
2. **Check it's the right message** before using anything from it. The sender or subject must match the site you signed up to. This matters most on Maildrop, where anyone can send mail to or read the inbox. Ignore mail that doesn't match.
3. If nothing matching arrives within 2 minutes, stop and tell the user. Don't keep creating new inboxes. The site may block disposable domains, or it may not have sent anything.
4. If a site rejects the email domain, switch to the other service (Mail.tm ↔ Maildrop) and tell the user the new address.
