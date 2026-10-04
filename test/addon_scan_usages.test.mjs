import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { ADDON, SDK } from './usages_helpers.mjs';

// The add-on's `scan` sends where the code reads each key, read from the SAME commit as the catalogs.

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const write = (root, file, text) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};

const git = (root, ...args) => {
  const run = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};

const PAGE = "import { t } from './i18n/index.js';\n\nexport const title = t('home.title');\nexport const nav = ['one', 'two'].map((id) => t(`nav.${id}`));\n";
const EN = '{"home.title":"Home","home.old":"Old","nav.one":"One","nav.two":"Two"}\n';

/** A site as a customer's: committed, with an origin/main ref, the add-on (and optionally the scanner) in tooling/. */
function makeSite({ scanner = true, parsers = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dialecto-scan-'));
  temps.push(root);
  git(root, 'init', '-q', '-b', 'main');
  write(root, 'package.json', '{"type":"module"}\n');
  write(root, '.gitignore', 'node_modules\ntooling\n');
  write(root, 'src/i18n/index.js', 'export function t(key) {\n  return key;\n}\n');
  write(root, 'src/page.js', PAGE);
  write(root, 'src/Widget.vue', '<template><p /></template>\n');
  write(root, 'dist/bundle.js', "import { t } from '../src/i18n/index.js';\nt('built.output');\n");
  write(root, 'src/i18n/messages/en.json', EN);
  write(root, 'src/i18n/messages/de.json', EN);
  git(root, 'add', '-A', '-f');
  git(root, 'commit', '-q', '-m', 'site');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  mkdirSync(path.join(root, 'tooling'));
  copyFileSync(ADDON, path.join(root, 'tooling/dialecto-in-context.mjs'));
  if (scanner) copyFileSync(path.join(SDK, 'dialecto-usages.mjs'), path.join(root, 'tooling/dialecto-usages.mjs'));
  if (parsers) symlinkSync(path.join(SDK, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

/** Runs the site's own copy of the add-on's `scan` against a stub server; resolves to the request body and the log. */
async function scanSite(root, { worktree = false } = {}) {
  const addon = await import(pathToFileURL(path.join(root, 'tooling/dialecto-in-context.mjs')).href);
  const env = { DIALECTO_URL: 'https://dialecto.test', DIALECTO_PROJECT: '7', DIALECTO_SCAN_TOKEN: 'token', DIALECTO_I18N_MODULES: 'src/i18n/index.js' };
  const settings = addon.resolveSettings(env, {}, root);
  const requests = [];
  const log = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return url.endsWith('/scan-config') ? { ok: true, status: 200 } : { ok: true, status: 201, json: async () => ({ outcome: 'ingested' }) };
  };
  const result = await addon.scan(settings, { worktree, log: (level, message) => log.push({ level, message }), fetchImpl });
  return { result, log, body: requests.find((r) => r.url.endsWith('/scans'))?.body, addon };
}

const rows = (usages) => usages.map((u) => [u.file, u.kind, u.start_line, u.key ?? u.keys]);

test('the scan carries the usages of the committed tree, not the working tree', async () => {
  const root = makeSite();
  // Edits made after the commit: a changed line, an uncommitted file, and one deleted.
  write(root, 'src/page.js', `${PAGE}export const edited = t('edited.key');\n`);
  write(root, 'src/untracked.js', "import { t } from './i18n/index.js';\nt('untracked.key');\n");

  const { result, log, body } = await scanSite(root);

  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /scanned 2 catalogs with 2 call-site records @ [0-9a-f]{7} \(origin\/main\)/);
  assert.deepEqual(log.filter((entry) => /call site/.test(entry.message)), []);

  const { jsonUsages } = body;
  assert.equal(jsonUsages.version, '1.0.0');
  assert.equal(jsonUsages.parsers.js, 'rolldown');
  assert.deepEqual(rows(jsonUsages.usages), [
    ['src/page.js', 'static', 3, 'home.title'],
    ['src/page.js', 'set', 4, ['nav.one', 'nav.two']],
  ]);
  assert.doesNotMatch(JSON.stringify(jsonUsages), /edited\.key|untracked\.key|built\.output/);
  assert.deepEqual(jsonUsages.unscanned, [{ file: 'src/Widget.vue', reason: 'Vue files are not read by the scanner' }]);
  assert.deepEqual(Object.keys(jsonUsages).sort(), ['parsers', 'unscanned', 'usages', 'version']);
});

test('--worktree scans the working tree instead', async () => {
  const root = makeSite();
  write(root, 'src/page.js', `${PAGE}export const edited = t('edited.key');\n`);

  const { body } = await scanSite(root, { worktree: true });

  assert.match(JSON.stringify(body.jsonUsages.usages), /edited\.key/);
});

test('the usages come from the commit the catalogs are read from, whatever HEAD says', async () => {
  const root = makeSite();
  const scanned = git(root, 'rev-parse', 'HEAD');
  // A newer local commit, not on origin/main, adds a use.
  write(root, 'src/page.js', `${PAGE}export const later = t('later.key');\n`);
  git(root, 'commit', '-q', '-a', '-m', 'later');
  assert.notEqual(git(root, 'rev-parse', 'HEAD'), scanned);

  const { body } = await scanSite(root);

  assert.equal(body.gitSha, scanned);
  assert.doesNotMatch(JSON.stringify(body.jsonUsages.usages), /later\.key/);
});

test('the checksum follows the code as well as the catalogs, so Dialecto does not skip a changed scan', async () => {
  const root = makeSite();
  const first = (await scanSite(root)).body;
  assert.equal((await scanSite(root)).body.checksum, first.checksum);

  write(root, 'src/page.js', `${PAGE}export const more = t('home.old');\n`);
  git(root, 'commit', '-q', '-a', '-m', 'use another key');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  const second = (await scanSite(root)).body;
  assert.deepEqual(second.templates, first.templates);
  assert.notEqual(second.checksum, first.checksum);
});

test('without the scanner file the scan is sent without usages, with one log line', async () => {
  const root = makeSite({ scanner: false });

  const { result, log, body } = await scanSite(root);

  assert.equal(result.ok, true, result.message);
  assert.equal('jsonUsages' in body, false);
  assert.equal(body.templates.length, 2);
  const lines = log.filter((entry) => /call sites are not scanned/.test(entry.message));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'warn');
  assert.match(lines[0].message, /renames stay unavailable: dialecto-usages\.mjs not found/);
  assert.doesNotMatch(result.message, /call-site/);
});

test('without a parser the scan is sent without usages, with one log line', async () => {
  const root = makeSite({ parsers: false });

  const { log, body } = await scanSite(root);

  assert.equal('jsonUsages' in body, false);
  const lines = log.filter((entry) => /call sites are not scanned/.test(entry.message));
  assert.equal(lines.length, 1);
  assert.match(lines[0].message, /no JavaScript parser found in node_modules.*npm ci/);
});

test('a scanner too old to read a committed tree is reported, not guessed around', async () => {
  const root = makeSite();
  const scannerPath = path.join(root, 'tooling/dialecto-usages.mjs');
  writeFileSync(scannerPath, 'export const USAGES_VERSION = "0.9.0";\nexport async function loadParsers() { return { js: "rolldown" }; }\n');

  const { log, body } = await scanSite(root);

  assert.equal('jsonUsages' in body, false);
  assert.match(log.map((entry) => entry.message).join('\n'), /dialecto-usages\.mjs is out of date/);
});

test('scanChecksum without usages is the catalogs-only checksum', async () => {
  const { scanChecksum } = await import(pathToFileURL(ADDON).href);
  const templates = [{ path: 'a.json', content: '{}' }];

  assert.equal(scanChecksum(templates), scanChecksum(templates, null));
  assert.notEqual(scanChecksum(templates), scanChecksum(templates, 'abc'));
});
