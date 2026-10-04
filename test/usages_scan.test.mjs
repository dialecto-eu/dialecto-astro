import assert from 'node:assert/strict';
import { test } from 'node:test';

import { USAGES_VERSION, countUses, loadParsers, scanProject } from '../dialecto-usages.mjs';
import { EXPECTED, SDK, byFile, expectedByFile, scanFixtures, scanSources } from './usages_helpers.mjs';

test('the scanner has a plain semver version', () => {
  assert.match(USAGES_VERSION, /^\d+\.\d+\.\d+$/);
});

test('every fixture reproduces the validated records exactly', async () => {
  const { usages, unscanned } = await scanFixtures();
  assert.deepEqual(unscanned, []);
  const mine = byFile(usages);
  const expected = expectedByFile();
  assert.deepEqual(Object.keys(mine), Object.keys(expected));
  for (const file of Object.keys(expected)) assert.deepEqual(mine[file], expected[file], file);
});

test('the golden file covers the fixture files that read keys', () => {
  const withRecords = Object.entries(EXPECTED.usages).filter(([, list]) => list.length).map(([file]) => file);
  assert.ok(withRecords.length >= 35, `${withRecords.length} fixture files with records`);
  assert.ok(EXPECTED.catalog_keys.length > 30);
});

test('forcing the Babel fallback gives identical records', async () => {
  const rolldown = await scanFixtures();
  const babel = await scanFixtures({ skip: ['rolldown'] });
  assert.equal(rolldown.parsers.report.js, 'rolldown');
  assert.equal(babel.parsers.report.js, 'babel');
  assert.equal(babel.parsers.report.astro, 'compiler-rs');
  assert.deepEqual(babel.unscanned, []);
  assert.deepEqual(byFile(babel.usages), byFile(rolldown.usages));
});

test('loadParsers reports what it found, with versions', async () => {
  const parsers = await loadParsers(SDK);
  assert.equal(parsers.report.js, 'rolldown');
  assert.equal(parsers.report.astro, 'compiler-rs');
  assert.match(parsers.report.versions.rolldown, /^\d+\.\d+\.\d+/);
  assert.match(parsers.report.versions['@astrojs/compiler-rs'], /^\d+\.\d+\.\d+/);

  const none = await loadParsers(SDK, { skip: ['rolldown', 'babel', 'astro'] });
  assert.equal(none.js, null);
  assert.equal(none.astro, null);

  const missing = await loadParsers('/nonexistent/project');
  assert.equal(missing.report.js, null);
  assert.equal(missing.report.astro, null);
});

test('a file that fails to parse becomes an unscanned entry; the rest is still scanned', async () => {
  const result = await scanSources({
    'bad.js': 'const = ;\n',
    'good.js': "import { t } from './i18n.js';\nt('a.b');\n",
  });
  assert.equal(result.unscanned.length, 1);
  assert.equal(result.unscanned[0].file, 'bad.js');
  assert.match(result.unscanned[0].reason, /could not be parsed/);
  assert.deepEqual(result.usages.map((u) => u.key), ['a.b']);
});

test('Vue, Svelte and MDX files are unscanned with a reason', async () => {
  const result = await scanSources({ 'a.vue': '<template />', 'b.svelte': '<p/>', 'c.mdx': '# hi', 'd.md': '# prose', 'e.css': 'a{}' });
  assert.deepEqual(result.unscanned.map((u) => u.file), ['a.vue', 'b.svelte', 'c.mdx']);
  assert.match(result.unscanned[0].reason, /Vue/);
  assert.match(result.unscanned[1].reason, /Svelte/);
  assert.match(result.unscanned[2].reason, /MDX/);
});

test('without parsers every source file is unscanned and nothing throws', () => {
  const result = scanProject({ files: new Map([['a.js', "t('a.b')"], ['b.astro', '---\n---\n']]), parsers: null });
  assert.deepEqual(result.unscanned.map((u) => u.file), ['a.js', 'b.astro']);
  for (const u of result.unscanned) assert.match(u.reason, /no parser available/);
  assert.deepEqual(result.usages, []);
});

