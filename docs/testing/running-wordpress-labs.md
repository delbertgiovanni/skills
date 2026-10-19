<div align="center">

# running-wordpress-labs

*A throwaway WordPress with the vulnerable version, in 20 seconds, without Docker*

[What it can do](#what-the-agent-can-do) • [Installation](#installation) • [Usage](#usage) • [Limitations](#limitations)

</div>

An agent skill for reproducing WordPress plugin and theme bugs. It starts [WordPress Playground](https://wordpress.github.io/wordpress-playground/) (WordPress in PHP compiled to WebAssembly, running in Node with SQLite) with the exact plugin and theme versions you name and a user for every role. It then gives the agent what a PoC needs: a map of the plugin's endpoints and the checks they make, a login cookie for any role, and valid nonces.

Fetch the vulnerable version with [looking-up-wordpress-plugins](../recon/looking-up-wordpress-plugins.md), reproduce it here, capture it with [snapshotting-http-requests](../reporting/snapshotting-http-requests.md), and price it with the estimators.

## What the agent can do

With this skill loaded, an agent can:

- start WordPress with pinned plugin, theme, WordPress and PHP versions, from wordpress.org, a premium zip, or a folder it edits live
- create `subscriber`, `contributor`, `author`, `editor` (and `customer` with WooCommerce) users, and log in as any of them from a script
- list every AJAX action, REST route and shortcode a plugin adds, with its handler's `file:line`, the REST `permission_callback`, and the nonce and capability checks in the handler
- get a valid nonce for any action as any role
- run PHP inside the site as admin to set up options, roles or posts a bug depends on
- read PHP errors and `error_log()` output from a debug log on the host

## Installation

The agent needs Node 20 or later. Install just this skill:

```bash
npx skills@latest add noverdy/skills --skill running-wordpress-labs
```

It also comes with the whole collection; see [Installation](../../README.md#installation). The skill itself lives in [`skills/testing/running-wordpress-labs`](../../skills/testing/running-wordpress-labs).

## Usage

```text
Reproduce the broken access control in file-manager-advanced 5.4.14 as a Subscriber.
```

```text
$ node scripts/lab.mjs start file-manager-advanced@5.4.14
ready in 16 s: http://127.0.0.1:9400  (WordPress 7.1.3, PHP 8.3.33)
  plugin file-manager-advanced/file_manager_advanced.php 5.4.14 active
users (password = user name): admin/password, subscriber, contributor, author, editor

$ node scripts/lab.mjs surface
AJAX actions (7):
  NOPRIV post_smtp_request   [nonce: 'post_smtp_request_nonce'; cap: 'manage_options']  …/recommend-post-smtp-base.php:600
  priv   fma_load_fma_ui     [nonce: 'fmaskey'; cap: NONE]  class_fma_main::fma_load_fma_ui  …/class_fma_main.php:65
  priv   fma_review_ajax     [nonce: 'afm_review'; cap: NONE]  class_fma_main::fma_review_ajax  …/class_fma_main.php:319
REST routes (2):
  POST  /file-manager-advanced/v1/hide-banner  permission: FMA_Controller::permission_callback @ …/class-fma-controller.php:75

$ node scripts/lab.mjs nonce afm_review --as subscriber
{"as":"subscriber","action":"afm_review","nonce":"<10 hex chars>","rest_nonce":"<10 hex chars>"}
```

## Limitations

- **No shell.** `exec` and friends exist but run nothing, so command injection has to be proven with PHP-level effects such as a marker file.
- **Approximate checks.** The `[nonce; cap]` column reads only the handler's own body. A check inside a helper it calls shows as `NONE`, so read the code before you claim anything.
- **Node version.** The lab uses Playground CLI 3.1.54, the last release for Node 20 and 22. On Node 24.18+ you can set `WP_LAB_CLI_VERSION` to try a newer release.
- **Hung requests freeze the lab.** One request that never returns ties up a worker, and a few freeze the site until `stop` and `start`. The skill has the agent use `curl --max-time`.
- **Fresh every start.** The site is in memory, so a restart is a clean install. Rerun your setup requests after `start`.
- **Local URL.** The site runs on `127.0.0.1` over plain HTTP.

<details>
<summary>What the research found</summary>

- `@wp-playground/cli` 3.1.55 and later require Node 24.18 and npm 11.16 (`@php-wasm/*` packages). 3.1.54 (2026-09-14) is the last release for Node 20 and 22.
- Playground serves HTTP 200 before the blueprint has finished. In testing, a login straight after the first 200 failed because the users didn't exist yet, so readiness means the `Ready!` line in the server output.
- `--php` on the command line is ignored when a blueprint is given. The PHP and WordPress versions have to go in the blueprint's `preferredVersions`.
- Playground's own download of plugin zips failed intermittently (`fetch failed`). Downloading the zips first and passing them as bundled resources fixed it, and caches them.
- `wp_ajax_*` hooks are mostly registered only on admin or AJAX requests, so the surface map runs inside `admin-ajax.php`. Third-party handlers are told apart from core ones by their source file, through PHP reflection.
- Mounted folders are live: a plugin file edited on the host changes the next response without a restart.
- Loaded extensions include curl, GD, ImageMagick, SOAP, intl, mbstring, OpenSSL, sodium and zip. Outbound HTTP works, and `shell_exec` returns `null`.
- Latest WooCommerce (11.2.1) refuses to activate below WordPress 7.0, and the lab reports that as a start failure instead of a half-working site.

</details>
