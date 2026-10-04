import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { catalogPathMatcher, resolveSettings } from '../dialecto-in-context.mjs';
import { ADDON } from './usages_helpers.mjs';

// ADR-0020: the add-on's `scan` sends only the files the project's confirmed paths name (DIALECTO_CATALOG_PATHS),
// matched by Dialecto's own glob rules, so CI never sends what Dialecto would refuse.

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

function makeSite() {
  const root = mkdtempSync(path.join(tmpdir(), 'dialecto-paths-'));
  temps.push(root);
  git(root, 'init', '-q', '-b', 'main');
  write(root, '.gitignore', 'tooling\n');
  write(root, 'src/i18n/messages/en.json', '{"a":"A"}\n');
  write(root, 'src/i18n/messages/de.json', '{"a":"Ä"}\n');
  write(root, 'src/i18n/messages/index.json', '{"secret":"no"}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'site');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  mkdirSync(path.join(root, 'tooling'));
  copyFileSync(ADDON, path.join(root, 'tooling/dialecto-in-context.mjs'));
  return root;
}

async function scanSite(root, env) {
  const addon = await import(pathToFileURL(path.join(root, 'tooling/dialecto-in-context.mjs')).href);
  const settings = addon.resolveSettings({ DIALECTO_URL: 'https://dialecto.test', DIALECTO_PROJECT: '7', DIALECTO_SCAN_TOKEN: 't', ...env }, {}, root);
  let body = null;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/scans')) body = JSON.parse(options.body);
    return url.endsWith('/scan-config') ? { ok: true, status: 200 } : { ok: true, status: 201, json: async () => ({ outcome: 'ingested' }) };
  };
  const result = await addon.scan(settings, { fetchImpl });
  return { result, body };
}

test('the matcher follows Dialecto: ** spans folders, * stays in one, nothing reaches a dot', () => {
  const matches = catalogPathMatcher(['config/**/*.yml', 'src/i18n/messages/*.json', 'locales/??.json']);

  assert.equal(matches('config/locales/en.yml'), true);
  assert.equal(matches('config/en.yml'), true);
  assert.equal(matches('config/.secrets/en.yml'), false);
  assert.equal(matches('src/i18n/messages/en.json'), true);
  assert.equal(matches('src/i18n/messages/nested/en.json'), false);
  assert.equal(matches('src/i18n/messages/.env.json'), false);
  assert.equal(matches('locales/en.json'), true);
  assert.equal(matches('locales/.e.json'), false);
  assert.equal(matches('src/i18n/messagesXen.json'), false);
});

test('DIALECTO_CATALOG_PATHS is a comma-separated list; an option wins', () => {
  const root = '/site';
  assert.deepEqual(resolveSettings({ DIALECTO_CATALOG_PATHS: ' a/*.json, b/en.json ' }, {}, root).catalogPaths, ['a/*.json', 'b/en.json']);
  assert.deepEqual(resolveSettings({ DIALECTO_CATALOG_PATHS: 'a/*.json' }, { catalogPaths: ['c/*.json'] }, root).catalogPaths, ['c/*.json']);
  assert.deepEqual(resolveSettings({}, {}, root).catalogPaths, []);
});

test('the scan sends only the files the paths name', async () => {
  const root = makeSite();

  const { result, body } = await scanSite(root, { DIALECTO_CATALOG_PATHS: 'src/i18n/messages/en.json,src/i18n/messages/de.json' });

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(body.templates.map((t) => t.path), ['src/i18n/messages/de.json', 'src/i18n/messages/en.json']);
});

test('without paths every catalog in the folder is sent, as before', async () => {
  const { body } = await scanSite(makeSite(), {});

  assert.equal(body.templates.length, 3);
});

test('paths that name none of the catalogs stop the scan, saying so', async () => {
  const { result, body } = await scanSite(makeSite(), { DIALECTO_CATALOG_PATHS: 'locales/*.json' });

  assert.equal(result.ok, false);
  assert.equal(body, null);
  assert.match(result.message, /no catalogs in src\/i18n\/messages match DIALECTO_CATALOG_PATHS \(locales\/\*\.json\)/);
});
