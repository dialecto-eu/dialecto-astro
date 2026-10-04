import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ADDON_VERSION, resolveSettings } from '../dialecto-in-context.mjs';

const root = '/site';

test('the usage scan settings default to empty lists', () => {
  const s = resolveSettings({}, {}, root);
  assert.deepEqual([s.i18nModules, s.i18nFactories, s.i18nNames, s.usagesExclude], [[], [], [], []]);
});

test('the usage scan settings read comma-separated env vars, trimmed', () => {
  const env = {
    DIALECTO_I18N_MODULES: ' src/i18n/index.js , src/i18n/runtime.js,, ',
    DIALECTO_I18N_FACTORIES: 'getTranslator',
    DIALECTO_I18N_NAMES: 't,tr,$t',
    DIALECTO_USAGES_EXCLUDE: 'legacy/**,**/*.gen.js',
  };
  const s = resolveSettings(env, {}, root);
  assert.deepEqual(s.i18nModules, ['src/i18n/index.js', 'src/i18n/runtime.js']);
  assert.deepEqual(s.i18nFactories, ['getTranslator']);
  assert.deepEqual(s.i18nNames, ['t', 'tr', '$t']);
  assert.deepEqual(s.usagesExclude, ['legacy/**', '**/*.gen.js']);
});

test('the usage scan settings resolve option > env > default, as arrays or strings', () => {
  const env = { DIALECTO_I18N_MODULES: 'env/a.js', DIALECTO_USAGES_EXCLUDE: 'env/**' };
  const s = resolveSettings(env, { i18nModules: ['opt/a.js', 'opt/b.js'], usagesExclude: 'opt/**, other/**' }, root);
  assert.deepEqual(s.i18nModules, ['opt/a.js', 'opt/b.js']);
  assert.deepEqual(s.usagesExclude, ['opt/**', 'other/**']);
  assert.deepEqual(resolveSettings(env, { i18nModules: [] }, root).i18nModules, ['env/a.js']);
});

test('ADDON_VERSION keeps the line format the server parses', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../dialecto-in-context.mjs', import.meta.url), 'utf8');
  const line = source.split('\n').find((l) => l.startsWith('export const ADDON_VERSION'));
  assert.match(line, /^export const ADDON_VERSION = '(\d+\.\d+\.\d+)';$/);
  assert.equal(line.match(/'(.+)'/)[1], ADDON_VERSION);
});
