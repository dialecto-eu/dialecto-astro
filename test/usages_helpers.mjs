// Shared setup for the usage scanner tests (not a test file itself).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadParsers, scanProject } from '../dialecto-usages.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SDK = path.resolve(here, '..');
export const ADDON = path.join(SDK, 'dialecto-in-context.mjs');
export const FIXTURES = path.join(here, 'fixtures', 'usages');
export const EXPECTED = JSON.parse(readFileSync(path.join(here, 'fixtures', 'usages-expected.json'), 'utf8'));

// The fixture project's own i18n modules, as fixture files import them.
export const FIXTURE_CONFIG = { modules: ['i18n.js', 'i18n/index.js', 'i18n/runtime.js'] };

export const fixtureSources = (only = null) => {
  const files = new Map();
  for (const name of readdirSync(FIXTURES).sort()) {
    if (!only || only.includes(name)) files.set(name, readFileSync(path.join(FIXTURES, name), 'utf8'));
  }
  return files;
};

/** Every fixture scanned as one project; fixture 16 (literal mentions) is the one that needs the catalog keys. */
export async function scanFixtures({ skip = [] } = {}) {
  const parsers = await loadParsers(SDK, { skip });
  const files = fixtureSources();
  const names = [...files.keys()];
  const withKeys = scanProject({ files, config: FIXTURE_CONFIG, parsers, catalogKeys: EXPECTED.catalog_keys, only: new Set(names.filter((n) => n.startsWith('16-'))) });
  const withoutKeys = scanProject({ files, config: FIXTURE_CONFIG, parsers, only: new Set(names.filter((n) => !n.startsWith('16-'))) });
  return {
    parsers,
    usages: [...withoutKeys.usages, ...withKeys.usages],
    unscanned: [...withoutKeys.unscanned, ...withKeys.unscanned],
  };
}

/** A subset of the fixtures as its own small project. */
export async function scanSubset(names, catalogKeys = null) {
  const parsers = await loadParsers(SDK);
  return scanProject({ files: fixtureSources(names), config: FIXTURE_CONFIG, parsers, catalogKeys });
}

/** Source text in memory as a project, with the parsers the SDK has installed. */
export async function scanSources(sources, { config = {}, catalogKeys = null } = {}) {
  const parsers = await loadParsers(SDK);
  return scanProject({ files: new Map(Object.entries(sources)), config, parsers, catalogKeys });
}

const order = (a, b) => a.start_line - b.start_line || a.end_line - b.end_line || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.content < b.content ? -1 : a.content > b.content ? 1 : 0)
  || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

/** Records grouped by file, in a deterministic order, through a JSON round trip (as they travel). */
export function byFile(usages) {
  const grouped = {};
  for (const u of JSON.parse(JSON.stringify(usages))) (grouped[u.file] ??= []).push(u);
  for (const list of Object.values(grouped)) list.sort(order);
  return Object.fromEntries(Object.entries(grouped).filter(([, list]) => list.length).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export const expectedByFile = () => byFile(Object.values(EXPECTED.usages).flat());
