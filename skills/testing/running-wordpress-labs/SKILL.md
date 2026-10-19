---
name: running-wordpress-labs
description: Starts a throwaway local WordPress with an exact plugin or theme version and a user per role, then maps its AJAX actions and REST routes with their nonce and capability checks and hands out cookies and nonces for any role. Use when reproducing or testing a WordPress plugin or theme vulnerability, writing a PoC, or checking which role can reach an endpoint.
---

# Running WordPress labs

`scripts/lab.mjs` runs WordPress Playground: PHP compiled to WebAssembly, inside Node, with SQLite instead of MySQL and no Docker. A lab starts in 12–25 seconds and serves on `http://127.0.0.1:9400`. Everything stays on this machine. The site lives in memory, so each `start` gives a clean install.

**Requirements:** Node 20 or later, and npm for the first run. The script pins Playground CLI 3.1.54, the last release that runs on Node 20 and 22; 3.1.55 and later need Node 24.18. The first `start` downloads the CLI (about a minute), and later starts reuse it.

Run every command from the working folder. The lab lives in `./wp-lab`: its blueprint, cached zips, cookies, the debug log and the server log.

## Steps

1. **Start the lab** with the vulnerable versions:
   ```
   node scripts/lab.mjs start <plugin>@<version> [<other-plugin> ...] [--theme <slug>@<version>] [--wp 6.8] [--php 8.1]
   ```
   Premium code: `--zip file.zip`. Code you want to edit while the site runs (to add `error_log()` calls, say): `--mount-plugin <folder>`. Edits to a mounted folder take effect on the next request, with no restart.

   Done when it prints `ready` and every plugin you asked for shows `active`. If one is `INACTIVE`, or start fails with "requires WordPress X", its version needs an older or newer WordPress: pass `--wp` and `--php` to match the plugin's `Requires at least` and `Requires PHP` headers.

2. **Set up the configuration the bug needs**, if any: plugin options, extra roles, posts or orders. Run PHP inside WordPress as admin with `node scripts/lab.mjs php '<code>'` (or `--file setup.php`), e.g. `php 'update_option("plugin_opts", array("public_path" => ABSPATH . "wp-content")); return get_option("plugin_opts");'`. A setting the plugin's own form would save goes into the same option keys; find them in the plugin's settings handler. Done when the option reads back with the value you set, or the bug needs no setup.

3. **Map the attack surface:** `node scripts/lab.mjs surface`. It lists the plugins' and themes' AJAX actions (`NOPRIV` ones are reachable logged out), REST routes with their `permission_callback`, and shortcodes, each with its handler's `file:line`. Done when you have the handler for the code path you are testing.
   - `[nonce: …; cap: …]` shows the nonce action and capability checked **in the handler body**. `NONE` is a lead, not a finding: the check may sit in a helper the handler calls, so read the code at `file:line` before you claim anything.
   - REST `permission: MISSING` or `__return_true (public)` means any visitor reaches the handler.

4. **Get credentials:**
   - Cookies: `node scripts/lab.mjs login <role>` saves the role's cookie to `wp-lab/cookie-<role>.txt`; send it with `curl -b "$(cat wp-lab/cookie-<role>.txt)"`.
   - Nonces: `node scripts/lab.mjs nonce <action> --as <role>` gives a nonce for the action name the handler checks (from `surface`), plus the `wp_rest` nonce for the `X-WP-Nonce` header.

   Users are `admin`/`password`, and `subscriber`, `contributor`, `author` and `editor` (plus `customer` when WooCommerce is active), each with its own name as password. Done when a request as the target role gets past the nonce check.

5. **Reproduce** with plain HTTP requests against `http://127.0.0.1:9400`, as the lowest role the bug needs, always with `curl --max-time 20`. Done when the response or a side effect proves the impact; confirm side effects with `php`, e.g. `php 'return get_option("x");'`. Read `node scripts/lab.mjs log` for PHP errors and anything you `error_log()`. From `admin-ajax.php`, `-1` means a failed nonce check (`check_ajax_referer`), and `0` means no handler ran, unless the handler you read returns `0` itself.

6. **Stop** with `node scripts/lab.mjs stop` when finished. Done when it prints `stopped`. `status` shows what is running.

## Gotchas

- A request that never returns ties up one of Playground's 6 workers; after a few, the whole site stops answering. Keep `--max-time` on every request, and if the lab stops responding run `stop`, then `start` again.
- `start` builds a new site: cookies, nonces and anything set with `php` are gone after a restart. Run `login`, `nonce` and your setup again.

- Playground answers HTTP before setup finishes. `start` waits for its `Ready!` line, so a lab you start yourself any other way can serve a site with no users yet.
- There is no shell. `exec`, `shell_exec`, `system` and `proc_open` exist but run nothing (`shell_exec` returns `null`). Prove command injection or RCE with PHP-level effects instead, such as writing a marker file under `wp-content/uploads`, `phpinfo()`, or an `error_log()` line in `log`. A bug that only works through a real shell needs a real server.
- Outbound HTTP works, and curl, GD, ImageMagick, SOAP, intl, mbstring, OpenSSL, sodium and zip are loaded, so SSRF and image-processing bugs reproduce. `wp-content/uploads` is writable.
- The site URL is `127.0.0.1`, so code paths that check for a public domain or HTTPS can behave differently.