test('odd input never throws', async () => {
  const result = await scanSources({
    'empty.js': '',
    'comments.js': '// t("a.b")\n/* t("a.c") */\n',
    'noncall.js': "const t = 'a.b';\nexport default t;\n",
    'weird.ts': 'export type K = `a.${string}`;\ndeclare const t: (k: string) => string;\nt(...args);\nt();\n',
    'deep.js': `export const v = ${'['.repeat(300)}${']'.repeat(300)};\n`,
    'unicode.js': "import { t } from './i18n.js';\nt('日本語.🙂');\n",
  });
  assert.deepEqual(result.unscanned, []);
  assert.deepEqual(result.usages.map((u) => [u.file, u.key]), [['unicode.js', '日本語.🙂']]);
});

test('config.exclude drops files and whole directories', async () => {
  const sources = {
    'src/a.js': "t('a.b');\n",
    'legacy/old.js': "t('a.c');\n",
    'src/gen/x.gen.js': "t('a.d');\n",
    'node_modules/pkg/index.js': "t('a.e');\n",
  };
  const all = await scanSources(sources);
  assert.deepEqual(all.usages.map((u) => u.key).sort(), ['a.b', 'a.c', 'a.d', 'a.e']);
  const some = await scanSources(sources, { config: { exclude: ['legacy', 'src/**/*.gen.js', 'node_modules'] } });
  assert.deepEqual(some.usages.map((u) => u.key), ['a.b']);
});

test('with no i18n modules, an import is a translate function by its imported name', async () => {
  const source = { 'a.js': "import { t as runtimeT } from './i18n.js';\nexport const x = runtimeT('a.b');\n" };
  const byName = await scanSources(source);
  assert.equal(byName.usages.length, 1);
  assert.equal(byName.usages[0].kind, 'static');
  assert.equal(byName.usages[0].origin, 'name');
  assert.equal(byName.usages[0].fn, 'runtimeT');

  const byOrigin = await scanSources(source, { config: { modules: ['i18n.js'] } });
  assert.equal(byOrigin.usages.length, 1);
  assert.equal(byOrigin.usages[0].origin, 'import');

  const unrelated = await scanSources({ 'a.js': "import { other as runtimeT } from './i18n.js';\nruntimeT('a.b');\n" });
  assert.deepEqual(unrelated.usages, []);
});

test('config.names and config.factories widen what counts as a translate function', async () => {
  const source = { 'a.js': "const msg = getMsg('en');\nmsg('a.b');\nint('a.c');\n" };
  assert.deepEqual((await scanSources(source)).usages, []);
  const result = await scanSources(source, { config: { names: ['int'], factories: ['getMsg'] } });
  assert.deepEqual(result.usages.map((u) => [u.key, u.origin]).sort(), [['a.b', 'factory'], ['a.c', 'name']]);
});

test('countUses counts merged same-line uses separately', async () => {
  const result = await scanSources({ 'a.js': "import { t } from './i18n.js';\nconst x = [t('a.b'), t('a.b')];\nt('a.c');\n" });
  assert.deepEqual(countUses(result.usages), { static: 3, set: 0, pattern: 0, opaque: 0 });
  assert.ok(result.usages.some((u) => u.occurrences === 2));
});

test('catalog keys turn a key-valued string outside a translate call into a literal record', async () => {
  const result = await scanSources({ 'a.js': "export const prefixes = ['map.', 'x.y'];\n" }, { catalogKeys: ['map.one', 'x.y'] });
  assert.deepEqual(result.usages.map((u) => [u.kind, u.key]).sort(), [['literal', 'map.'], ['literal', 'x.y']]);
  assert.equal(result.sweep.length, 2);
});
