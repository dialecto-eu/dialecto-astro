import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkUsages, classifyKeys, isTestFile } from '../dialecto-usages.mjs';
import { scanSources, scanSubset } from './usages_helpers.mjs';

const classify = (result, keys, extra = {}) => classifyKeys(result.usages, keys, { unscanned: result.unscanned, ...extra });

// ---------------------------------------------------------------- classification on fixtures

test('a key read only by a static literal is alone; a key nothing reads is unreached', async () => {
  const result = await scanSubset(['01-single-quote.js']);
  const classes = classify(result, ['a.b', 'c.d']);
  assert.deepEqual(classes['a.b'], { class: 'alone' });
  assert.deepEqual(classes['c.d'], { class: 'unreached' });
});

test('a key reached by a set is family, with the prefix its template starts with', async () => {
  const result = await scanSubset(['26-array-map.js']);
  const classes = classify(result, ['tab.home.label', 'tab.about.label', 'tab.news.label', 'a.b']);
  for (const key of ['tab.home.label', 'tab.about.label', 'tab.news.label']) assert.deepEqual(classes[key], { class: 'family', prefix: 'tab.' }, key);
  assert.deepEqual(classes['a.b'], { class: 'unreached' });
});

test('the family prefix comes from the declaration when a local constant holds the template head', async () => {
  const result = await scanSubset(['25-local-const.js']);
  const classes = classify(result, ['lesson.beat.cover.heading', 'lesson.beat.many.body']);
  assert.deepEqual(classes['lesson.beat.cover.heading'], { class: 'family', prefix: 'lesson.beat.' });
  assert.deepEqual(classes['lesson.beat.many.body'], { class: 'family', prefix: 'lesson.beat.' });
});

test('two templates reaching a key share the longest dotted prefix', async () => {
  const result = await scanSubset(['29-two-templates.js']);
  const classes = classify(result, ['lesson.takeaway.add.heading', 'lesson.takeaway.build.text']);
  assert.deepEqual(classes['lesson.takeaway.add.heading'], { class: 'family', prefix: 'lesson.takeaway.' });
  assert.deepEqual(classes['lesson.takeaway.build.text'], { class: 'family', prefix: 'lesson.takeaway.' });
});

test('a shared template with no fixed dotted start locks its keys: no group rename can rewrite it', async () => {
  const source = "import { t } from './i18n.js';\nconst AREAS = ['nav', 'footer'];\nexport const labels = AREAS.map((area) => t(`${area}.label`));\n";
  const result = await scanSources({ 'src/labels.js': source });
  assert.equal(result.usages[0].kind, 'set');
  const classes = classify(result, ['nav.label', 'footer.label']);
  for (const key of ['nav.label', 'footer.label']) {
    assert.equal(classes[key].class, 'locked', key);
    assert.deepEqual(
      classes[key].reasons.map(({ type, file, line }) => ({ type, file, line })),
      [{ type: 'shared_template', file: 'src/labels.js', line: 3 }],
      key,
    );
  }
});

test('an unresolved pattern locks the keys it could reach, with the pattern and its file:line', async () => {
  const result = await scanSubset(['04-pattern.js']);
  const classes = classify(result, ['a.b', 'c.d']);
  assert.equal(classes['a.b'].class, 'locked');
  assert.equal(classes['a.b'].reasons.length, 1);
  assert.deepEqual(
    { type: classes['a.b'].reasons[0].type, pattern: classes['a.b'].reasons[0].pattern, file: classes['a.b'].reasons[0].file, line: classes['a.b'].reasons[0].line },
    { type: 'pattern', pattern: 'a.*', file: '04-pattern.js', line: 3 },
  );
  assert.deepEqual(classes['c.d'], { class: 'unreached' });
});

test('a key reached by two patterns lists both; a key outside them stays alone', async () => {
  const result = await scanSubset(['13-prefix.js']);
  const classes = classify(result, ['home.card.notes.title', 'home.hero.title']);
  assert.equal(classes['home.card.notes.title'].class, 'locked');
  assert.deepEqual(classes['home.card.notes.title'].reasons.map((r) => [r.pattern, r.line]).sort(), [['home.card.*', 5], ['home.card.*.title', 3]]);
  assert.deepEqual(classes['home.hero.title'], { class: 'alone' });
});

test('an unresolved pattern wins over a literal use of the same key', async () => {
  const result = await scanSubset(['01-single-quote.js', '04-pattern.js']);
  assert.equal(classify(result, ['a.b'])['a.b'].class, 'locked');
});

