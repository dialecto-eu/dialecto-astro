import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { ADDON, SDK } from './usages_helpers.mjs';

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const write = (root, file, text) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};

const PAGE = "import { t } from './i18n/index.js';\n\nexport const title = t('home.title');\nexport const nav = ['one', 'two'].map((id) => t(`nav.${id}`));\n";
const EN = '{"home.title":"Home","home.old":"Old","nav.one":"One","nav.two":"Two"}\n';

/** A tiny site laid out as a customer's would be: the add-on and the scanner vendored side by side in tooling/. */
function makeSite({ scanner = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dialecto-usages-'));
  temps.push(root);
  write(root, 'package.json', '{"type":"module"}\n');
  write(root, '.gitignore', 'node_modules\n');
  write(root, 'src/i18n/index.js', 'export function t(key) {\n  return key;\n}\n');
  write(root, 'src/page.js', PAGE);
  write(root, 'src/i18n/messages/en.json', EN);
  write(root, 'src/i18n/messages/de.json', EN);
  mkdirSync(path.join(root, 'tooling'));
  copyFileSync(ADDON, path.join(root, 'tooling/dialecto-in-context.mjs'));
  if (scanner) copyFileSync(path.join(SDK, 'dialecto-usages.mjs'), path.join(root, 'tooling/dialecto-usages.mjs'));
  symlinkSync(path.join(SDK, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

function cli(root, args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DIALECTO_')));
  const run = spawnSync(process.execPath, ['tooling/dialecto-in-context.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...clean, DIALECTO_I18N_MODULES: 'src/i18n/index.js', DIALECTO_USAGES_EXCLUDE: 'tooling', ...env },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const git = (root, ...args) => {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
};

test('usages --summary says what can be renamed', () => {
  const root = makeSite();
  const run = cli(root, ['usages', '--summary']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Scanned 2 files \(parsers: rolldown [\d.]+, compiler-rs [\d.]+\)\./);
  assert.match(run.stdout, /^Uses: 1 static, 1 set, 0 pattern, 0 opaque$/m);
  assert.match(run.stdout, /^Keys \(4 in en\.json\): 1 alone, 2 family, 0 locked, 1 unreached$/m);
  assert.match(run.stdout, /^ {2}nav\. {2}2 keys$/m);
  assert.doesNotMatch(run.stdout, /Locked keys|Unscanned/);
});

test('usages without flags prints the same summary', () => {
  const root = makeSite();
  const run = cli(root, ['usages']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Keys \(4 in en\.json\)/m);
});

test('usages --out writes the payload', () => {
  const root = makeSite();
  const run = cli(root, ['usages', '--out', 'out/usages.json']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /wrote 2 usage records to out\/usages\.json/);
  assert.doesNotMatch(run.stdout, /^Keys /m);
  const payload = JSON.parse(readFileSync(path.join(root, 'out/usages.json'), 'utf8'));
  assert.equal(payload.version, '1.0.0');
  assert.match(payload.addon, /^\d+\.\d+\.\d+$/);
  assert.equal(payload.parsers.js, 'rolldown');
  assert.deepEqual(payload.unscanned, []);
  assert.deepEqual(payload.usages.map((u) => [u.file, u.kind, u.start_line]), [['src/page.js', 'static', 3], ['src/page.js', 'set', 4]]);
  assert.deepEqual(payload.usages[1].keys, ['nav.one', 'nav.two']);
});

test('usages lists locked keys with the pattern and file:line, and unscanned files', () => {
  const root = makeSite();
  write(root, 'src/dyn.js', "import { t } from './i18n/index.js';\nexport const x = t(`home.${window.location.hash}`);\n");
  write(root, 'src/Widget.vue', '<template><p /></template>\n');
  const withVue = cli(root, ['usages', '--summary']);
  assert.equal(withVue.status, 0, withVue.stderr);
  assert.match(withVue.stdout, /^Keys \(4 in en\.json\): 0 alone, 0 family, 4 locked, 0 unreached$/m);
  assert.match(withVue.stdout, /^Unscanned files/m);
  assert.match(withVue.stdout, /src\/Widget\.vue: Vue files are not read by the scanner/);

  const lifted = cli(root, ['usages', '--summary'], { DIALECTO_USAGES_EXCLUDE: 'tooling,src/**/*.vue' });
  assert.equal(lifted.status, 0, lifted.stderr);
  assert.match(lifted.stdout, /^Keys \(4 in en\.json\): 0 alone, 2 family, 2 locked, 0 unreached$/m);
  assert.match(lifted.stdout, /^ {2}src\/dyn\.js:2 {2}home\.\* {2}2 keys: home\.title, home\.old \(global `window`\)$/m);
  assert.doesNotMatch(lifted.stdout, /Unscanned/);
});

test('usages and check use tracked files when the site is a git checkout', () => {
  const root = makeSite();
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  write(root, 'src/untracked.js', "import { t } from './i18n/index.js';\nt('not.tracked');\n");
  const run = cli(root, ['usages', '--summary']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Uses: 1 static, 1 set, 0 pattern, 0 opaque$/m);
  assert.equal(cli(root, ['check']).status, 0);
});

test('check passes on a consistent site', () => {
  const root = makeSite();
  const run = cli(root, ['check']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /check passed: 2 key uses in 2 files against 4 catalog keys/);
  assert.equal(run.stderr, '');
});

test('check fails after a key is renamed away, naming the use with file:line', () => {
  const root = makeSite();
  write(root, 'src/i18n/messages/en.json', '{"home.heading":"Home","home.old":"Old","nav.one":"One","nav.two":"Two"}\n');
  const run = cli(root, ['check']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /src\/page\.js:3 reads "home\.title", which is not in the catalog/);
  assert.match(run.stderr, /check failed: 1 problem$/m);
});

test('check treats a test file as a warning and still passes', () => {
  const root = makeSite();
  write(root, 'tests/i18n.test.js', "import { t } from '../src/i18n/index.js';\nt('no.such.key');\n");
  const run = cli(root, ['check']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /warning \(test file\): tests\/i18n\.test\.js:2 reads "no\.such\.key"/);
  assert.match(run.stdout, /check passed/);
});

test('check fails when a pattern can reach no key', () => {
  const root = makeSite();
  write(root, 'src/dyn.js', "import { t } from './i18n/index.js';\nexport const x = t(`zzz.${window.location.hash}`);\n");
  const run = cli(root, ['check']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /src\/dyn\.js:2 builds "zzz\.\*", which matches no key in the catalog/);
});

test('catalogs are read from DIALECTO_CATALOGS', () => {
  const root = makeSite();
  write(root, 'locales/en.json', '{"home.title":"Home"}\n');
  const run = cli(root, ['check'], { DIALECTO_CATALOGS: 'locales' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /src\/page\.js:4 reads "nav\.\*" but none of its 2 keys is in the catalog/);
  assert.doesNotMatch(run.stderr, /home\.title/);
});

test('a missing catalogs folder and a missing scanner are explained', () => {
  const root = makeSite();
  const noCatalogs = cli(root, ['usages'], { DIALECTO_CATALOGS: 'nowhere' });
  assert.equal(noCatalogs.status, 1);
  assert.match(noCatalogs.stderr, /catalogs folder nowhere not found/);

  const bare = makeSite({ scanner: false });
  const noScanner = cli(bare, ['usages']);
  assert.equal(noScanner.status, 1);
  assert.match(noScanner.stderr, /dialecto-usages\.mjs not found: copy it into the same folder/);
  assert.equal(cli(bare, ['check']).status, 1);
});

test('without parsers check refuses to pass', () => {
  const root = makeSite();
  rmSync(path.join(root, 'node_modules'));
  const run = cli(root, ['check']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no JavaScript parser found/);
  assert.match(run.stderr, /check cannot run without the parsers/);
});

test('unknown commands and flags print the usage', () => {
  const root = makeSite();
  for (const args of [[], ['frobnicate'], ['usages', '--bogus'], ['usages', '--out'], ['check', '--summary']]) {
    const run = cli(root, args);
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /usage: node tooling\/dialecto-in-context\.mjs scan/);
  }
});
