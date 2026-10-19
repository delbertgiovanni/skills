---
name: looking-up-wordpress-plugins
description: Looks up wordpress.org plugins for bug bounty work: real install range and Wordfence band, versions with release dates, closed status, source code of any version, diffs between versions or of one SVN commit, and targets in an install band. Use when a task names a WordPress plugin slug, needs a vulnerable version's code, asks what a patch changed, or wants plugins to hunt in an install range.
---

# Looking up WordPress plugins

`scripts/wp.mjs` (Node 18+, no packages) wraps the wordpress.org endpoints that work for scripts. Run `node scripts/wp.mjs --help` for the command list. Code and diffs land under `./wp-plugins/<slug>/` unless you pass `--out`.

## Facts the commands rely on

- **Install counts are rounded down to one significant digit.** An API value of 3,000 means 3,000–3,999 real installs. `info` prints the real range and every Wordfence band it overlaps. Two values straddle a band edge: `20` (20–29, across the 25 floor) and `10,000` (10k–19,999, across the 15k edge). Report both bands for those.
- **Closed plugins are still downloadable.** The API returns only `closed`, `closed_date` and `reason` for them, while the zips on downloads.wordpress.org and the whole SVN history stay up. `info` lists the SVN tags for a closed plugin.
- **Deleted versions are recoverable.** The plugin team deletes malicious or broken tags from SVN (display-widgets lost 2.6–2.6.3.1 this way). `versions` lists them as `DELETED in r<rev>` with who removed them and why, and `download` still fetches them, from the zip when wordpress.org keeps it and from SVN history otherwise.
- **Trac is closed to scripts.** plugins.trac.wordpress.org answers every non-browser client with a JavaScript proof-of-work page (HTTP 403). The `log`, `changeset` and `diff` commands use SVN over WebDAV instead. Give the user a Trac link only to open in a browser: `https://plugins.trac.wordpress.org/changeset/<rev>/<slug>`.
- **`slug.zip` is the stable release, not trunk**, even though the API's `versions` map calls it `trunk`. Use `download <slug> trunk` for unreleased code.

## Steps

1. **Identify the plugin.** Run `info <slug>`. Done when you have the slug as wordpress.org knows it, its install range and Wordfence band (or that it is closed), and the latest version. A slug that isn't found may differ from the plugin's folder or display name: try the name lowercased and hyphenated, then `find --author <wordpress.org username> --min 0`. `find --search` ranks large plugins first, so a small plugin can be missing from its results.

2. **Pin the versions.** Run `versions <slug>` for every tag with its release date, deleted ones included. Done when you know the exact version that is vulnerable and, if one exists, the first fixed version.

3. **Get the code.** Run `download <slug> <version>`, or `trunk`. Done when the printed folder holds the plugin's files for that version.

4. **See what a fix changed**, when there is a fix:
   - Between releases: `diff <slug> <vulnerable> <fixed>`. It prints a per-file summary and writes the full unified diff to a file; read the files that matter rather than the whole diff.
   - For one commit: `log <slug>` to find the revision, then `changeset <slug> <revision>`. A commit that only copies trunk into a new tag shows no file changes; diff the previous commit or the two tags instead.

   Done when you can name the file and function where the patch landed.

5. **Find targets**, when asked for plugins to hunt: `find --min <installs> --max <installs>`, optionally with `--tag`, `--search` or `--author`, `--updated-within <days>`, and `--sort updated` to cover the whole band newest first. Plugins marked `?` may fall outside the range because of rounding. Done when the list matches the requested band and filters.

Pass `--json` to any command for machine-readable output.