test('unscanned files lock every key, with the files as the reason', async () => {
  const result = await scanSubset(['01-single-quote.js', '26-array-map.js']);
  const unscanned = [{ file: 'src/Widget.vue', reason: 'Vue files are not read by the scanner' }];
  const classes = classifyKeys(result.usages, ['a.b', 'tab.home.label', 'c.d'], { unscanned });
  for (const key of ['a.b', 'tab.home.label', 'c.d']) {
    assert.equal(classes[key].class, 'locked', key);
    assert.deepEqual(classes[key].reasons, [{ type: 'unscanned', file: 'src/Widget.vue', reason: 'Vue files are not read by the scanner' }], key);
  }
});

test('classification is a pure function of usages and keys', async () => {
  const result = await scanSubset(['13-prefix.js', '26-array-map.js']);
  const keys = ['home.card.notes.title', 'tab.home.label', 'x.y'];
  assert.deepEqual(classify(result, keys), classify(result, [...keys].reverse()));
});

// ---------------------------------------------------------------- check

const HEAD = "import { t } from './i18n.js';\n";

test('a use of a key that no longer exists is a problem, with file:line', async () => {
  const result = await scanSources({ 'src/page.js': `${HEAD}\nexport const title = t('home.title');\n` });
  const { problems, warnings } = checkUsages(result.usages, ['home.heading']);
  assert.equal(warnings.length, 0);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].type, 'missing_key');
  assert.equal(problems[0].key, 'home.title');
  assert.equal(problems[0].file, 'src/page.js');
  assert.equal(problems[0].line, 3);
  assert.match(problems[0].message, /^src\/page\.js:3 /);
});

test('a key that exists passes', async () => {
  const result = await scanSources({ 'src/page.js': `${HEAD}t('home.title');\n` });
  assert.deepEqual(checkUsages(result.usages, ['home.title']), { problems: [], warnings: [] });
});

test('a set with one missing member passes, and fails when every member is missing', async () => {
  const set = `${HEAD}const IDS = ['one', 'two'];\nexport const labels = IDS.map((id) => t(\`nav.\${id}\`));\n`;
  const result = await scanSources({ 'src/nav.js': set });
  assert.equal(result.usages[0].kind, 'set');
  assert.deepEqual(checkUsages(result.usages, ['nav.one']), { problems: [], warnings: [] });

  const { problems } = checkUsages(result.usages, ['home.heading']);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].type, 'missing_keys');
  assert.deepEqual(problems[0].keys, ['nav.one', 'nav.two']);
  assert.equal(problems[0].file, 'src/nav.js');
  assert.equal(problems[0].line, 3);
});

test('a use in a test file is a warning, not a problem', async () => {
  const sources = {
    'tests/i18n.test.js': `${HEAD}t('no.such.key');\n`,
    'src/a.spec.ts': `${HEAD}t('no.such.either');\n`,
    'src/__tests__/b.js': `${HEAD}t('nor.this');\n`,
    'src/page.js': `${HEAD}t('home.title');\n`,
  };
  const result = await scanSources(sources);
  const { problems, warnings } = checkUsages(result.usages, ['home.title']);
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings.map((w) => [w.file, w.type]).sort(), [['src/__tests__/b.js', 'missing_key'], ['src/a.spec.ts', 'missing_key'], ['tests/i18n.test.js', 'missing_key']]);
  assert.match(warnings.find((w) => w.file === 'tests/i18n.test.js').message, /^tests\/i18n\.test\.js:2 /);
});

test('an unresolved pattern whose fixed start matches no catalog key is a problem', async () => {
  const source = `${HEAD}export const x = t(\`zzz.\${window.location.hash}\`);\n`;
  const result = await scanSources({ 'src/page.js': source });
  assert.equal(result.usages[0].kind, 'pattern');
  const { problems } = checkUsages(result.usages, ['home.title']);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].type, 'no_matching_keys');
  assert.equal(problems[0].pattern, 'zzz.*');
  assert.equal(problems[0].line, 2);

  assert.deepEqual(checkUsages(result.usages, ['zzz.a', 'home.title']), { problems: [], warnings: [] });
});

test('a pattern with no fixed start, and a use from outside the code, are not checked', async () => {
  const source = `${HEAD}t(window.location.hash);\nt(\`\${window.name}.x\`);\n`;
  const result = await scanSources({ 'src/page.js': source });
  assert.deepEqual(checkUsages(result.usages, ['home.title']), { problems: [], warnings: [] });
});

test('isTestFile recognises test files by name and by folder only', () => {
  for (const file of ['a.test.js', 'src/a.spec.ts', 'tests/x.js', 'test/x.js', 'src/__tests__/x.js', 'pkg/tests/deep/x.js']) assert.equal(isTestFile(file), true, file);
  for (const file of ['src/latest/x.js', 'src/contest.js', 'src/attests.js', 'src/test-utils.js']) assert.equal(isTestFile(file), false, file);
});
