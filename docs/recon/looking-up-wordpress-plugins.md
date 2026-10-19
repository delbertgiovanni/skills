<div align="center">

# looking-up-wordpress-plugins

*Installs, versions, code and patch diffs for any wordpress.org plugin, from the terminal*

[What it can do](#what-the-agent-can-do) • [Installation](#installation) • [Usage](#usage) • [Limitations](#limitations)

</div>

An agent skill for the WordPress side of bug bounty work. It answers the questions that come before and after an audit: how many installs a plugin really has and which Wordfence band that puts it in, which versions exist and when they shipped, what the code looked like in a given version, and what a fix changed. It uses only the wordpress.org endpoints that answer scripts, through one Node script with no npm packages.

## What the agent can do

With this skill loaded, an agent can:

- turn the API's rounded install count into the real range and the matching Wordfence band, and flag the two counts that straddle a band edge
- list every released version with its release date, including for closed plugins the API won't describe, and tags the plugin team deleted (such as backdoored releases), with who deleted them and why
- download and extract any version, deleted ones included, or unreleased trunk, without `unzip` or an SVN client
- diff two versions, or a single SVN commit, to see where a patch landed
- read the plugin's SVN log: who committed what, when, and which files changed
- find plugins in an install range, filtered by tag, search term, author or recent updates

## Installation

The agent needs Node 18 or later; `git` is used for diffs when present, otherwise `diff`. Install just this skill:

```bash
npx skills@latest add noverdy/skills --skill looking-up-wordpress-plugins
```

It also comes with the whole collection; see [Installation](../../README.md#installation). The skill itself lives in [`skills/recon/looking-up-wordpress-plugins`](../../skills/recon/looking-up-wordpress-plugins).

## Usage

Ask in plain language:

```text
Which Wordfence band is bogo in, and what changed between 3.9.2 and 3.9.3?
```

```text
Find plugins with 1,000 to 4,999 installs tagged "forms" that were updated in the last 90 days.
```

The agent runs the script and reads the output:

```text
$ node scripts/wp.mjs info bogo
Bogo (bogo) 3.9.3 by Rock Lobster Inc.
installs: API says 10,000+ → real count 10,000–19,999
Wordfence band: 10,000-14,999 OR 15,000-29,999  (ambiguous: the API rounds down to one significant digit)
updated 2026-08-18 8:24am GMT, added 2009-05-04, WP 6.7–7.1.3, PHP 7.4
versions: 51 released; latest 3.8.2, 3.9, 3.9.0.1, 3.9.1, 3.9.2, 3.9.3
installs by branch: 3.5 6.66%, 3.6 5.12%, 3.7 7.63%, 3.8 14.72%, 3.9 54.06%, other 11.81%
```

```text
$ node scripts/wp.mjs diff contact-form-7 6.2.1 6.2.2
{6.2.1 => 6.2.2}/includes/swv/schema-holder.php |  4 +++-
 {6.2.1 => 6.2.2}/readme.txt                     | 10 +++++++---
 {6.2.1 => 6.2.2}/vendor/composer/installed.php  |  4 ++--
 {6.2.1 => 6.2.2}/wp-contact-form-7.php          |  4 ++--
 4 files changed, 14 insertions(+), 8 deletions(-)
full diff: wp-plugins/contact-form-7/6.2.1..6.2.2.diff
```

## Limitations

- Install counts are only as precise as wordpress.org publishes them: one significant digit. For a count of 20 or 10,000 the Wordfence band can't be pinned down from public data.
- Only plugins hosted on wordpress.org. Premium plugins sold elsewhere aren't covered.
- Trac pages (changesets, browser, timeline) are behind a browser check, so the skill never reads them; it gets the same data from SVN.
- `find` pages through the popular list, so a full scan of a wide band such as 25–499 takes a minute or more.

<details>
<summary>What the research found</summary>

All of this was verified against the live endpoints on 2026-10-19.

**Plugins API** (`https://api.wordpress.org/plugins/info/1.2/`)
- `?action=plugin_information&request[slug]=<slug>` returns `active_installs`, `version`, `versions` (version → zip URL), `last_updated`, `added`, `requires`, `tested`, `requires_php`, `sections` (including `changelog`) and more. Fields can be switched off with `request[fields][<name>]=0`.
- A missing slug returns HTTP 404 with `{"error":"Plugin not found."}`. A closed plugin returns HTTP 404 with `error: "closed"`, `closed_date`, `reason` and a description that says whether the closure is permanent; no installs or versions.
- `?action=query_plugins` takes `request[browse]` (`popular`, `new`, `updated`; `top-rated` returns only a handful of results), `request[tag]`, `request[author]` and `request[search]`. `per_page` is capped at 250, and at 100 for search. Search caps `results` at 10,000, weights installs heavily ("double opt-in helper" returns Advanced Custom Fields first, not the 100-install plugin of that name) and drifts off-topic after a few pages.
- `browse=popular` (also the default) is sorted by installs, with small out-of-order runs at bucket boundaries. A band is found by binary search over pages: about 290 pages of 250 cover every plugin with installs; 1,000–4,999 sits around pages 13–21.
- `active_installs` is the real count rounded down to one significant digit (seen: 10, 20, 30, 300, 400, 800, 1,000–9,000, 10,000, 20,000, …, 10,000,000). 10,000,000 means "10 million or more".

**Stats API** (`https://api.wordpress.org/stats/plugin/1.0/`)
- `<slug>` returns the share of active installs per major.minor branch, e.g. `{"6.1":49.45,"6.2":12.14,...}`. That's how many sites still run a vulnerable branch.
- `downloads.php?slug=<slug>&limit=<days>` returns daily downloads; `&historical_summary=1` returns today, yesterday, last week and all-time.

**Code**
- `https://downloads.wordpress.org/plugin/<slug>.<version>.zip` serves any released version, including for closed plugins. `<slug>.zip` is byte-identical to the latest stable release.
- `https://plugins.svn.wordpress.org/<slug>/{trunk,tags/<version>}/<file>` serves raw files. `!svn/bc/<revision>/<slug>/<path>` serves a file as it was at any revision.
- Deleted tags stay in SVN history: `!svn/bc/<revision before the delete>/<slug>/tags/<version>/` still lists and serves them, and downloads.wordpress.org often keeps their zips (all six deleted display-widgets 2.6.x zips return 200).
- WebDAV works over plain HTTPS: `PROPFIND` with `Depth: 1` on `tags/` gives each tag's revision, committer and date; a `REPORT` with a `log-report` body gives the commit log with changed paths. No SVN client needed.

**Trac**
- Every URL on `plugins.trac.wordpress.org`, including `changeset?…&format=diff`, returns HTTP 403 with a JavaScript proof-of-work page to non-browser clients, whatever the User-Agent.

**Rate limits**
- None observed: 30 parallel API calls, 20 parallel SVN fetches and 6 parallel zip downloads all returned 200.

</details>
