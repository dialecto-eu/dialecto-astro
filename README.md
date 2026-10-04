# @dialecto/astro

In-context editing for Astro sites, for use with [Dialecto](https://dialecto.eu). `dialecto-in-context.mjs` is
a single module (Node 22+, no runtime dependencies) that lets Dialecto's in-context editor work on an Astro site
that keeps flat JSON (ICU) catalogs, one `<locale>.json` per language. While you run `astro dev`, you can click any
translated string on a page and edit it in a Dialecto sidebar; your edits become Dialecto's usual pull request
against your catalog files.

This add-on's page markers, previews and key-rename scan cover flat catalogs only. Dialecto's web editor and
pull requests also handle nested catalogs (i18next, next-intl, vue-i18n) and browser-extension catalogs;
renaming a nested key is not offered.

The add-on is dev-only: it runs under `astro dev` and does nothing in `astro build`, `astro preview` or tests.
Documentation lives at [dialecto.eu/docs](https://dialecto.eu/docs).

## Setup

Install the package as a dev dependency:

```
npm install --save-dev @dialecto/astro
```

and add one line to `astro.config.mjs`:

```js
import dialectoInContext from '@dialecto/astro';

export default defineConfig({ integrations: [dialectoInContext()] });
```

If you would rather not add a dependency, you can copy `dialecto-in-context.mjs` into the site (for example
`tooling/`) and import it by path instead. The CI commands below are shown that way, as
`node tooling/dialecto-in-context.mjs`; with the package installed, the same commands run as `npx dialecto-astro`.

Run `astro dev`. An "Edit text" button appears bottom-right on every page. The editor signs in with your
Dialecto account; the first time, a Dialecto window asks you to allow it.

The add-on finds the project on its own: it reads the site's git remote and Dialecto matches it to your
project, so there is nothing else to configure.

## Optional configuration

Every option can also be set as an environment variable (process env or a Vite `.env*` file). An option
passed in `astro.config.mjs` wins over the environment, and the environment wins over the default.

| Option | Env var | Default | What it is for |
| --- | --- | --- | --- |
| `url` | `DIALECTO_URL` | `https://app.dialecto.eu` | Set it when you run Dialecto yourself, for example `http://127.0.0.1:4500`. |
| `project` | `DIALECTO_PROJECT` | none | The project's `owner/name` slug or its number. Use it when the git remote doesn't identify the project, or when several projects share one repository. |
| `catalogs` | `DIALECTO_CATALOGS` | `src/i18n/messages` | Folder holding the `<locale>.json` files. |
| `sourceLocale` | `DIALECTO_SOURCE_LOCALE` | `en` | The language the source catalog is written in. |
| `enabled` | `DIALECTO_IN_CONTEXT` | on | `enabled: false` or `DIALECTO_IN_CONTEXT=off` (also `false` or `0`) turns the add-on off. |

`DIALECTO_REPO` still works as an older name for `DIALECTO_PROJECT`; the add-on logs a hint when it is the
one in use.

Sites on `localhost` and `127.0.0.1` can always open the editor. Any other host, such as a staging site, is
added in the project's settings under "Other sites". Dialecto recognizes that site by the origin the
browser sends as the editor frame's referrer, and lets only that origin frame the editor, so it never
lists a project's other sites to anyone. The overlay asks for the origin alone (never the page's path),
whatever the page's own `Referrer-Policy` says, so the site needs no setup. A browser or extension that
strips the referrer from every request can still use the editor on `localhost` and `127.0.0.1`; on any
other host the editor won't load.

## What it does (dev only)

- Wraps every catalog value in an invisible marker carrying `{domain, key, locale}`, so every render path
  (SSR, browser translator, attributes, `<title>`, canvas text) is traceable with no app changes.
- Swaps the site's `intl-messageformat` for a recording subclass: each formatted message carries the
  argument values it was formatted with, so the overlay previews any edit, plural and select included,
  exactly as the page's own data words it, as you type.
- Injects Dialecto's overlay (`<url>/assets/in-context/overlay.js`).
- Serves `GET /__dialecto/context` (same-origin, loopback only): the GitHub `owner/name` from the git
  remote, the configured project, the current branch and commit, and which catalog files have uncommitted
  changes. The overlay hands this to the editor so it opens the right project and knows which branch you
  are on. It is computed from git on request and never sent anywhere else.
- Serves `POST /__dialecto/overrides` (same-origin only) so drafts render through the app's real ICU code
  paths after a reload.

Dialecto reads the catalogs from GitHub when you push, so the add-on does not scan anything when the dev
server starts.

## Scanning from CI

`scan` posts the catalogs at `origin/<default branch>` to Dialecto. It is meant for CI and needs the
project's scan token (on its Dialecto settings page) and the project's number, the `<number>` in its
Dialecto URL `/repos/<number>`:

```
DIALECTO_SCAN_TOKEN=... DIALECTO_PROJECT=12 node tooling/dialecto-in-context.mjs scan
```

`--worktree` scans uncommitted files instead and is a testing escape hatch only: a pull request from it
would include those bytes. `DIALECTO_URL` applies here too when you run Dialecto yourself.

`DIALECTO_CATALOG_PATHS` (or the `catalogPaths` option) lists the project's translation file paths as they
are on its Dialecto settings page, comma-separated (`src/i18n/messages/*.json`). The scan then sends only the
catalogs those paths name, matched the way Dialecto matches them: `**` spans folders, `*` stays within one,
and no wildcard reaches a folder or file starting with a dot. Dialecto refuses a scan carrying a file outside
the paths, so the generated workflow always sets it.

When `dialecto-usages.mjs` sits beside the add-on and the project's parsers are installed (`npm ci` first),
`scan` also sends where the code reads each key (see below), read from the same commit as the catalogs, never
from the working tree. Dialecto uses it to say which keys could be renamed. Without the scanner or a parser,
`scan` still sends the catalogs and prints one line saying that renames stay unavailable.

## Finding where the code reads each key

`dialecto-usages.mjs` is a second dependency-free module that reads the site's code (never running it) and
lists every place that reads a catalog key: `t('home.title')`, `` t(`nav.${id}`) ``, keys passed through your
own helper functions, keys chosen by a ternary, and so on. Copy it into `tooling/` next to
`dialecto-in-context.mjs`; the add-on loads it when present, and the two files must sit in the same folder. It needs no packages of its own: it borrows the parsers your site
already has in `node_modules` (rolldown's, with `@babel/parser` as a fallback, and `@astrojs/compiler-rs` for
`.astro` files; Astro 7 and Vite 8 install them), so run it after `npm ci`.

It reads every tracked `.astro`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts` and `.tsx` file (tests and tooling
included, because a function's keys can come from any caller), except `node_modules`, build output and
anything you exclude. Files of other types that can hold code (`.vue`, `.svelte`, `.mdx`) and files that fail
to parse are listed as unscanned.

```
node tooling/dialecto-in-context.mjs usages [--summary] [--out FILE]
node tooling/dialecto-in-context.mjs check
```

`usages` prints a plain summary, which is also the "what can I rename?" view: uses by kind, every catalog key
sorted into one of four classes, the groups of keys that can only be renamed together, the keys that are locked
and why (with `file:line`), and the unscanned files. `--out FILE` writes the full record list as JSON instead
(with `--summary` it does both).

| Class | Meaning |
| --- | --- |
| alone | Every use is a literal string, so the key can be renamed on its own. |
| family | Some use builds the key from a shared template (`` t(`nav.${id}`) ``): the key is renamed together with its group, by prefix. |
| locked | Code builds the key at run time from something the scan can't read, so a rename could miss a use. Its text stays editable. |
| unreached | No code reads the key. |

Unscanned files lock every key, since nothing proves they don't use it. Excluding the file lifts the lock.

`check` scans the code again and compares it with the catalogs on disk. It exits 1, naming each use with its
`file:line`, when the code reads a key that no longer exists, when every key a use can read is gone, or when a
key built at run time starts with text that no key has. Uses in test files (`*.test.*`, `*.spec.*`, `test/`,
`tests/`, `__tests__/`) are only warnings, since tests probe missing keys on purpose. It needs nothing from
Dialecto, so it is meant for your CI after a rename.

Both commands read the catalogs from the `catalogs` folder (the `sourceLocale` file's keys, or all of them when
there is no such file). The settings are environment variables (comma-separated lists, or a Vite `.env*` file),
which is all the command line sees; the same names also exist as options of `dialectoInContext()`, with the
same precedence as above:

| Option | Env var | Default | What it is for |
| --- | --- | --- | --- |
| `i18nModules` | `DIALECTO_I18N_MODULES` | none | Your i18n modules, as project-relative paths (`src/i18n/index.js`). What they export under the names in `i18nNames` (and their factories) are translate functions, whatever you rename them to on import. With none set, an import is a translate function when its imported name is in `i18nNames`. |
| `i18nFactories` | `DIALECTO_I18N_FACTORIES` | `getTranslator`, `createTranslator`, `useTranslations`, `useTranslation` | Functions that return a translate function. |
| `i18nNames` | `DIALECTO_I18N_NAMES` | `t`, `tr`, `$t` | A name fallback. A use found only by its name, not by where the function comes from, is reported as such in the summary. |
| `usagesExclude` | `DIALECTO_USAGES_EXCLUDE` | none | Paths or globs the scan skips (`legacy`, `src/**/*.gen.js`). |

```
DIALECTO_I18N_MODULES=src/i18n/index.js,src/i18n/runtime.js node tooling/dialecto-in-context.mjs usages
```

## Setting up CI for key renames

Dialecto can rename a key in every catalog and change the code that reads it, in one pull request. For that,
your CI has to tell Dialecto where the code reads each key, and apply and check the code changes of
Dialecto's rename pull requests. On a project whose read access is blocked, the "How Dialecto gets
your translation files" card on its settings page shows this workflow with your project's number filled in.

1. Keep `dialecto-in-context.mjs` and `dialecto-usages.mjs` together in `tooling/`. Both are downloads on
   that settings card.
2. In GitHub, add the project's scan token as a repository secret named `DIALECTO_SCAN_TOKEN`.
3. Commit the workflow as `.github/workflows/dialecto.yml`. It has three jobs:
   - `send` runs on pushes to any other branch. It sends just that branch's translation files with git, jq
     and curl, for the branches Dialecto scans (Settings → Branch scanning). Renames are staged on the
     default branch, so other branches don't need the code scan.
   - `scan` runs on every push to the default branch, starting with Node 22 and `npm ci`, since the scanner
     borrows your site's parsers. It runs `node tooling/dialecto-in-context.mjs scan`
     with permission to read the repository, which sends the catalogs and where the code reads each key,
     both from the pushed commit. Dialecto offers a rename only for keys it has call-site data for.
   - `rename` runs on pull requests Dialecto opens (head branch starting `dlocal/`, from your own
     repository), also on Node 22 after `npm ci`. It runs the `dialecto-eu/source-rewrite@v1` action with `commit: true`, which applies the
     code changes from the pull request body and pushes them to the branch, then
     `node tooling/dialecto-in-context.mjs check`. This job has `contents: write` and `pull-requests: read`.
4. Set `DIALECTO_I18N_MODULES`, `DIALECTO_I18N_FACTORIES`, `DIALECTO_I18N_NAMES` and
   `DIALECTO_USAGES_EXCLUDE` (the table above) in the workflow's `env:` when the defaults don't find your
   translate functions. The scan and the check read the same settings. The generated workflow also sets
   `DIALECTO_PROJECT`, `DIALECTO_URL`, `DIALECTO_CATALOG_PATHS` and, when your catalogs sit in one folder,
   `DIALECTO_CATALOGS`.

`check` fails the job, naming each use with its `file:line`, when:

- the code reads a key that no longer exists (`missing_key`);
- every key a use can read is gone (`missing_keys`);
- a key built at run time starts with text that no key has (`no_matching_keys`).

The same findings in test files are warnings. `check` also fails when no parser is installed, so a pass never
means that nothing was read. It needs nothing from Dialecto.

Renames are offered only on Astro 7 and Vite 8, whose installed parsers the scanner reuses. Projects on
older versions keep editing text; their keys are not offered for rename.

## What it sends where

- In the browser, under `astro dev`, the page loads Dialecto's overlay script from `<url>/assets/in-context/overlay.js`,
  where `url` defaults to `https://app.dialecto.eu`. The overlay frames Dialecto's sidebar, where you sign in and your
  edits are saved as drafts on your project. The text and identities of the strings on the page are what the editor
  works on, so avoid opening it on pages that show data you would not want in Dialecto.
- On your machine, the add-on answers the overlay at `/__dialecto/context` and `/__dialecto/overrides`, on loopback
  only. It runs `git` locally to read the remote, branch, commit and uncommitted catalog files, and the answer goes
  only to the page that asked.
- The add-on's dev server makes no outbound request of its own, and it never uploads your source code or catalogs.
- The `scan` command, which you run in CI, is the one place the add-on sends anything to Dialecto: the catalogs at
  the default branch (limited to `DIALECTO_CATALOG_PATHS` when you set it) and, when `dialecto-usages.mjs` is
  present, where the code reads each catalog key, together with your project's scan token.

## Guarantees

The integration only ever runs under `astro dev`. `astro build`, `astro preview` and test runs get no
markers, no overlay and no network calls, and `enabled: false` (or `DIALECTO_IN_CONTEXT=off`) switches it
off in dev as well.

## Develop

The add-on and the scanner have node tests in `test/`. They need Node 22.12 or newer:

```
npm install
npm test
```

## Licence

MIT. See [LICENSE](LICENSE).

## Security

Please report vulnerabilities privately, through GitHub's private vulnerability reporting on this repository, and not
in a public issue.
