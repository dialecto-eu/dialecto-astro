// Dialecto usage scanner: finds where a project's code reads JSON catalog keys, by reading the code
// (never running it), so a key rename can be completed in the code and checked afterwards.
//
// One self-contained module with only Node built-ins. It lives in a customer's project next to
// dialecto-in-context.mjs (for example `tooling/`), which loads it for `usages` and `check`. The JS, TS and
// JSX parsers come from the project's own node_modules (Astro 7 and Vite 8 install them): rolldown's
// `parseAst`, falling back to `@babel/parser`, and `@astrojs/compiler-rs` for `.astro` files.
//
// Usage record (one per place that reads a key):
//   { file, form, fn, origin, rules[],
//     kind: 'static' | 'set' | 'pattern' | 'opaque' | 'literal' | 'template',
//     key?       (static, literal)     the decoded key
//     keys?      (set)                 the exact keys the use can read, evaluated from constants
//     pattern? parts?  (set, pattern, template)   the key text with wildcards, e.g. "lesson.beat.*.heading"
//     reason?    (pattern, opaque)     why the use could not be made exact
//     via?       (set, pattern)        ids of `template` records whose head literal feeds this use
//     id?        (template)            the declaration or helper body whose literal head feeds uses elsewhere
//     start_line, end_line, content    a small anchor, verbatim bytes of the file
//     spans?     [{ start, end, delim, lang, closed, head? }]  the key text inside `content`, in UTF-8 bytes
//     calls      [[start, end]]        absolute offsets of the translate or helper calls behind the record
//     occurrences?                     identical same-line uses merged into one record }
//
// The rule everywhere: when unsure, leave a use as an unresolved pattern. A key set may list a key the code
// never reads (a guard the scanner does not read), but it must never miss one.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const USAGES_VERSION = '1.0.0';

export const DEFAULT_NAMES = ['t', 'tr', '$t'];
export const DEFAULT_FACTORIES = ['getTranslator', 'createTranslator', 'useTranslations', 'useTranslation'];

// ---------------------------------------------------------------- tree helpers

const SKIP_KEYS = new Set([
  'loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments',
  'typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeParameters', 'decorators',
]);

function walk(node, visit, parent = null) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, parent);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') {
    if (/^TS(Interface|TypeAlias|Type|Declare|Module|Enum)/.test(node.type) && node.type !== 'TSEnumDeclaration') return;
    if (visit(node, parent) === false) return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (SKIP_KEYS.has(k) || !v || typeof v !== 'object') continue;
    walk(v, visit, node);
  }
}

const isStr = (n) => n && (n.type === 'StringLiteral' || (n.type === 'Literal' && typeof n.value === 'string'));
const isNum = (n) => n && (n.type === 'NumericLiteral' || (n.type === 'Literal' && typeof n.value === 'number'));
const isTpl = (n) => n && n.type === 'TemplateLiteral';
const isCall = (n) => n && (n.type === 'CallExpression' || n.type === 'OptionalCallExpression');
const isMember = (n) => n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression');
const isProp = (n) => n && (n.type === 'Property' || n.type === 'ObjectProperty');
const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration');

function unwrap(n) {
  while (n && (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSNonNullExpression'
    || n.type === 'TSTypeAssertion' || n.type === 'ParenthesizedExpression' || n.type === 'ChainExpression')) n = n.expression;
  return n;
}

function propKeyName(p) {
  if (p.computed) return null;
  if (p.key?.type === 'Identifier') return p.key.name;
  if (isStr(p.key)) return p.key.value;
  if (isNum(p.key)) return String(p.key.value);
  return null;
}

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Identifier nodes bound by a binding pattern. */
function patternIds(p, out = []) {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier': out.push(p); break;
    case 'ObjectPattern': for (const q of p.properties) patternIds(isProp(q) ? q.value : q, out); break;
    case 'ArrayPattern': for (const q of p.elements) patternIds(q, out); break;
    case 'AssignmentPattern': patternIds(p.left, out); break;
    case 'RestElement': patternIds(p.argument, out); break;
    default: break;
  }
  return out;
}

// ---------------------------------------------------------------- module model: parents, scopes, bindings

function buildModule(project, file, src, parsed, parserName) {
  const M = {
    project, file, src, tree: parsed.tree, parser: parserName,
    parents: new Map(), tables: new Map(), reassignedMemo: new Map(), mutatedMemo: new Map(), constMemo: new Map(),
    lineOf: lineIndex(src), exportsMemo: null,
  };
  walk(M.tree, (n, parent) => { if (parent) M.parents.set(n, parent); });
  M.isAstro = file.endsWith('.astro');
  M.program = M.isAstro ? M.tree.frontmatter?.program ?? null : M.tree;
  return M;
}

const parentOf = (M, n) => M.parents.get(n) ?? null;

/** Nearest ancestors first. Stops at an Astro `<script>` program, which is a separate module scope. */
function* ancestors(M, n) {
  let cur = M.parents.get(n);
  while (cur) {
    yield cur;
    if (cur.type === 'Program' && M.parents.get(cur)?.type === 'AstroScript') return;
    cur = M.parents.get(cur);
  }
}

function addDecl(table, stmt, scope, exported = false) {
  const add = (name, b) => { if (!table.has(name)) table.set(name, { ...b, exported }); };
  if (!stmt) return;
  switch (stmt.type) {
    case 'VariableDeclaration':
      for (const d of stmt.declarations) for (const id of patternIds(d.id)) add(id.name, { kind: 'var', declKind: stmt.kind, idNode: id, declarator: d, scope });
      break;
    case 'FunctionDeclaration': if (stmt.id) add(stmt.id.name, { kind: 'function', node: stmt, idNode: stmt.id, scope }); break;
    case 'ClassDeclaration': if (stmt.id) add(stmt.id.name, { kind: 'class', idNode: stmt.id, scope }); break;
    case 'ImportDeclaration':
      for (const s of stmt.specifiers) {
        const imported = s.type === 'ImportSpecifier' ? (s.imported.name ?? s.imported.value) : s.type === 'ImportDefaultSpecifier' ? 'default' : '*';
        add(s.local.name, { kind: 'import', source: stmt.source.value, imported, idNode: s.local, scope });
      }
      break;
    case 'ExportNamedDeclaration': addDecl(table, stmt.declaration, scope, true); break;
    case 'ExportDefaultDeclaration': if (stmt.declaration?.type === 'FunctionDeclaration') addDecl(table, stmt.declaration, scope, true); break;
    default: break;
  }
}

function scopeTable(M, node) {
  if (node.type === 'AstroRoot') return M.program ? scopeTable(M, M.program) : new Map();
  const memo = M.tables.get(node);
  if (memo) return memo;
  const table = new Map();
  const add = (name, b) => { if (!table.has(name)) table.set(name, b); };
  if (isFn(node)) {
    node.params.forEach((p, i) => { for (const id of patternIds(p)) add(id.name, { kind: 'param', idNode: id, fn: node, index: i, pattern: p }); });
    if (node.type === 'FunctionExpression' && node.id) add(node.id.name, { kind: 'fname', node, idNode: node.id });
  } else if (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock') {
    for (const stmt of node.body) addDecl(table, stmt, node);
  } else if (node.type === 'SwitchStatement') {
    for (const c of node.cases) for (const stmt of c.consequent) addDecl(table, stmt, node);
  } else if (node.type === 'ForStatement') {
    if (node.init?.type === 'VariableDeclaration') addDecl(table, node.init, node);
  } else if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
    if (node.left?.type === 'VariableDeclaration') {
      for (const d of node.left.declarations) for (const id of patternIds(d.id)) add(id.name, { kind: 'loop', idNode: id, loop: node, pattern: d.id });
    }
  } else if (node.type === 'CatchClause') {
    for (const id of patternIds(node.param)) add(id.name, { kind: 'catch', idNode: id });
  }
  // `var` is function-scoped: a declaration in a nested block still binds here, shadowing outer names.
  if (isFn(node) || node.type === 'Program') {
    const body = isFn(node) ? node.body : node;
    walk(body, (n) => {
      if (n !== body && isFn(n)) return false;
      if (n.type === 'VariableDeclaration' && n.kind === 'var') {
        for (const d of n.declarations) for (const id of patternIds(d.id)) if (!table.has(id.name)) table.set(id.name, { kind: 'var', declKind: 'var', idNode: id, declarator: d, scope: node });
      }
      return undefined;
    });
  }
  M.tables.set(node, table);
  return table;
}

/** Innermost binding for `name` as seen from `fromNode`, or null (a global or unknown name). */
function lookup(M, name, fromNode) {
  for (const anc of ancestors(M, fromNode)) {
    const b = scopeTable(M, anc).get(name);
    if (b) return b;
  }
  return null;
}

/** Is the binding assigned again after its declaration (let/var, or a plain Identifier assignment)? */
function isReassigned(M, b) {
  if (b.kind !== 'var') return false;
  if (b.declKind === 'const') return false;
  const memo = M.reassignedMemo.get(b.idNode);
  if (memo !== undefined) return memo;
  const name = b.idNode.name;
  let hit = false;
  const mentions = (target) => patternIds(target).some((id) => id.name === name) || (target?.type === 'Identifier' && target.name === name);
  walk(b.scope, (n) => {
    if (hit) return false;
    if (n.type === 'AssignmentExpression' && mentions(n.left)) hit = true;
    else if (n.type === 'UpdateExpression' && n.argument?.type === 'Identifier' && n.argument.name === name) hit = true;
    else if ((n.type === 'ForOfStatement' || n.type === 'ForInStatement') && n.left?.type === 'Identifier' && n.left.name === name) hit = true;
    return undefined;
  });
  M.reassignedMemo.set(b.idNode, hit);
  return hit;
}

/** Is a parameter or loop variable assigned again in its function or loop, so its incoming value is not what is read? */
function paramReassigned(M, b) {
  const memo = M.reassignedMemo.get(b.idNode);
  if (memo !== undefined) return memo;
  const scope = b.kind === 'param' ? b.fn : b.loop;
  const name = b.idNode.name;
  let hit = false;
  walk(b.kind === 'param' ? b.fn.body : scope.body, (n) => {
    if (hit) return false;
    if (n.type === 'AssignmentExpression' && (patternIds(n.left).some((id) => id.name === name) || (unwrap(n.left)?.type === 'Identifier' && unwrap(n.left).name === name)) && lookup(M, name, n) === b) hit = true;
    else if (n.type === 'UpdateExpression' && unwrap(n.argument)?.type === 'Identifier' && unwrap(n.argument).name === name && lookup(M, name, unwrap(n.argument)) === b) hit = true;
    return undefined;
  });
  M.reassignedMemo.set(b.idNode, hit);
  return hit;
}

const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);
const OBJECT_MUTATORS = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']);

const rootName = (n) => {
  n = unwrap(n);
  while (isMember(n)) n = unwrap(n.object);
  return n?.type === 'Identifier' ? n.name : null;
};

/** Is a const object or array ever changed in place within its own module (member assignment, push, defineProperty)? */
function isMutated(M, b) {
  const memo = M.mutatedMemo.get(b.idNode);
  if (memo !== undefined) return memo;
  const name = b.idNode.name;
  let hit = false;
  walk(M.tree, (n) => {
    if (hit) return false;
    if (n.type === 'AssignmentExpression' && isMember(unwrap(n.left)) && rootName(n.left) === name) hit = true;
    else if (n.type === 'UpdateExpression' && isMember(unwrap(n.argument)) && rootName(n.argument) === name) hit = true;
    else if (isCall(n)) {
      const c = unwrap(n.callee);
      if (isMember(c) && !c.computed && c.property?.type === 'Identifier') {
        if (MUTATORS.has(c.property.name) && rootName(c.object) === name) hit = true;
        if (c.object?.type === 'Identifier' && c.object.name === 'Object' && OBJECT_MUTATORS.has(c.property.name) && rootName(n.arguments[0]) === name) hit = true;
      }
    }
    return undefined;
  });
  M.mutatedMemo.set(b.idNode, hit);
  return hit;
}

/**
 * Does evaluating `fn`'s body as a pure expression risk being wrong because something changes in place? A change
 * counts when it targets a variable of `fn` itself (its params and locals) or a variable a nested function
 * captures from `fn`. A nested function changing only its own locals is fine: it is checked when it is evaluated.
 */
function bodyMutates(M, fn) {
  let hit = false;
  const ownerFn = (n) => { for (const a of ancestors(M, n)) if (isFn(a)) return a; return null; };
  const inside = (node, container) => {
    if (node === container) return true;
    for (const a of ancestors(M, node)) if (a === container) return true;
    return false;
  };
  const check = (n, target) => {
    const name = rootName(target);
    if (!name) { hit = true; return; }
    const b = lookup(M, name, n);
    if (!b) return; // a global
    const f = ownerFn(n);
    if (f === fn) { if (inside(b.idNode, fn)) hit = true; return; }
    if (inside(b.idNode, fn) && !inside(b.idNode, f)) hit = true;
  };
  walk(fn.body, (n) => {
    if (hit) return false;
    if (n.type === 'AssignmentExpression') check(n, n.left);
    else if (n.type === 'UpdateExpression') check(n, n.argument);
    else if (isCall(n)) {
      const c = unwrap(n.callee);
      if (isMember(c) && !c.computed && c.property?.type === 'Identifier') {
        if (MUTATORS.has(c.property.name)) check(n, c.object);
        if (c.object?.type === 'Identifier' && c.object.name === 'Object' && OBJECT_MUTATORS.has(c.property.name) && n.arguments[0]) check(n, n.arguments[0]);
      }
    }
    return undefined;
  });
  return hit;
}

// ---------------------------------------------------------------- imports and exports

const RESOLVE_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.astro', '/index.js', '/index.mjs', '/index.ts'];

/** Project-relative path a relative import specifier points at, or null for bare packages and URLs. */
function resolveSpecifier(project, fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  for (const e of RESOLVE_SUFFIXES) if (project.files.has(base + e)) return base + e;
  return base; // not a scanned file (a catalog .json, a module outside the scan): still comparable by path
}

function moduleExports(M) {
  if (M.exportsMemo) return M.exportsMemo;
  const out = new Map();
  const prog = M.program;
  if (prog) {
    for (const stmt of prog.body) {
      if (stmt.type === 'ExportNamedDeclaration') {
        if (stmt.declaration) {
          const d = stmt.declaration;
          if (d.type === 'VariableDeclaration') for (const dd of d.declarations) for (const id of patternIds(dd.id)) out.set(id.name, { local: id.name });
          else if (d.id) out.set(d.id.name, { local: d.id.name });
        }
        for (const s of stmt.specifiers ?? []) {
          const exported = s.exported.name ?? s.exported.value;
          if (stmt.source) out.set(exported, { reexport: { source: stmt.source.value, imported: s.local.name ?? s.local.value } });
          else out.set(exported, { local: s.local.name });
        }
      } else if (stmt.type === 'ExportDefaultDeclaration') {
        const d = stmt.declaration;
        if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) out.set('default', { local: d.id.name });
        else if (d.type === 'Identifier') out.set('default', { local: d.name });
        else out.set('default', { expr: d });
      } else if (stmt.type === 'ExportAllDeclaration') {
        out.set(`*${stmt.source.value}`, { all: stmt.source.value });
      }
    }
  }
  M.exportsMemo = out;
  return out;
}

function exportedNamesOf(M, localName) {
  const names = [];
  for (const [name, e] of moduleExports(M)) if (e.local === localName) names.push(name);
  return names;
}

/** Is this Identifier a value reference (not a declaration id, member property, object key or label)? */
function isValueRef(M, id) {
  const p = M.parents.get(id);
  if (!p) return false;
  if (isMember(p) && p.property === id && !p.computed) return false;
  if (isProp(p) && p.key === id && !p.computed && (!p.shorthand || p.value !== id)) return false;
  if (p.type === 'JSXAttribute' || p.type === 'JSXIdentifier') return false;
  if (p.type === 'ImportSpecifier' || p.type === 'ImportDefaultSpecifier' || p.type === 'ImportNamespaceSpecifier') return false;
  if (p.type === 'ExportSpecifier') return false;
  if ((p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression') && p.id === id) return false;
  if (p.type === 'VariableDeclarator' && p.id === id) return false;
  if (p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement') return false;
  return true;
}

// ---------------------------------------------------------------- constant evaluator
//
// Given an expression, returns the list of values it can take (alternatives), or an `Unknown` marker carrying
// why it cannot say. Over-approximating a key set only adds keys; under-approximating it would hide a use, so
// every doubtful branch ends in Unknown.

class Unknown {
  constructor(why) { this.why = why; }
}
const isTop = (v) => v instanceof Unknown;

class Closure {
  constructor(node, M, env) { this.node = node; this.M = M; this.env = env; }
}

const EMPTY = new Map();
const PENDING = Symbol('pending');
const MAX_ALTS = 4000;
const MAX_ENVS = 20000;
const ITER_METHODS = new Set(['map', 'forEach', 'flatMap', 'filter', 'find', 'findIndex', 'findLast', 'some', 'every']);

const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === null;
// JS turns undefined and null in a template into the text "undefined" / "null": a key that cannot exist in a
// catalog. Such an alternative is kept so the set stays exactly what the code can build.
const stringable = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === undefined || v === null;
/** Length of an Array.from source `{ length: n }`; non-numbers coerce to 0 as in JS; null when it is not such a table. */
const lengthOf = (s) => {
  if (!isPlainObj(s) || !('length' in s)) return null;
  const l = s.length;
  if (typeof l === 'number') return Number.isFinite(l) && l >= 0 && l < 5000 ? Math.floor(l) : null;
  return l === undefined || l === null ? 0 : null;
};
const single = (alts) => (alts.length === 1 ? alts[0] : new Unknown('ambiguous value'));

class Evaluator {
  constructor(project, { maxSteps = 3_000_000 } = {}) {
    this.project = project;
    this.maxSteps = maxSteps;
    this.steps = 0;
    this.inFlight = new Set();
    this.tupleMemo = new Map();
    this.tupleInFlight = new Set();
    this.stack = [];
  }

  resetBudget() { this.steps = 0; }
  top(why) { return [new Unknown(why)]; }

  /** Drop duplicate alternatives (same primitive, same object, same Unknown reason) and bound the list. */
  cap(alts) {
    if (alts.length > 1) {
      const seen = new Set();
      const out = [];
      for (const a of alts) {
        const k = a instanceof Unknown ? `?${a.why}` : a !== null && typeof a === 'object' ? a : `${typeof a}:${String(a)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(a);
      }
      alts = out;
    }
    return alts.length > MAX_ALTS ? this.top('too many alternatives') : alts;
  }

  // -------------------------------------------------------------- expressions

  ev(M, node, env, depth = 0) {
    if (++this.steps > this.maxSteps) return this.top('evaluation budget exceeded');
    if (depth > 60) return this.top('expression too deep');
    node = unwrap(node);
    if (!node) return this.top('missing expression');
    switch (node.type) {
      case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': return [node.value];
      case 'NullLiteral': return [null];
      case 'Literal':
        if (node.regex || typeof node.value === 'bigint') return this.top('regex or bigint literal');
        return [node.value];
      case 'TemplateLiteral': return this.evTemplate(M, node, env, depth);
      case 'Identifier': return this.evIdentifier(M, node, env, depth);
      case 'MemberExpression': case 'OptionalMemberExpression': return this.evMember(M, node, env, depth);
      case 'ArrayExpression': return this.evArray(M, node, env, depth);
      case 'ObjectExpression': return this.evObject(M, node, env, depth);
      case 'ConditionalExpression':
        return this.cap([...this.evNarrowed(M, node.test, node.consequent, env, depth), ...this.ev(M, node.alternate, env, depth + 1)]);
      case 'LogicalExpression':
        return this.cap([...this.ev(M, node.left, env, depth + 1), ...(node.operator === '&&' ? this.evNarrowed(M, node.left, node.right, env, depth) : this.ev(M, node.right, env, depth + 1))]);
      case 'BinaryExpression': return this.evBinary(M, node, env, depth);
      case 'UnaryExpression': return this.evUnary(M, node, env, depth);
      case 'CallExpression': case 'OptionalCallExpression': return this.evCall(M, node, env, depth);
      case 'ArrowFunctionExpression': case 'FunctionExpression': return [new Closure(node, M, env)];
      case 'SequenceExpression': return this.ev(M, node.expressions[node.expressions.length - 1], env, depth + 1);
      default: return this.top(`unsupported expression ${node.type}`);
    }
  }

  evTemplate(M, node, env, depth) {
    let acc = [''];
    for (let i = 0; i < node.quasis.length; i++) {
      acc = acc.map((s) => s + node.quasis[i].value.cooked);
      if (i < node.expressions.length) {
        const alts = this.ev(M, node.expressions[i], env, depth + 1);
        if (acc.length * alts.length > MAX_ALTS) return this.top('too many alternatives');
        const next = [];
        for (const s of acc) for (const v of alts) next.push(typeof s === 'string' && stringable(v) ? s + String(v) : new Unknown(isTop(v) ? v.why : 'non-string template part'));
        acc = next;
      }
    }
    return acc;
  }

  /**
   * Evaluate `expr` where `test` holds. When the test pins an integer to a range
   * (`Number.isInteger(n) && n >= 1 && n <= COUNT`), evaluate once per integer of the range, so a value read from
   * outside (a URL parameter) is bounded by the guard that checks it. Otherwise this is plain evaluation.
   */
  evNarrowed(M, test, expr, env, depth) {
    const ranges = this.rangeConstraints(M, test, env, depth);
    if (!ranges.length) return this.ev(M, expr, env, depth + 1);
    let envs = [env ?? EMPTY];
    for (const { idNode, lo, hi } of ranges) {
      if (hi - lo > 500) return this.ev(M, expr, env, depth + 1);
      const values = [];
      for (let v = lo; v <= hi; v++) values.push(v);
      envs = envs.flatMap((e) => values.map((v) => new Map(e).set(idNode, v)));
    }
    const out = [];
    for (const e of envs) out.push(...this.ev(M, expr, e, depth + 1));
    return this.cap(out);
  }

  rangeConstraints(M, test, env, depth) {
    const parts = [];
    const flat = (n) => {
      n = unwrap(n);
      if (n?.type === 'LogicalExpression' && n.operator === '&&') { flat(n.left); flat(n.right); } else parts.push(n);
    };
    flat(test);
    const byId = new Map();
    const slot = (idNode) => byId.get(idNode) ?? byId.set(idNode, { idNode, lo: -Infinity, hi: Infinity, int: false }).get(idNode);
    const target = (n) => {
      n = unwrap(n);
      if (n?.type !== 'Identifier') return null;
      const b = lookup(M, n.name, n);
      if (!b || (b.kind !== 'var' && b.kind !== 'param')) return null;
      if (b.kind === 'var' && b.declKind !== 'const' && isReassigned(M, b)) return null;
      return b.idNode;
    };
    for (const c of parts) {
      if (isCall(c) && isMember(unwrap(c.callee)) && unwrap(unwrap(c.callee).object)?.name === 'Number' && unwrap(c.callee).property?.name === 'isInteger' && c.arguments.length === 1) {
        const id = target(c.arguments[0]);
        if (id) slot(id).int = true;
        continue;
      }
      if (c?.type !== 'BinaryExpression' || !['>', '>=', '<', '<='].includes(c.operator)) continue;
      let idNode = target(c.left);
      let other = c.right;
      let op = c.operator;
      if (!idNode) {
        idNode = target(c.right);
        other = c.left;
        op = { '>': '<', '>=': '<=', '<': '>', '<=': '>=' }[op];
      }
      if (!idNode) continue;
      const bound = single(this.ev(M, other, env, depth + 1));
      if (typeof bound !== 'number') continue;
      const s = slot(idNode);
      if (op === '>=') s.lo = Math.max(s.lo, bound);
      else if (op === '>') s.lo = Math.max(s.lo, bound + 1);
      else if (op === '<=') s.hi = Math.min(s.hi, bound);
      else s.hi = Math.min(s.hi, bound - 1);
    }
    return [...byId.values()].filter((s) => s.int && Number.isFinite(s.lo) && Number.isFinite(s.hi) && s.lo <= s.hi);
  }

  evIdentifier(M, node, env, depth) {
    const name = node.name;
    if (name === 'undefined') return [undefined];
    if (name === 'Infinity') return [Infinity];
    if (name === 'NaN') return [NaN];
    const b = lookup(M, name, node);
    if (!b) return this.top(`global \`${name}\``);
    return this.evBinding(M, b, env, depth);
  }

  evBinding(M, b, env, depth) {
    switch (b.kind) {
      case 'param':
        if (paramReassigned(M, b)) return this.top(`parameter \`${b.idNode.name}\` is assigned again`);
        if (env?.has(b.idNode)) return [env.get(b.idNode)];
        return this.paramValues(M, b, depth);
      case 'loop':
        if (paramReassigned(M, b)) return this.top(`loop variable \`${b.idNode.name}\` is assigned again`);
        return env?.has(b.idNode) ? [env.get(b.idNode)] : this.top(`loop variable \`${b.idNode.name}\` over an unresolved collection`);
      case 'var': return this.evVar(M, b, env, depth);
      case 'function': return [new Closure(b.node, M, b.scope?.type === 'Program' ? EMPTY : env)];
      case 'fname': return [new Closure(b.node, M, env)];
      case 'import': return this.evImport(M, b, depth);
      default: return this.top(`${b.kind} \`${b.idNode.name}\``);
    }
  }

  evVar(M, b, env, depth) {
    const d = b.declarator;
    const name = b.idNode.name;
    if (env?.has(b.idNode)) return [env.get(b.idNode)]; // pinned by a guard (evNarrowed)
    if (b.declKind !== 'const' && isReassigned(M, b)) return this.reassignedValues(M, b, env, depth);
    if (!d.init) return this.top(`\`${name}\` has no initializer`);
    const moduleLevel = b.scope.type === 'Program';
    if (moduleLevel && isMutated(M, b)) return this.top(`\`${name}\` is changed in place`);
    if (moduleLevel) {
      const memo = M.constMemo.get(b.idNode);
      if (memo === PENDING) return this.top(`\`${name}\` refers to itself`);
      if (memo) return memo;
      M.constMemo.set(b.idNode, PENDING);
    }
    let alts = this.ev(M, d.init, moduleLevel ? EMPTY : env, depth + 1);
    if (d.id.type !== 'Identifier') {
      alts = alts.map((v) => {
        const tmp = new Map();
        this.bindPattern(M, d.id, v, tmp, depth + 1);
        return tmp.has(b.idNode) ? tmp.get(b.idNode) : new Unknown('destructuring');
      });
    }
    if (moduleLevel) M.constMemo.set(b.idNode, alts);
    return alts;
  }

  /**
   * A `let` that is assigned again. Two shapes are understood: a counted loop variable
   * (`for (let i = 0; i < N; i++)`, the body never assigns it) is every integer of the range; a variable whose
   * every write is a plain `x = value` holds the union of the initial value and each assigned value.
   */
  reassignedValues(M, b, env, depth) {
    const name = b.idNode.name;
    const range = this.forRange(M, b, env, depth);
    if (range) return range;
    if (b.scope.type === 'ForStatement') return this.top(`loop counter \`${name}\` is not a simple counted loop`);
    const writes = [];
    let ok = true;
    walk(b.scope, (n) => {
      if (!ok) return false;
      if (n.type === 'AssignmentExpression') {
        const l = unwrap(n.left);
        if (l?.type === 'Identifier' && l.name === name && lookup(M, name, l) === b) { if (n.operator === '=') writes.push(n.right); else ok = false; }
        else if (patternIds(n.left).some((id) => id.name === name)) ok = false;
      } else if (n.type === 'UpdateExpression' && unwrap(n.argument)?.type === 'Identifier' && unwrap(n.argument).name === name && lookup(M, name, unwrap(n.argument)) === b) ok = false;
      else if ((n.type === 'ForOfStatement' || n.type === 'ForInStatement') && n.left?.type === 'Identifier' && n.left.name === name) ok = false;
      return undefined;
    });
    if (!ok) return this.top(`\`${name}\` is changed by more than plain assignments`);
    const out = b.declarator.init ? [...this.ev(M, b.declarator.init, env, depth + 1)] : [undefined];
    for (const w of writes) out.push(...this.ev(M, w, env, depth + 1));
    return this.cap(out);
  }

  forRange(M, b, env, depth) {
    const loop = b.scope;
    if (loop.type !== 'ForStatement' || b.declKind !== 'let') return null;
    const name = b.idNode.name;
    const decls = loop.init?.declarations;
    if (!decls || decls.length !== 1 || decls[0].id !== b.idNode || !decls[0].init) return null;
    const start = single(this.ev(M, decls[0].init, env, depth + 1));
    const test = unwrap(loop.test);
    if (typeof start !== 'number' || test?.type !== 'BinaryExpression' || !['<', '<='].includes(test.operator)) return null;
    if (unwrap(test.left)?.type !== 'Identifier' || unwrap(test.left).name !== name) return null;
    const bound = single(this.ev(M, test.right, env, depth + 1));
    if (typeof bound !== 'number') return null;
    const u = unwrap(loop.update);
    const stepsByOne = (u?.type === 'UpdateExpression' && u.operator === '++' && unwrap(u.argument)?.name === name)
      || (u?.type === 'AssignmentExpression' && u.operator === '+=' && unwrap(u.left)?.name === name && isNum(unwrap(u.right)) && unwrap(u.right).value === 1);
    if (!stepsByOne) return null;
    let assigned = false;
    walk(loop.body, (n) => {
      if (n.type === 'AssignmentExpression' && patternIds(n.left).concat(n.left?.type === 'Identifier' ? [n.left] : []).some((id) => id.name === name)) assigned = true;
      if (n.type === 'UpdateExpression' && unwrap(n.argument)?.name === name) assigned = true;
      return undefined;
    });
    if (assigned) return null;
    const hi = test.operator === '<' ? bound - 1 : bound;
    if (!Number.isInteger(start) || !Number.isInteger(hi) || hi - start > 2000) return null;
    const out = [];
    for (let v = start; v <= hi; v++) out.push(v);
    return out.length ? out : null;
  }

  evImport(M, b, depth) {
    if (b.imported === '*') return this.top(`namespace import of ${b.source}`);
    const T = this.project.resolveImport(M.file, b.source);
    if (!T) return this.top(`import from ${b.source} (not a scanned module)`);
    return this.exportedValue(T, b.imported, depth + 1, new Set());
  }

  exportedValue(T, name, depth, seen) {
    const key = `${T.file}#${name}`;
    if (seen.has(key) || depth > 20) return this.top('cyclic import');
    seen.add(key);
    const e = moduleExports(T).get(name);
    if (!e) return this.top(`\`${name}\` is not exported by ${T.file}`);
    if (e.expr) return this.ev(T, e.expr, EMPTY, depth + 1);
    if (e.reexport) {
      const T2 = this.project.resolveImport(T.file, e.reexport.source);
      return T2 ? this.exportedValue(T2, e.reexport.imported, depth + 1, seen) : this.top(`re-export from ${e.reexport.source}`);
    }
    const b = T.program ? scopeTable(T, T.program).get(e.local) : null;
    if (!b) return this.top(`\`${name}\` not found in ${T.file}`);
    if (b.kind === 'import') return this.evImport(T, b, depth + 1);
    return this.evBinding(T, b, EMPTY, depth + 1);
  }

  // -------------------------------------------------------------- patterns

  bindPattern(M, pat, value, env, depth) {
    if (!pat) return;
    if (isTop(value) && pat.type !== 'Identifier' && pat.type !== 'AssignmentPattern') {
      for (const id of patternIds(pat)) env.set(id, value);
      return;
    }
    switch (pat.type) {
      case 'Identifier': env.set(pat, value); break;
      case 'AssignmentPattern': {
        const v = value === undefined ? single(this.ev(M, pat.right, env, depth + 1)) : value;
        this.bindPattern(M, pat.left, v, env, depth);
        break;
      }
      case 'ArrayPattern':
        if (!Array.isArray(value)) { for (const id of patternIds(pat)) env.set(id, new Unknown('destructured a non-array')); break; }
        pat.elements.forEach((el, i) => {
          if (!el) return;
          if (el.type === 'RestElement') this.bindPattern(M, el.argument, value.slice(i), env, depth);
          else this.bindPattern(M, el, value[i], env, depth);
        });
        break;
      case 'ObjectPattern':
        if (!isPlainObj(value)) { for (const id of patternIds(pat)) env.set(id, new Unknown('destructured a non-object')); break; }
        for (const p of pat.properties) {
          if (!isProp(p)) { for (const id of patternIds(p)) env.set(id, new Unknown('object rest')); continue; }
          const key = p.computed ? null : propKeyName(p);
          if (key === null) { for (const id of patternIds(p.value)) env.set(id, new Unknown('computed pattern key')); continue; }
          this.bindPattern(M, p.value, key in value ? value[key] : new Unknown(`missing property \`${key}\``), env, depth);
        }
        break;
      case 'RestElement': for (const id of patternIds(pat)) env.set(id, new Unknown('rest parameter')); break;
      default: for (const id of patternIds(pat)) env.set(id, new Unknown('pattern')); break;
    }
  }

  // -------------------------------------------------------------- members, arrays, objects, operators

  evMember(M, node, env, depth) {
    const objs = this.ev(M, node.object, env, depth + 1);
    const keys = node.computed ? this.ev(M, node.property, env, depth + 1) : [node.property.name ?? node.property.id?.name];
    if (objs.length * keys.length > MAX_ALTS) return this.top('too many alternatives');
    const out = [];
    for (const o of objs) for (const k of keys) out.push(...this.getMember(o, k));
    return this.cap(out);
  }

  getMember(o, k) {
    if (isTop(o)) return [o];
    if (Array.isArray(o)) {
      if (isTop(k)) return o.length ? o : [undefined];
      if (k === 'length') return [o.length];
      const idx = typeof k === 'number' ? k : typeof k === 'string' && /^\d+$/.test(k) ? Number(k) : null;
      if (idx !== null) return idx < o.length ? [o[idx]] : [undefined];
      return this.top(`array property \`${String(k)}\``);
    }
    if (typeof o === 'string') {
      if (k === 'length') return [o.length];
      return this.top(`string property \`${String(k)}\``);
    }
    if (isPlainObj(o)) {
      if (isTop(k)) {
        const vals = Object.values(o);
        return vals.length ? vals : [undefined];
      }
      // A property the table does not have reads as undefined: code that guards on it (`if (beat.choice)`) skips
      // it, code that does not would throw. Tables are built from literals, and bodies that change values in
      // place are never evaluated, so a missing property is genuinely missing.
      const key = String(k);
      return key in o ? [o[key]] : [undefined];
    }
    return this.top('member of a non-table value');
  }

  evArray(M, node, env, depth) {
    const out = [];
    for (const el of node.elements) {
      if (!el) return this.top('array with a hole');
      if (el.type === 'SpreadElement') {
        const alts = this.ev(M, el.argument, env, depth + 1);
        if (alts.length === 1 && Array.isArray(alts[0])) out.push(...alts[0]);
        else return this.top('spread of an unknown value');
      } else {
        out.push(single(this.ev(M, el, env, depth + 1)));
      }
    }
    return [out];
  }

  evObject(M, node, env, depth) {
    const obj = Object.create(null);
    for (const p of node.properties) {
      if (p.type === 'SpreadElement' || p.type === 'SpreadProperty') {
        const alts = this.ev(M, p.argument, env, depth + 1);
        if (alts.length === 1 && isPlainObj(alts[0])) Object.assign(obj, alts[0]);
        else return this.top('object spread of an unknown value');
        continue;
      }
      if (p.type === 'ObjectMethod') {
        const k = p.computed ? null : propKeyName(p);
        if (k === null) return this.top('computed method name');
        obj[k] = new Unknown('method');
        continue;
      }
      if (!isProp(p)) return this.top(`object member ${p.type}`);
      let key;
      if (p.computed) {
        const k = single(this.ev(M, p.key, env, depth + 1));
        if (isTop(k) || !stringable(k)) return this.top('computed object key');
        key = String(k);
      } else {
        key = propKeyName(p);
        if (key === null) return this.top('unsupported object key');
      }
      if (p.kind === 'get' || p.kind === 'set' || p.method) obj[key] = new Unknown('method or accessor');
      else obj[key] = single(this.ev(M, p.value, env, depth + 1));
    }
    return [obj];
  }

  evBinary(M, node, env, depth) {
    const op = node.operator;
    if (!['+', '-', '*', '/', '%', '**'].includes(op)) return this.top(`operator ${op}`);
    const L = this.ev(M, node.left, env, depth + 1);
    const R = this.ev(M, node.right, env, depth + 1);
    if (L.length * R.length > MAX_ALTS) return this.top('too many alternatives');
    const out = [];
    for (const l of L) {
      for (const r of R) {
        if (isTop(l) || isTop(r)) { out.push(isTop(l) ? l : r); continue; }
        if (op === '+') {
          if (typeof l === 'number' && typeof r === 'number') out.push(l + r);
          else if ((typeof l === 'string' || typeof r === 'string') && stringable(l) && stringable(r)) out.push(String(l) + String(r));
          else out.push(new Unknown('non-string addition'));
        } else if (typeof l === 'number' && typeof r === 'number') {
          out.push(op === '-' ? l - r : op === '*' ? l * r : op === '/' ? l / r : op === '%' ? l % r : l ** r);
        } else out.push(new Unknown('non-numeric arithmetic'));
      }
    }
    return out;
  }

  evUnary(M, node, env, depth) {
    if (node.operator === 'void') return [undefined];
    if (node.operator !== '-' && node.operator !== '+') return this.top(`operator ${node.operator}`);
    return this.ev(M, node.argument, env, depth + 1).map((v) => (typeof v === 'number' ? (node.operator === '-' ? -v : v) : isTop(v) ? v : new Unknown('non-numeric unary')));
  }

  // -------------------------------------------------------------- calls

  evCall(M, node, env, depth) {
    const callee = unwrap(node.callee);
    if (isMember(callee) && !callee.computed && callee.property?.type === 'Identifier') {
      const obj = unwrap(callee.object);
      if (obj?.type === 'Identifier' && !lookup(M, obj.name, obj)) return this.evGlobalCall(M, obj.name, callee.property.name, node, env, depth);
      return this.evMethod(M, node, callee, env, depth);
    }
    if (callee?.type === 'Identifier') {
      const b = lookup(M, callee.name, callee);
      if (!b) {
        if (callee.name === 'String') {
          if (!node.arguments.length) return [''];
          return this.ev(M, node.arguments[0], env, depth + 1).map((v) => (stringable(v) ? String(v) : isTop(v) ? v : new Unknown('String() of a non-primitive')));
        }
        return this.top(`call to global \`${callee.name}\``);
      }
      if (b.kind === 'param') return this.top(`call of parameter \`${callee.name}\``);
      return this.applyAll(this.evBinding(M, b, env, depth + 1), node.arguments, M, env, depth);
    }
    if (isFn(callee)) return this.applyAll([new Closure(callee, M, env)], node.arguments, M, env, depth);
    return this.top('unsupported call target');
  }

  argAlts(M, argNodes, env, depth) {
    const lists = [];
    for (const a of argNodes) {
      if (a.type === 'SpreadElement') return null;
      lists.push(this.ev(M, a, env, depth + 1));
    }
    return lists;
  }

  combos(lists, limit = 200) {
    let out = [[]];
    for (const alts of lists) {
      if (out.length * alts.length > limit) return null;
      out = out.flatMap((c) => alts.map((a) => [...c, a]));
    }
    return out;
  }

  applyAll(fnAlts, argNodes, M, env, depth) {
    const lists = this.argAlts(M, argNodes, env, depth);
    if (!lists) return this.top('spread argument');
    const cs = this.combos(lists);
    if (!cs) return this.top('too many argument combinations');
    const out = [];
    for (const f of fnAlts) {
      if (!(f instanceof Closure)) return this.top(isTop(f) ? f.why : 'call of a non-function');
      for (const c of cs) out.push(...this.callClosure(f, c, depth + 1));
    }
    return this.cap(out);
  }

  callClosure(f, args, depth) {
    const fn = f.node;
    if (this.stack.includes(fn) || this.stack.length > 12) return this.top('recursive call');
    this.stack.push(fn);
    try {
      const env2 = new Map(f.env);
      fn.params.forEach((p, i) => {
        if (p.type === 'RestElement') this.bindPattern(f.M, p, new Unknown('rest parameter'), env2, depth);
        else this.bindPattern(f.M, p, args[i], env2, depth);
      });
      if (fn.body.type !== 'BlockStatement') return this.ev(f.M, fn.body, env2, depth + 1);
      if (bodyMutates(f.M, fn)) return this.top('function body changes values in place');
      const rets = collectReturns(fn.body);
      if (!rets) return this.top('function body has loops or unsupported control flow');
      const out = [];
      for (const r of rets) out.push(...(r ? this.ev(f.M, r, env2, depth + 1) : [undefined]));
      return this.cap(out);
    } finally {
      this.stack.pop();
    }
  }

  evGlobalCall(M, obj, method, node, env, depth) {
    const args = node.arguments;
    if (obj === 'Math' && method === 'floor' && args.length === 1) {
      // Math.floor(Math.random() * N) is an integer of 0..N-1.
      const a = unwrap(args[0]);
      const isRandom = (n) => {
        n = unwrap(n);
        return isCall(n) && isMember(unwrap(n.callee)) && unwrap(unwrap(n.callee).object)?.name === 'Math' && unwrap(n.callee).property?.name === 'random' && !lookup(M, 'Math', n);
      };
      if (a?.type === 'BinaryExpression' && a.operator === '*' && (isRandom(a.left) || isRandom(a.right))) {
        const n = single(this.ev(M, isRandom(a.left) ? a.right : a.left, env, depth + 1));
        if (typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 2000) return Array.from({ length: n }, (_, i) => i);
      }
      return this.top('call to Math.floor');
    }
    if (obj === 'Object') {
      if (['entries', 'keys', 'values', 'fromEntries', 'freeze', 'seal'].includes(method) && args.length >= 1) {
        const srcs = this.ev(M, args[0], env, depth + 1);
        const out = [];
        for (const s of srcs) {
          if (isTop(s)) { out.push(s); continue; }
          if (method === 'freeze' || method === 'seal') { out.push(s); continue; }
          if (method === 'fromEntries') {
            if (!Array.isArray(s)) { out.push(new Unknown('fromEntries of a non-array')); continue; }
            const o = Object.create(null);
            let ok = true;
            for (const e of s) { if (Array.isArray(e) && stringable(e[0])) o[String(e[0])] = e[1]; else ok = false; }
            out.push(ok ? o : new Unknown('fromEntries with an unknown pair'));
            continue;
          }
          let pairs;
          if (Array.isArray(s)) pairs = s.map((v, i) => [String(i), v]);
          else if (isPlainObj(s)) pairs = Object.entries(s);
          else { out.push(new Unknown('Object.* of a non-table')); continue; }
          out.push(method === 'entries' ? pairs.map(([k, v]) => [k, v]) : method === 'keys' ? pairs.map(([k]) => k) : pairs.map(([, v]) => v));
        }
        return this.cap(out);
      }
      if ((method === 'defineProperty' || method === 'defineProperties') && args.length >= 2) {
        // Returns its first argument with the listed properties (re)defined: their values are unknown getters.
        const targets = this.ev(M, args[0], env, depth + 1);
        const defs = this.ev(M, args[1], env, depth + 1);
        const out = [];
        for (const tg of targets) {
          if (isTop(tg) || !isPlainObj(tg)) { out.push(isTop(tg) ? tg : new Unknown('defineProperty on a non-table')); continue; }
          for (const d of defs) {
            const o = Object.assign(Object.create(null), tg);
            if (method === 'defineProperty' && typeof d === 'string') o[d] = new Unknown('defined property');
            else if (method === 'defineProperties' && isPlainObj(d)) for (const k of Object.keys(d)) o[k] = new Unknown('defined property');
            else { out.push(new Unknown('defineProperty with unknown names')); continue; }
            out.push(o);
          }
        }
        return this.cap(out);
      }
      return this.top(`call to Object.${method}`);
    }
    if (obj === 'Array' && method === 'from' && args.length >= 1) {
      const srcs = this.ev(M, args[0], env, depth + 1);
      const cbs = args[1] ? this.ev(M, args[1], env, depth + 1) : null;
      const out = [];
      for (const s of srcs) {
        let elems;
        if (Array.isArray(s)) elems = s.map((v, i) => [v, i]);
        else if (lengthOf(s) !== null) elems = Array.from({ length: lengthOf(s) }, (_, i) => [undefined, i]);
        else { out.push(new Unknown('Array.from of an unknown source')); continue; }
        if (!cbs) { out.push(elems.map(([v]) => v)); continue; }
        for (const f of cbs) {
          if (!(f instanceof Closure)) { out.push(new Unknown('Array.from with an unknown mapper')); continue; }
          out.push(elems.map(([v, i]) => single(this.callClosure(f, [v, i], depth + 1))));
        }
      }
      return this.cap(out);
    }
    if (obj === 'Array' && method === 'of') return [args.map((a) => single(this.ev(M, a, env, depth + 1)))];
    return this.top(`call to ${obj}.${method}`);
  }

  evMethod(M, node, callee, env, depth) {
    const method = callee.property.name;
    const recvs = this.ev(M, callee.object, env, depth + 1);
    const out = [];
    for (const r of recvs) {
      if (isTop(r)) { out.push(r); continue; }
      if (Array.isArray(r)) out.push(...this.arrayMethod(M, r, method, node, env, depth));
      else if (typeof r === 'string') out.push(...this.stringMethod(M, r, method, node, env, depth));
      else if (typeof r === 'number' && method === 'toString' && !node.arguments.length) out.push(String(r));
      else out.push(new Unknown(`method .${method}() on an unknown value`));
    }
    return this.cap(out);
  }

  arrayMethod(M, arr, method, node, env, depth) {
    const args = node.arguments;
    switch (method) {
      case 'map': case 'flatMap': {
        const cbs = args[0] ? this.ev(M, args[0], env, depth + 1) : [];
        const out = [];
        for (const f of cbs) {
          if (!(f instanceof Closure)) { out.push(new Unknown('map with an unknown callback')); continue; }
          const rows = arr.map((v, i) => this.callClosure(f, [v, i, arr], depth + 1));
          if (method === 'map') out.push(rows.map((alts) => single(alts)));
          else {
            const flat = [];
            let ok = true;
            for (const alts of rows) {
              const v = single(alts);
              if (Array.isArray(v)) flat.push(...v);
              else if (isTop(v)) { ok = false; break; } else flat.push(v);
            }
            out.push(ok ? flat : new Unknown('flatMap with an unknown result'));
          }
        }
        return out.length ? out : [new Unknown('map without a callback')];
      }
      case 'filter': case 'slice': case 'reverse': case 'sort': case 'toSorted': case 'toReversed': return [arr];
      case 'concat': {
        const lists = this.argAlts(M, args, env, depth);
        if (!lists) return this.top('spread argument');
        const cs = this.combos(lists, 50);
        if (!cs) return this.top('too many argument combinations');
        return cs.map((c) => {
          if (c.some((a) => isTop(a))) return new Unknown('concat of an unknown value');
          return arr.concat(...c);
        });
      }
      case 'flat': {
        const flat = [];
        for (const e of arr) { if (Array.isArray(e)) flat.push(...e); else flat.push(e); }
        return [flat];
      }
      case 'at': case 'find': case 'findLast': return arr.length ? [...arr] : [undefined];
      case 'join': {
        const seps = args[0] ? this.ev(M, args[0], env, depth + 1) : [','];
        return seps.map((s) => (typeof s === 'string' && arr.every((e) => stringable(e)) ? arr.map(String).join(s) : new Unknown('join of unknown values')));
      }
      default: return this.top(`array method .${method}()`);
    }
  }

  stringMethod(M, s, method, node, env, depth) {
    const args = node.arguments;
    switch (method) {
      case 'toUpperCase': return [s.toUpperCase()];
      case 'toLowerCase': return [s.toLowerCase()];
      case 'trim': return [s.trim()];
      case 'toString': return [s];
      case 'padStart': case 'padEnd': {
        const lens = args[0] ? this.ev(M, args[0], env, depth + 1) : [];
        const fills = args[1] ? this.ev(M, args[1], env, depth + 1) : [' '];
        const out = [];
        for (const l of lens) for (const f of fills) out.push(typeof l === 'number' && typeof f === 'string' ? (method === 'padStart' ? s.padStart(l, f) : s.padEnd(l, f)) : new Unknown(`.${method}() with unknown arguments`));
        return out;
      }
      default: return this.top(`string method .${method}()`);
    }
  }

  // -------------------------------------------------------------- environments (callback and loop variables)

  /**
   * Every combination of enclosing callback and for-of variables for code at `node`, outermost first. A named
   * enclosing function's parameters that the code depends on are bound too, one environment per call site and
   * argument value, so parameters stay correlated with each other and with the loops around them.
   * `extra` are the expressions whose identifiers say which variables matter.
   */
  envsFor(M, node, depth = 0, extra = []) {
    const chain = [...ancestors(M, node)].reverse();
    const need = this.neededNames(M, chain, extra);
    let envs = [new Map()];
    for (let i = 0; i < chain.length; i++) {
      const anc = chain[i];
      const child = chain[i + 1] ?? node;
      if (isFn(anc) && child === anc.body) {
        const it = iterationOf(M, anc);
        if (it) envs = this.fork(M, envs, anc.params, it, depth);
        else {
          const info = functionBinding(M, anc);
          const idxs = info ? anc.params.map((p, k) => k).filter((k) => patternIds(anc.params[k]).some((id) => need.has(id.name))) : [];
          const tuples = idxs.length ? this.tuplesFor(M, anc, info, idxs, depth) : null;
          if (tuples) {
            if (envs.length * tuples.length > MAX_ENVS) return [new Map()];
            envs = envs.flatMap((env) => tuples.map((tu) => new Map([...env, ...tu])));
          }
        }
      } else if (anc.type === 'ForOfStatement' && child === anc.body && anc.left?.type === 'VariableDeclaration') {
        envs = this.fork(M, envs, [anc.left.declarations[0].id], { kind: 'forof', src: anc.right }, depth);
      } else if (anc.type === 'BlockStatement') {
        // A local constant with several possible values (`const group = age < 19 ? 'young' : 'adult'`) is bound per
        // value, so everything that reads it (and what is derived from it) stays consistent.
        const seenDecl = new Set();
        const decls = [...scopeTable(M, anc).values()]
          .filter((b) => b.kind === 'var' && b.declarator?.init && need.has(b.idNode.name) && b.declarator.end <= node.start && (b.declKind === 'const' || !isReassigned(M, b)))
          .map((b) => b.declarator)
          .filter((d) => !seenDecl.has(d) && seenDecl.add(d))
          .sort((a, b) => a.start - b.start);
        for (const d of decls) {
          const next = [];
          for (const env of envs) {
            const alts = this.ev(M, d.init, env, depth + 1);
            if (alts.length <= 1) { next.push(env); continue; }
            for (const alt of alts) {
              const e2 = new Map(env);
              this.bindPattern(M, d.id, alt, e2, depth);
              next.push(e2);
            }
          }
          envs = next;
          if (envs.length > MAX_ENVS) return [new Map()];
        }
      }
      if (envs.length > MAX_ENVS) return [new Map()];
    }
    return envs;
  }

  /** Names the code at the bottom of `chain` depends on: its own, plus those of the collections and constants they come from. */
  neededNames(M, chain, extra) {
    const need = new Set();
    const addIds = (n) => walk(n, (x) => { if (x.type === 'Identifier') need.add(x.name); });
    for (const e of extra) addIds(e);
    let size = -1;
    while (need.size !== size) {
      size = need.size;
      for (const anc of chain) {
        if (isFn(anc)) {
          const it = iterationOf(M, anc);
          if (it && anc.params.some((q) => patternIds(q).some((id) => need.has(id.name)))) addIds(it.src);
        } else if (anc.type === 'ForOfStatement' && anc.left?.type === 'VariableDeclaration' && patternIds(anc.left.declarations[0].id).some((id) => need.has(id.name))) addIds(anc.right);
        else if (anc.type === 'BlockStatement' || anc.type === 'Program') {
          for (const [name, b] of scopeTable(M, anc)) if (b.kind === 'var' && b.declarator?.init && need.has(name)) addIds(b.declarator.init);
        }
      }
    }
    return need;
  }

  /** Parameter bindings, one Map per call of `fn` (per call site and argument alternative), for parameters `idxs`. */
  tuplesFor(M, fn, info, idxs, depth) {
    const memoKey = idxs.join(',');
    const byFn = this.tupleMemo.get(fn) ?? this.tupleMemo.set(fn, new Map()).get(fn);
    if (byFn.has(memoKey)) return byFn.get(memoKey);
    if (this.tupleInFlight.has(fn)) return null;
    this.tupleInFlight.add(fn);
    let result = null;
    try {
      const { refs, escapes } = this.project.referencesTo(M, info);
      if (escapes || !refs.length) return null;
      const out = [];
      const seen = new Set();
      const ids = new Map();
      const idOf = (v) => (v !== null && typeof v === 'object' ? (ids.get(v) ?? ids.set(v, ids.size + 1).get(v)) : `${typeof v}:${String(v)}`);
      const add = (values) => {
        const k = values.map((v) => (isTop(v) ? `?${v.why}` : idOf(v))).join('|');
        if (seen.has(k)) return;
        seen.add(k);
        const tu = new Map();
        idxs.forEach((pi, j) => this.bindPattern(M, fn.params[pi], values[j], tu, depth));
        out.push(tu);
      };
      for (const ref of refs) {
        const X = ref.M;
        const p = parentOf(X, ref.node);
        if (isCall(p) && unwrap(p.callee) === ref.node) {
          if (p.arguments.some((a) => a.type === 'SpreadElement')) return null;
          const argNodes = idxs.map((k) => p.arguments[k]);
          for (const env2 of this.envsFor(X, p, depth + 1, argNodes.filter(Boolean))) {
            const lists = argNodes.map((a) => (a ? this.ev(X, a, env2, depth + 1) : [undefined]));
            const cs = this.combos(lists, 500);
            if (!cs) return null;
            for (const c of cs) add(c);
            if (out.length > 5000) return null;
          }
        } else if ((isCall(p) && p.arguments[0] === ref.node) || (isCall(p) && p.arguments[1] === ref.node)) {
          const c = unwrap(p.callee);
          const isMethod = isMember(c) && !c.computed && ITER_METHODS.has(c.property?.name) && p.arguments[0] === ref.node;
          const isFrom = isMember(c) && c.property?.name === 'from' && unwrap(c.object)?.name === 'Array' && p.arguments[1] === ref.node;
          if (!isMethod && !isFrom) return null;
          const srcNode = isMethod ? c.object : p.arguments[0];
          for (const env2 of this.envsFor(X, p, depth + 1, [srcNode])) {
            for (const s of this.ev(X, srcNode, env2, depth + 1)) {
              if (s === undefined || s === null) continue;
              let elems = null;
              if (Array.isArray(s)) elems = s.map((v, i) => [v, i]);
              else if (isFrom && lengthOf(s) !== null) elems = Array.from({ length: lengthOf(s) }, (_, i) => [undefined, i]);
              if (!elems) return null;
              for (const [v, i] of elems) add(idxs.map((k) => (k === 0 ? v : k === 1 ? i : s)));
            }
            if (out.length > 5000) return null;
          }
        } else return null;
      }
      result = out;
      return out;
    } finally {
      this.tupleInFlight.delete(fn);
      byFn.set(memoKey, result);
    }
  }

  fork(M, envs, params, it, depth) {
    const next = [];
    for (const env of envs) {
      for (const s of this.ev(M, it.src, env, depth + 1)) {
        let elems = null;
        if (s === undefined || s === null) continue; // a guarded iteration over a missing table property never runs
        if (Array.isArray(s)) elems = s.map((v, i) => [v, i]);
        else if (it.kind === 'from' && lengthOf(s) !== null) elems = Array.from({ length: lengthOf(s) }, (_, i) => [undefined, i]);
        if (!elems) { next.push(env); continue; }
        for (const [v, i] of elems) {
          const e2 = new Map(env);
          if (params[0]) this.bindPattern(M, params[0], v, e2, depth);
          if (params[1]) this.bindPattern(M, params[1], i, e2, depth);
          if (params[2]) this.bindPattern(M, params[2], s, e2, depth);
          next.push(e2);
        }
      }
    }
    return next;
  }

  /** All values `node` can take, across every enclosing-iteration combination. */
  evalAt(M, node, depth = 0) {
    const out = [];
    for (const env of this.envsFor(M, node, depth, [node])) out.push(...this.ev(M, node, env, depth + 1));
    return this.cap(out);
  }

  // -------------------------------------------------------------- parameters of named functions

  paramValues(M, b, depth) {
    const name = b.idNode.name;
    const info = functionBinding(M, b.fn);
    if (!info) return this.top(`parameter \`${name}\` of a callback over an unresolved collection`);
    if (this.inFlight.has(b.idNode)) return this.top(`parameter \`${name}\` depends on itself`);
    this.inFlight.add(b.idNode);
    try {
      const { refs, escapes } = this.project.referencesTo(M, info);
      if (escapes) return this.top(`parameter \`${name}\` of \`${info.name}\`: ${escapes}`);
      if (!refs.length) return this.top(`parameter \`${name}\` of \`${info.name}\`, which nothing calls`);
      const out = [];
      for (const ref of refs) out.push(...this.valueAtRef(M, ref, b, depth + 1));
      return this.cap(out);
    } finally {
      this.inFlight.delete(b.idNode);
    }
  }

  valueAtRef(M, ref, b, depth) {
    const X = ref.M;
    const p = parentOf(X, ref.node);
    let alts;
    if (isCall(p) && unwrap(p.callee) === ref.node) {
      if (p.arguments.some((a) => a.type === 'SpreadElement')) return this.top('call with a spread argument');
      const arg = p.arguments[b.index];
      alts = arg ? this.evalAt(X, arg, depth) : [undefined];
    } else if (isCall(p) && p.arguments.includes(ref.node)) {
      const c = unwrap(p.callee);
      const isMethod = isMember(c) && !c.computed && ITER_METHODS.has(c.property?.name) && p.arguments[0] === ref.node;
      const isFrom = isMember(c) && c.property?.name === 'from' && unwrap(c.object)?.name === 'Array' && p.arguments[1] === ref.node;
      if (!isMethod && !isFrom) return this.top(`function is passed to ${c?.property?.name ?? 'another function'}`);
      const srcNode = isMethod ? c.object : p.arguments[0];
      const out = [];
      for (const env of this.envsFor(X, p, depth)) {
        for (const s of this.ev(X, srcNode, env, depth + 1)) {
          let elems = null;
          if (s === undefined || s === null) continue;
          if (Array.isArray(s)) elems = s.map((v, i) => [v, i]);
          else if (isFrom && lengthOf(s) !== null) elems = Array.from({ length: lengthOf(s) }, (_, i) => [undefined, i]);
          if (!elems) { out.push(new Unknown('callback over an unresolved collection')); continue; }
          for (const [v, i] of elems) out.push(b.index === 0 ? v : b.index === 1 ? i : s);
        }
      }
      alts = out;
    } else {
      return this.top('function is used as a value');
    }
    if (b.pattern === b.idNode) return alts;
    return alts.map((v) => {
      const tmp = new Map();
      this.bindPattern(M, b.pattern, v, tmp, depth);
      return tmp.has(b.idNode) ? tmp.get(b.idNode) : new Unknown('destructuring');
    });
  }
}

/** If `fn` is a callback of an iteration call, what it iterates. */
function iterationOf(M, fn) {
  const p = parentOf(M, fn);
  if (!isCall(p)) return null;
  const c = unwrap(p.callee);
  if (isMember(c) && !c.computed && c.property?.type === 'Identifier') {
    if (ITER_METHODS.has(c.property.name) && p.arguments[0] === fn) return { kind: 'method', src: c.object };
    if (c.property.name === 'from' && unwrap(c.object)?.type === 'Identifier' && unwrap(c.object).name === 'Array' && p.arguments[1] === fn) return { kind: 'from', src: p.arguments[0] };
  }
  return null;
}

/** A named function: { name, binding, fn, exportedNames }, or null for an anonymous one. */
function functionBinding(M, fn) {
  const p = parentOf(M, fn);
  let name = null;
  let anchor = null;
  if (fn.type === 'FunctionDeclaration' && fn.id) { name = fn.id.name; anchor = fn; }
  else if (p?.type === 'VariableDeclarator' && p.id?.type === 'Identifier' && p.init === fn) { name = p.id.name; anchor = p; }
  if (!name) return null;
  const binding = lookup(M, name, anchor);
  if (!binding) return null;
  return { name, binding, fn, exportedNames: exportedNamesOf(M, name) };
}

/** Return-expression nodes of a function body (null element = bare `return`); null when control flow is too rich. */
function collectReturns(block) {
  const rets = [];
  let ok = true;
  const hasReturn = (n) => {
    let h = false;
    walk(n, (x) => { if (x.type === 'ReturnStatement') h = true; return !isFn(x); });
    return h;
  };
  const visit = (s) => {
    if (!ok || !s) return;
    switch (s.type) {
      case 'ReturnStatement': rets.push(s.argument ?? null); break;
      case 'BlockStatement': s.body.forEach(visit); break;
      case 'IfStatement': visit(s.consequent); visit(s.alternate); break;
      case 'VariableDeclaration': case 'ExpressionStatement': case 'FunctionDeclaration': case 'EmptyStatement': break;
      default: if (hasReturn(s)) ok = false;
    }
  };
  visit(block);
  return ok && rets.length ? rets : null;
}

// ---------------------------------------------------------------- parsers

/** Resolve `specifier` from the project, then from the packages that usually carry it. */
function resolveFromRoot(root, specifier) {
  const roots = [root, path.join(root, 'node_modules/vite'), path.join(root, 'node_modules/astro')];
  for (const dir of roots) {
    try {
      return createRequire(path.join(dir, 'package.json')).resolve(specifier);
    } catch {
      // try the next root
    }
  }
  return null;
}

/** The version of the package that `file` belongs to, found by walking up to its package.json; null if unknown. */
function packageVersion(file, name) {
  let dir = path.dirname(file);
  for (let i = 0; i < 12; i++) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === name) return typeof pkg.version === 'string' ? pkg.version : null;
    } catch {
      // no package.json at this level
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function langFor(file) {
  if (file.endsWith('.tsx')) return 'tsx';
  if (file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts')) return 'ts';
  return 'jsx'; // .js, .mjs, .cjs, .jsx: JSX is accepted leniently
}

/**
 * Finds the parsers a project already has. JS family: `rolldown/parseAst` (oxc; TS and JSX), then
 * `@babel/parser`. `.astro`: `@astrojs/compiler-rs`. `skip` names parsers to ignore ('rolldown', 'babel',
 * 'astro'), so the fallback can be forced. Resolves to `{ js, astro, report }`; a missing parser is null, and
 * `report` says which were found and their versions.
 */
export async function loadParsers(root, { skip = [] } = {}) {
  const report = { js: null, astro: null, versions: {}, tried: [] };
  let js = null;
  let astro = null;

  if (!skip.includes('rolldown')) {
    const found = resolveFromRoot(root, 'rolldown/parseAst');
    report.tried.push({ parser: 'rolldown/parseAst', found: Boolean(found) });
    if (found) {
      try {
        const { parseAst } = await import(pathToFileURL(found).href);
        js = { name: 'rolldown', parse: (src, file) => ({ tree: parseAst(src, { lang: langFor(file) }, file), flavor: 'estree' }) };
        report.versions.rolldown = packageVersion(found, 'rolldown');
      } catch {
        report.tried[report.tried.length - 1].found = false;
      }
    }
  }
  if (!js && !skip.includes('babel')) {
    const found = resolveFromRoot(root, '@babel/parser');
    report.tried.push({ parser: '@babel/parser', found: Boolean(found) });
    if (found) {
      try {
        const babel = createRequire(found)(found);
        js = {
          name: 'babel',
          parse: (src, file) => {
            const lang = langFor(file);
            const plugins = lang === 'ts' ? ['typescript'] : lang === 'tsx' ? ['typescript', 'jsx'] : ['jsx'];
            return { tree: babel.parse(src, { sourceType: 'module', plugins }).program, flavor: 'babel' };
          },
        };
        report.versions['@babel/parser'] = packageVersion(found, '@babel/parser');
      } catch {
        report.tried[report.tried.length - 1].found = false;
      }
    }
  }
  if (!skip.includes('astro')) {
    const found = resolveFromRoot(root, '@astrojs/compiler-rs');
    report.tried.push({ parser: '@astrojs/compiler-rs', found: Boolean(found) });
    if (found) {
      try {
        const compiler = await import(pathToFileURL(found).href);
        astro = {
          name: 'compiler-rs',
          parse: (src) => {
            const res = compiler.parse(src);
            const fatal = (res.diagnostics ?? []).filter((d) => d.severity === 'error' || d.severity === 'Error');
            if (fatal.length) throw new Error(`astro parse: ${JSON.stringify(fatal[0])}`);
            return { tree: res.ast, flavor: 'estree' };
          },
        };
        report.versions['@astrojs/compiler-rs'] = packageVersion(found, '@astrojs/compiler-rs');
      } catch {
        report.tried[report.tried.length - 1].found = false;
      }
    }
  }
  report.js = js?.name ?? null;
  report.astro = astro?.name ?? null;
  return { js, astro, report };
}

// ---------------------------------------------------------------- project

const SCANNABLE = /\.(astro|[cm]?[jt]sx?)$/;
const UNREADABLE = { '.vue': 'Vue', '.svelte': 'Svelte', '.mdx': 'MDX' };

/**
 * A project is the set of files one scan reads: a Map of project-relative path to source text. Cross-module
 * facts (imports, exported constants, helpers, call sites) are answered from this set only.
 */
function createProject({ files, parsers, config = {} }) {
  const names = new Set(config.names?.length ? config.names : DEFAULT_NAMES);
  const cfg = {
    modules: (config.modules ?? []).map((m) => m.replace(/^\.\//, '')),
    factoryNames: new Set(config.factories?.length ? config.factories : DEFAULT_FACTORIES),
    fallbackNames: names,
  };
  const project = { files, parsers, config: cfg, modules: new Map(), origins: new Map() };

  project.load = (file) => {
    if (project.modules.has(file)) return project.modules.get(file);
    let entry;
    const src = files.get(file);
    const isAstro = file.endsWith('.astro');
    const parser = isAstro ? parsers.astro : parsers.js;
    if (src == null) entry = { file, error: 'not in project' };
    else if (!parser) entry = { file, src, error: `no parser available for ${isAstro ? '.astro' : 'JS and TS'} files` };
    else {
      try {
        entry = buildModule(project, file, src, parser.parse(src, file), parser.name);
      } catch (e) {
        entry = { file, src, error: `could not be parsed: ${String(e?.message ?? e).split('\n')[0]}` };
      }
    }
    project.modules.set(file, entry);
    return entry;
  };
  project.module = (file) => {
    const m = project.load(file);
    return m.error ? null : m;
  };
  project.resolveImport = (from, spec) => {
    const p = resolveSpecifier(project, from, spec);
    return p && files.has(p) ? project.module(p) : null;
  };
  project.isI18nModule = (resolved) => resolved != null && cfg.modules.some((m) => resolved === m || resolved.endsWith(`/${m}`));
  project.allModules = () => [...files.keys()].filter((f) => SCANNABLE.test(f)).map((f) => project.module(f)).filter(Boolean);
  project.evaluator = new Evaluator(project);
  project.referencesTo = (M, info) => referencesTo(project, M, info);
  return project;
}

/** Every reference to a named function: in its module, and through imports in other scanned modules. */
function referencesTo(project, M, info) {
  const memo = (M.refsMemo ??= new Map());
  if (memo.has(info.binding.idNode)) return memo.get(info.binding.idNode);
  const refs = [];
  let escapes = null;
  const name = info.name;
  walk(M.tree, (n) => {
    if (n.type === 'Identifier' && n.name === name && n !== info.binding.idNode && isValueRef(M, n) && lookup(M, name, n) === info.binding) refs.push({ M, node: n });
  });
  const names = new Set([...info.exportedNames, ...(info.binding.exported ? [name] : [])]);
  if (names.size) {
    for (const X of project.allModules()) {
      if (X === M) continue;
      for (const [exportedAs, e] of moduleExports(X)) {
        if (e.reexport && project.resolveImport(X.file, e.reexport.source) === M && names.has(e.reexport.imported)) escapes = escapes ?? `re-exported by ${X.file} as ${exportedAs}`;
        if (e.all && project.resolveImport(X.file, e.all) === M) escapes = escapes ?? `re-exported by ${X.file}`;
      }
      const programs = [];
      if (X.program) programs.push(X.program);
      walk(X.tree, (n) => { if (n.type === 'Program' && n !== X.program) programs.push(n); });
      for (const prog of programs) {
        for (const stmt of prog.body) {
          if (stmt.type !== 'ImportDeclaration' || project.resolveImport(X.file, stmt.source.value) !== M) continue;
          for (const s of stmt.specifiers) {
            const bx = scopeTable(X, prog).get(s.local.name);
            if (s.type === 'ImportNamespaceSpecifier') {
              walk(X.tree, (n) => {
                if (n.type === 'Identifier' && n.name === s.local.name && isValueRef(X, n) && lookup(X, n.name, n) === bx) {
                  const p = parentOf(X, n);
                  if (isMember(p) && p.object === n && !p.computed && names.has(p.property.name)) refs.push({ M: X, node: p });
                  else if (isMember(p) && p.object === n && !p.computed) { /* another export of the module */ }
                  else escapes = escapes ?? `namespace import in ${X.file}`;
                }
              });
              continue;
            }
            const imported = s.type === 'ImportDefaultSpecifier' ? 'default' : (s.imported.name ?? s.imported.value);
            if (!names.has(imported)) continue;
            walk(X.tree, (n) => {
              if (n.type === 'Identifier' && n.name === s.local.name && n !== s.local && isValueRef(X, n) && lookup(X, n.name, n) === bx) refs.push({ M: X, node: n });
            });
          }
        }
      }
    }
  }
  const out = { refs, escapes };
  memo.set(info.binding.idNode, out);
  return out;
}

// ---------------------------------------------------------------- what a callee is

/**
 * What does calling `callee` mean?
 *   { type: 'translator', origin }   a translate function (origin: import | factory | default-param | alias | name)
 *   { type: 'factory' }              a translator factory such as getTranslator
 *   { type: 'helper', helper }       a function whose parameter flows into a translate call's key
 *   null                             anything else
 */
function classifyCallee(project, M, callee, depth = 0) {
  callee = unwrap(callee);
  if (!callee || depth > 6) return null;
  const cfg = project.config;
  if (callee.type === 'Identifier') {
    const b = lookup(M, callee.name, callee);
    if (b) {
      const r = classifyBinding(project, M, b, callee, depth);
      if (r) return r;
    }
    if (cfg.fallbackNames.has(callee.name)) return { type: 'translator', origin: 'name', name: callee.name };
    if (cfg.factoryNames.has(callee.name) && (!b || b.kind !== 'import' || !project.isI18nModule(resolveSpecifier(project, M.file, b.source)))) return { type: 'factory', origin: 'name' };
    return null;
  }
  if (isMember(callee) && !callee.computed && callee.property?.type === 'Identifier') {
    if (cfg.fallbackNames.has(callee.property.name)) return { type: 'translator', origin: 'name', name: callee.property.name, member: true };
  }
  return null;
}

/** The meaning of an import that comes from a scanned module that is not an i18n module (a helper exported there). */
function importedFromModule(project, M, b, ref, depth) {
  const T = project.resolveImport(M.file, b.source);
  if (!T) return null;
  const e = moduleExports(T).get(b.imported);
  if (!e?.local) return null;
  const tb = T.program ? scopeTable(T, T.program).get(e.local) : null;
  if (!tb) return null;
  if (tb.kind === 'function') return helperResult(project, T, tb.node);
  if (tb.kind === 'var') return classifyBinding(project, T, tb, ref, depth + 1);
  return null;
}

function classifyBinding(project, M, b, ref, depth) {
  const cfg = project.config;
  switch (b.kind) {
    case 'import': {
      if (b.imported === '*') return null;
      const resolved = resolveSpecifier(project, M.file, b.source);
      if (project.isI18nModule(resolved)) {
        // Only an i18n module's translator exports and factories are translate functions; its other exports
        // (message tables, pickers) are ordinary values.
        if (cfg.factoryNames.has(b.imported)) return { type: 'factory', origin: 'import' };
        return cfg.fallbackNames.has(b.imported) ? { type: 'translator', origin: 'import', name: b.imported } : null;
      }
      const viaModule = importedFromModule(project, M, b, ref, depth);
      if (viaModule) return viaModule;
      // With no i18n modules configured, the name a function is imported as decides: `import { t as runtimeT }`.
      if (!cfg.modules.length && cfg.fallbackNames.has(b.imported)) return { type: 'translator', origin: 'name', name: b.imported };
      return null;
    }
    case 'var': {
      const d = b.declarator;
      const init = unwrap(d.init);
      if (!init) return null;
      if (d.id.type === 'Identifier') {
        if (b.declKind !== 'const' && isReassigned(M, b)) return null;
        if (isFn(init)) return helperResult(project, M, init);
        if (init.type === 'Identifier') {
          const r = classifyCallee(project, M, init, depth + 1);
          return r?.type === 'translator' ? { ...r, origin: r.origin === 'name' ? 'name' : 'alias' } : null;
        }
        if (isCall(init)) {
          const r = classifyCallee(project, M, init.callee, depth + 1);
          if (r?.type === 'factory') return { type: 'translator', origin: 'factory', name: b.idNode.name };
        }
        return null;
      }
      if (d.id.type === 'ObjectPattern' && isCall(init)) {
        const r = classifyCallee(project, M, init.callee, depth + 1);
        if (r?.type === 'factory') {
          const prop = d.id.properties.find((p) => isProp(p) && (p.value === b.idNode || (p.value?.type === 'AssignmentPattern' && p.value.left === b.idNode)));
          if (prop && cfg.fallbackNames.has(propKeyName(prop))) return { type: 'translator', origin: 'factory', name: b.idNode.name };
        }
      }
      return null;
    }
    case 'function': return helperResult(project, M, b.node);
    case 'param': {
      const p = parentOf(M, b.idNode);
      if (p?.type === 'AssignmentPattern' && p.left === b.idNode) {
        const r = classifyCallee(project, M, p.right, depth + 1);
        if (r?.type === 'translator') return { type: 'translator', origin: 'default-param', name: b.idNode.name };
      }
      return null;
    }
    default: return null;
  }
}

function helperResult(project, M, fn) {
  const h = helpersOf(project, M).get(fn);
  return h && h.flows.length ? { type: 'helper', helper: h } : null;
}

// ---------------------------------------------------------------- key expressions: leaves and items

/** The alternatives a key argument can be: `c ? 'a' : 'b'`, `x || 'k'`, `on && 'k'`, `{a:'k1',b:'k2'}[mode]`. */
function splitLeaves(expr) {
  const leaves = [];
  const tags = new Set();
  const rec = (e) => {
    const n = unwrap(e);
    if (n?.type === 'ConditionalExpression') { rec(n.consequent); rec(n.alternate); return; }
    if (n?.type === 'LogicalExpression') {
      if (n.operator === '&&') { tags.add('and'); rec(n.right); return; }
      rec(n.left);
      rec(n.right);
      return;
    }
    if (isMember(n) && n.computed) {
      const o = unwrap(n.object);
      if (o?.type === 'ObjectExpression' && o.properties.every((p) => isProp(p) && !p.computed)) { tags.add('lookup'); for (const p of o.properties) rec(p.value); return; }
      if (o?.type === 'ArrayExpression' && o.elements.every((el) => el && el.type !== 'SpreadElement')) { tags.add('lookup'); for (const el of o.elements) rec(el); return; }
    }
    leaves.push(n);
  };
  rec(expr);
  return { leaves, tags, split: !(leaves.length === 1 && leaves[0] === unwrap(expr)) };
}

const mkLit = (text, M, node, quasi, origin = null) => ({ t: 'lit', text, pieces: [{ text, M, node, quasi, origin }] });

function mergeItems(items) {
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.t === 'lit' && it.text === '') continue;
    if (it.t === 'lit' && last?.t === 'lit') out[out.length - 1] = { t: 'lit', text: last.text + it.text, pieces: [...last.pieces, ...it.pieces] };
    else out.push(it);
  }
  return out;
}

/**
 * Flatten a key expression into items: literal text, runtime expressions, and (inside a helper) the helper's own
 * parameters. Local constants whose value is itself a string or template are followed one step at a time, so
 * `${key}.heading` becomes `lesson.beat.${beat.id}.heading`.
 */
function flattenItems(M, expr, { fn = null, rules = null, depth = 0, tag = null } = {}) {
  const node = unwrap(expr);
  const here = (items) => mergeItems(tag ? items.map((it) => (it.t === 'lit' ? { ...it, pieces: it.pieces.map((p) => ({ ...p, origin: p.origin ?? tag })) } : it)) : items);
  if (!node) return [{ t: 'expr', node: expr, M }];
  if (isStr(node)) return here([mkLit(node.value, M, node, null)]);
  if (isTpl(node)) {
    const items = [];
    node.quasis.forEach((q, i) => {
      if (q.value.cooked != null && q.value.cooked !== '') items.push(mkLit(q.value.cooked, M, node, i));
      if (i < node.expressions.length) items.push(...flattenItems(M, node.expressions[i], { fn, rules, depth: depth + 1, tag }));
    });
    return here(items);
  }
  if (node.type === 'BinaryExpression' && node.operator === '+' && isStringy(node)) {
    return mergeItems([...flattenItems(M, node.left, { fn, rules, depth: depth + 1, tag }), ...flattenItems(M, node.right, { fn, rules, depth: depth + 1, tag })]);
  }
  if (isCall(node) && node.arguments.length === 1 && unwrap(node.callee)?.type === 'Identifier' && unwrap(node.callee).name === 'String' && !lookup(M, 'String', node)) {
    return flattenItems(M, node.arguments[0], { fn, rules, depth: depth + 1, tag });
  }
  if (node.type === 'Identifier' && depth < 6) {
    const b = lookup(M, node.name, node);
    if (b?.kind === 'param' && fn && b.fn === fn && b.pattern === b.idNode) return [{ t: 'param', i: b.index }];
    if (b?.kind === 'var' && b.declarator.id.type === 'Identifier' && b.declarator.init && (b.declKind === 'const' || !isReassigned(M, b))) {
      const init = unwrap(b.declarator.init);
      if (isStr(init) || isTpl(init) || (init?.type === 'BinaryExpression' && init.operator === '+')) {
        rules?.add('local-var');
        const dtag = { kind: 'decl', id: `${M.file}@${b.declarator.start}`, M, declarator: b.declarator };
        const sub = flattenItems(M, init, { fn, rules, depth: depth + 1, tag: tag ?? dtag });
        dtag.items = sub;
        return sub;
      }
    }
  }
  return [{ t: 'expr', node, M }];
}

/** `a + b` is string concatenation (a key being built) only when a side is visibly text; `i + 1` is arithmetic. */
function isStringy(n) {
  n = unwrap(n);
  if (isStr(n) || isTpl(n)) return true;
  return n?.type === 'BinaryExpression' && n.operator === '+' && (isStringy(n.left) || isStringy(n.right));
}

function mergeParts(parts) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.lit !== undefined && last?.lit !== undefined) last.lit += p.lit;
    else if (p.wild && last?.wild) continue;
    else out.push({ ...p });
  }
  return out;
}

const partsOfItems = (items) => mergeParts(items.map((it) => (it.t === 'lit' ? { lit: it.text } : { wild: true })));
const patternString = (parts) => parts.map((p) => (p.wild ? '*' : p.lit)).join('');

function substitute(items, map, helperTag) {
  const out = [];
  for (const it of items) {
    if (it.t === 'param') {
      const rep = map.get(it.i);
      if (!rep) return null;
      out.push(...rep);
    } else if (it.t === 'lit') out.push({ ...it, pieces: it.pieces.map((p) => ({ ...p, origin: p.origin ?? helperTag })) });
    else out.push(it);
  }
  return mergeItems(out);
}

// ---------------------------------------------------------------- helpers: functions that pass a key on to `t`

const isIdentityFlow = (items) => items.length === 1 && items[0].t === 'param';

/**
 * Every key-bearing use a call produces: for a translator call, one per leaf of its first argument; for a helper
 * call, one per flow of the helper per leaf of the argument that feeds it. `paramFn` is set during helper
 * discovery so items may refer to that function's parameters.
 */
function* callUses(project, M, call, info, paramFn) {
  const args = call.arguments;
  if (info.type === 'translator') {
    if (!args.length || args[0].type === 'SpreadElement') return;
    const sp = splitLeaves(args[0]);
    for (const leaf of sp.leaves) {
      const rules = new Set(sp.tags);
      const items = flattenItems(M, leaf, { fn: paramFn, rules });
      yield { items, leaf, argIndex: 0, split: sp.split, identity: true, rules, leaves: [leaf], helper: null };
    }
    return;
  }
  if (info.type !== 'helper') return;
  const h = info.helper;
  for (const flow of h.flows) {
    const params = flow.params;
    if (params.some((i) => !args[i] || args[i].type === 'SpreadElement')) continue;
    const tag = { kind: 'helper', id: `${h.M.file}@flow:${flow.id}`, M: h.M, flow };
    if (params.length === 1) {
      const sp = splitLeaves(args[params[0]]);
      for (const leaf of sp.leaves) {
        const rules = new Set([...sp.tags, 'helper']);
        const items = substitute(flow.items, new Map([[params[0], flattenItems(M, leaf, { fn: paramFn, rules })]]), tag);
        if (!items) continue;
        yield { items, leaf, argIndex: params[0], split: sp.split, identity: flow.identity, rules, leaves: [leaf], helper: h, tag };
      }
    } else {
      const rules = new Set(['helper']);
      const map = new Map(params.map((i) => [i, flattenItems(M, args[i], { fn: paramFn, rules })]));
      const items = substitute(flow.items, map, tag);
      if (items) yield { items, leaf: unwrap(args[params[0]]), argIndex: params[0], split: false, identity: false, rules, leaves: params.map((i) => unwrap(args[i])), helper: h, tag };
    }
  }
}

function namedFunctions(M) {
  const out = [];
  walk(M.tree, (n) => {
    if (isFn(n)) {
      const fb = functionBinding(M, n);
      if (fb) out.push({ fn: n, fb });
    }
  });
  return out;
}

/** Discover, to a fixpoint, which named functions of `M` pass a parameter into a translate call's key. */
function helpersOf(project, M) {
  if (M.helpers) return M.helpers;
  M.helpers = new Map();
  M.flowLeaves = new Map(); // leaf node -> Set(helper fn): the leaf is the inside of that helper, not a use
  const cands = namedFunctions(M);
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const c of cands) {
      walk(c.fn.body, (call) => {
        if (!isCall(call)) return;
        const info = classifyCallee(project, M, call.callee);
        if (!info || (info.type !== 'translator' && info.type !== 'helper')) return;
        for (const u of callUses(project, M, call, info, c.fn)) {
          if (!u.items.some((it) => it.t === 'param')) continue;
          const params = [...new Set(u.items.filter((it) => it.t === 'param').map((it) => it.i))].sort();
          let h = M.helpers.get(c.fn);
          if (!h) {
            h = { fn: c.fn, name: c.fb.name, M, fb: c.fb, flows: [] };
            M.helpers.set(c.fn, h);
          }
          const id = `${call.start}:${u.leaf.start}`;
          if (!h.flows.some((f) => f.id === id)) {
            h.flows.push({ id, items: u.items, params, identity: isIdentityFlow(u.items), call: [call.start, call.end] });
            changed = true;
          }
          for (const lf of u.leaves) {
            const set = M.flowLeaves.get(lf) ?? new Set();
            set.add(c.fn);
            M.flowLeaves.set(lf, set);
          }
        }
      });
    }
    if (!changed) break;
  }
  return M.helpers;
}

/** A helper whose callers are not visible stays a plain use at its definition, so nothing is silently dropped. */
function helperActive(project, h) {
  const { refs, escapes } = project.referencesTo(h.M, h.fb);
  return refs.length > 0 || Boolean(escapes);
}

// ---------------------------------------------------------------- the scan of one module

const MESSAGE_FNS = new Set(['formatMessage']);
const DEFINE_FNS = new Set(['defineMessages', 'defineMessage']);
const JSX_ID_ATTRS = { FormattedMessage: 'id', Trans: 'i18nKey' };
const bytes = (s) => Buffer.byteLength(s, 'utf8');

function calleeName(callee) {
  callee = unwrap(callee);
  if (callee?.type === 'Identifier') return callee.name;
  if (isMember(callee) && !callee.computed && callee.property?.type === 'Identifier') return callee.property.name;
  return null;
}

/** The inner text span of a literal head (a string, or the first quasi of a template), or null when it is not plain. */
function headOf(M, piece) {
  const node = piece.node;
  if (!node) return null;
  if (isStr(node)) {
    const h = { start: node.start + 1, end: node.end - 1, delim: M.src[node.start], closed: true };
    return h.end > h.start ? h : null;
  }
  if (isTpl(node) && piece.quasi === 0) {
    const raw = node.quasis[0].value.raw;
    const h = { start: node.start + 1, end: node.start + 1 + raw.length, delim: '`', closed: node.expressions.length === 0 };
    if (M.src.slice(h.start, h.end) !== raw || h.end === h.start) return null;
    return h;
  }
  return null;
}

/** The record for a declaration or helper body whose literal head feeds uses elsewhere (a prefix rename edits it). */
function ensureOrigin(project, tag) {
  if (project.origins.has(tag.id)) return tag.id;
  const items = tag.kind === 'decl' ? tag.items : tag.flow.items;
  const first = items.find((it) => it.t === 'lit');
  const piece = first?.pieces[0];
  const M = piece?.M ?? tag.M;
  const head = piece ? headOf(M, piece) : null;
  const parts = partsOfItems(items.map((it) => (it.t === 'lit' ? it : { t: 'expr' })));
  const anchorStart = tag.kind === 'decl' ? tag.declarator.start : piece?.node?.start ?? 0;
  const endAbs = head ? head.end + (head.closed ? 1 : 0) : anchorStart;
  const rec = {
    file: M.file, form: tag.kind === 'decl' ? 'local-template' : 'helper-template', fn: null, kind: 'template', id: tag.id,
    pattern: patternString(parts), parts,
    start_line: M.lineOf(anchorStart), end_line: M.lineOf(endAbs), content: M.src.slice(anchorStart, endAbs),
    spans: head ? [{ start: bytes(M.src.slice(anchorStart, head.start)), end: bytes(M.src.slice(anchorStart, head.end)), delim: head.delim, lang: 'js', closed: head.closed, head: true }] : [],
    calls: [],
  };
  project.origins.set(tag.id, rec);
  return tag.id;
}

function scanModule(project, M, { keys }) {
  const src = M.src;
  const lineOf = M.lineOf;
  const ev = project.evaluator;
  const raw = [];
  const handled = new Set();
  helpersOf(project, M);
  const markNode = (n) => walk(n, (x) => { if (isStr(x) || isTpl(x)) handled.add(x); });
  const markItems = (items) => { for (const it of items) if (it.t === 'lit') for (const p of it.pieces) if (p.node) handled.add(p.node); };

  const emit = (o) => {
    ev.resetBudget();
    const leaf = unwrap(o.leaf);
    markNode(o.leaf);
    markItems(o.items);
    const base = { file: M.file, form: o.form, fn: o.fn, origin: o.origin, rules: [...o.rules].sort(), _call: [o.call.start, o.call.end] };

    // A literal key sitting at the call (or at the helper's argument): rewritable at that very literal.
    if (o.identity && (isStr(leaf) || (isTpl(leaf) && leaf.expressions.length === 0))) {
      const isTplNode = isTpl(leaf);
      const aEnd = o.staticEnd ?? leaf.end;
      raw.push({
        ...base, kind: 'static', key: isTplNode ? leaf.quasis[0].value.cooked : leaf.value,
        start_line: lineOf(o.anchorStart), end_line: lineOf(aEnd), content: src.slice(o.anchorStart, aEnd), _abs: [o.anchorStart, aEnd],
        _spans: [{ abs: { start: leaf.start + 1, end: leaf.end - 1 }, delim: src[leaf.start], lang: o.jsxAttr && !isTplNode ? 'jsx-attr' : 'js', closed: true }],
      });
      return;
    }

    const exprIdx = o.items.map((it, i) => (it.t === 'lit' ? -1 : i)).filter((i) => i >= 0);
    let envs = [new Map()];
    if (exprIdx.length) envs = ev.envsFor(M, o.useNode ?? leaf, 0, exprIdx.map((i) => o.items[i].node).filter(Boolean));
    const colVals = o.items.map(() => new Set());
    const colUnknown = o.items.map(() => false);
    const strings = new Set();
    let why = null;
    let partial = false;
    if (exprIdx.length && envs.length === 0) { partial = true; why = 'the enclosing iteration has no elements'; }
    outer:
    for (const env of envs) {
      let rows = [[]];
      for (let k = 0; k < o.items.length; k++) {
        const it = o.items[k];
        let alts;
        if (it.t === 'lit') alts = [it.text];
        else if (it.t === 'param') alts = [new Unknown('parameter of a helper nobody calls')];
        else alts = ev.ev(it.M, it.node, env).map((v) => (stringable(v) ? String(v) : isTop(v) ? v : new Unknown('a value that is not text')));
        if (rows.length * alts.length > 20000) { partial = true; why = why ?? 'too many key combinations'; break outer; }
        const next = [];
        for (const r of rows) for (const a of alts) next.push([...r, a]);
        rows = next;
        for (const a of alts) {
          if (isTop(a)) { colUnknown[k] = true; why = why ?? a.why; } else colVals[k].add(a);
        }
      }
      for (const r of rows) {
        if (r.some((a) => isTop(a))) partial = true;
        else strings.add(r.join(''));
      }
    }

    // Head literal: where a prefix rename must edit. At this site, or in the declaration or helper that supplies it.
    const first = o.items[0];
    const p0 = first?.t === 'lit' ? first.pieces[0] : null;
    let head = null;
    const via = [];
    if (p0) {
      if (p0.origin) via.push(ensureOrigin(project, p0.origin));
      else if (p0.M === M) head = headOf(M, p0);
    }

    let kind;
    const rec = { ...base };
    let parts = partsOfItems(o.items);
    if (!partial && !(exprIdx.length && envs.length === 0)) {
      kind = 'set';
      rec.keys = [...strings].sort();
      rec.rules = [...new Set([...rec.rules, ...(exprIdx.length ? ['const-eval'] : [])])].sort();
    } else {
      const narrowed = [];
      o.items.forEach((it, k) => {
        if (it.t === 'lit') narrowed.push({ lit: it.text });
        else if (!colUnknown[k] && colVals[k].size === 1) narrowed.push({ lit: [...colVals[k]][0] });
        else narrowed.push({ wild: true });
      });
      parts = mergeParts(narrowed);
      kind = parts.some((p) => p.lit) ? 'pattern' : 'opaque';
      if (why) rec.reason = why;
    }
    rec.kind = kind;
    if (kind !== 'opaque') {
      rec.parts = parts;
      rec.pattern = patternString(parts);
      if (via.length) rec.via = via;
    }

    // Anchor and head span.
    const cap = o.anchorStart + 200;
    if (head && kind !== 'opaque') {
      const headEnd = head.end + (head.closed ? 1 : 0);
      const end = Math.max(headEnd, Math.min(unwrap(o.anchorEndNode ?? o.leaf).end, cap));
      rec._abs = [o.anchorStart, end];
      rec._spans = [{ abs: { start: head.start, end: head.end }, delim: head.delim, lang: 'js', closed: head.closed, head: true }];
    } else {
      const end = Math.max(o.anchorStart + 1, Math.min(unwrap(o.anchorEndNode ?? o.leaf).end, cap));
      rec._abs = [o.anchorStart, end];
      rec._spans = [];
    }
    rec.start_line = lineOf(rec._abs[0]);
    rec.end_line = lineOf(rec._abs[1]);
    rec.content = src.slice(rec._abs[0], rec._abs[1]);
    raw.push(rec);
  };

  const handleCall = (n, info) => {
    const callee = unwrap(n.callee);
    for (const u of callUses(project, M, n, info, null)) {
      const owners = M.flowLeaves.get(u.leaf);
      if (owners && [...owners].every((fn) => helperActive(project, M.helpers.get(fn)))) {
        markNode(u.leaf); // the inside of a helper that has callers: its callers are the uses
        continue;
      }
      const rules = new Set(u.rules);
      if (u.split) rules.add('branch');
      const callerName = calleeName(n.callee);
      if (info.type === 'translator' && info.origin !== 'name' && !project.config.fallbackNames.has(callerName)) rules.add('origin');
      // Anchor at the callee when the key is the first argument and not one branch of several; otherwise at the
      // key expression alone (a helper's key is often far from its callee, after a big object argument).
      const calleeAnchored = !u.split && u.argIndex === 0 && u.leaf.start - callee.start <= 80;
      const anchorStart = calleeAnchored ? callee.start : u.leaf.start;
      const form = (info.type === 'helper' ? 'helper-call' : 'call') + (u.split ? '-branch' : '');
      emit({
        leaf: u.leaf, items: u.items, identity: u.identity, rules, form, fn: callerName, origin: info.type === 'helper' ? 'helper' : info.origin,
        anchorStart, call: n, useNode: n, anchorEndNode: u.leaf,
      });
    }
  };

  const handleIdProp = (prop, fn, form) => {
    const leaf = unwrap(prop.value);
    const items = flattenItems(M, leaf);
    emit({ leaf: prop.value, items, identity: true, rules: new Set(), form, fn, origin: 'descriptor', anchorStart: prop.start, call: prop, useNode: prop, staticEnd: leaf.end, anchorEndNode: prop });
  };

  walk(M.tree, (n) => {
    if (isCall(n)) {
      const info = classifyCallee(project, M, n.callee);
      if (info && (info.type === 'translator' || info.type === 'helper')) { handleCall(n, info); return; }
      const name = calleeName(n.callee);
      if (MESSAGE_FNS.has(name) && unwrap(n.arguments[0])?.type === 'ObjectExpression') {
        for (const p of unwrap(n.arguments[0]).properties) if (isProp(p) && propKeyName(p) === 'id') handleIdProp(p, name, 'object-id');
      } else if (DEFINE_FNS.has(name) && unwrap(n.arguments[0])?.type === 'ObjectExpression') {
        const obj = unwrap(n.arguments[0]);
        const descriptors = name === 'defineMessage' ? [obj] : obj.properties.map((p) => unwrap(p.value));
        for (const d of descriptors) {
          if (d?.type !== 'ObjectExpression') continue;
          for (const p of d.properties) if (isProp(p) && propKeyName(p) === 'id') handleIdProp(p, name, 'define-messages');
        }
      }
      return;
    }
    if (n.type === 'JSXOpeningElement') {
      const tag = n.name?.type === 'JSXIdentifier' ? n.name.name : null;
      const attrName = tag && JSX_ID_ATTRS[tag];
      if (!attrName) return;
      for (const a of n.attributes) {
        if (a.type !== 'JSXAttribute' || a.name?.name !== attrName || !a.value) continue;
        const inContainer = a.value.type === 'JSXExpressionContainer';
        const v = inContainer ? a.value.expression : a.value;
        const leaf = unwrap(v);
        emit({
          leaf: v, items: flattenItems(M, leaf), identity: true, rules: new Set(), form: 'jsx-attr', fn: tag, origin: 'descriptor',
          anchorStart: a.start, call: a, useNode: a, jsxAttr: !inContainer, staticEnd: a.end, anchorEndNode: a,
        });
      }
    }
  });

  // Safety sweep, with the catalog keys: a string that is not a recognised key position but equals a key, or
  // starts with a key prefix ending in '.', becomes a `literal` record. This is how a key prefix in a prop
  // (`clientMessages={['map.']}`) or an unknown helper's key surfaces.
  const sweep = [];
  if (keys) {
    const keyList = [...keys];
    const firstSegs = new Set(keyList.map((k) => k.split('.')[0]));
    const sweepCheck = (value, start, n, literalRecord) => {
      if (!value || value.length >= 160) return;
      let level = null;
      if (keys.has(value)) level = 'key';
      else if (value.includes('.') && keyList.some((k) => k.startsWith(value) && k !== value)) level = 'prefix';
      else if (/^[\w-]+\.[\w.-]*$/.test(value) && firstSegs.has(value.split('.')[0])) level = 'loose';
      if (level) sweep.push({ file: M.file, line: lineOf(start), value, level, listed: literalRecord, text: src.slice(n.start, Math.min(n.end, n.start + 60)) });
    };
    walk(M.tree, (n, parent) => {
      if ((isStr(n) || isTpl(n)) && !handled.has(n)) {
        const isTemplateWithExpr = isTpl(n) && n.expressions.length > 0;
        const value = isStr(n) ? n.value : n.quasis[0].value.cooked;
        if (typeof value !== 'string' || value.length === 0 || value.length >= 160) return;
        const sub = !isTemplateWithExpr && keys.has(value) ? 'key' : !isTemplateWithExpr && value.endsWith('.') && keyList.some((k) => k.startsWith(value)) ? 'prefix' : null;
        sweepCheck(value, n.start, n, Boolean(sub));
        if (!sub) return;
        raw.push({
          file: M.file, form: 'literal', fn: null, origin: null, rules: [], kind: 'literal', sub, key: value,
          start_line: lineOf(n.start), end_line: lineOf(n.end), content: src.slice(n.start, n.end), _abs: [n.start, n.end], _call: [n.start, n.end],
          _spans: [{ abs: { start: n.start + 1, end: n.end - 1 }, delim: src[n.start], lang: parent?.type === 'JSXAttribute' ? 'jsx-attr' : 'js', closed: true }],
        });
      }
    });
  }

  return { usages: finish(raw, src, lineOf), sweep };
}

/** Turn absolute spans into byte spans within `content`; merge identical same-line anchors. */
function finish(raw, src, lineOf) {
  raw.sort((a, b) => a._abs[0] - b._abs[0] || a._abs[1] - b._abs[1]);
  // Records that are truly identical (same lines, same snippet, same key, key set or pattern) travel as ONE snippet
  // with several spans: the repo-side action cannot tell two identical anchors on one line apart. Records that
  // differ in what they read (two templates on one line) are never merged, since their snippets differ.
  const groups = new Map();
  for (const r of raw) {
    const sig = r.kind === 'static' || r.kind === 'literal' ? r.key : r.kind === 'set' ? r.keys.join('|') : r.kind === 'pattern' ? r.pattern : '';
    const k = r.kind === 'opaque' ? `o${r._abs[0]}` : `${r.kind}|${r.start_line}|${r.end_line}|${r.content}|${sig}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const members of groups.values()) {
    const first = members[0];
    let [a, b] = first._abs;
    for (const m of members) { a = Math.min(a, m._abs[0]); b = Math.max(b, m._abs[1]); }
    const rec = { ...first };
    const merged = members.length > 1;
    if (merged) {
      rec.content = src.slice(a, b);
      rec.start_line = lineOf(a);
      rec.end_line = lineOf(b);
      rec.occurrences = members.length;
    }
    rec.calls = members.map((m) => m._call);
    rec.spans = (merged ? members.flatMap((m) => m._spans ?? []) : first._spans ?? []).map((s) => ({
      start: bytes(src.slice(a, s.abs.start)),
      end: bytes(src.slice(a, s.abs.end)),
      delim: s.delim, lang: s.lang, closed: s.closed, ...(s.head ? { head: true } : {}),
    }));
    for (const k of Object.keys(rec)) if (k.startsWith('_')) delete rec[k];
    out.push(rec);
  }
  out.sort((x, y) => x.start_line - y.start_line);
  return out;
}

// ---------------------------------------------------------------- listing files

const BUILD_DIRS = new Set(['dist', 'build', '.astro', '.output', '.vercel', '.netlify', '.next', 'coverage']);

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Does `file` match an exclude glob, or sit inside a directory that does? */
function excludeMatcher(globs) {
  const regs = (globs ?? []).map((g) => String(g).trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean).map(globToRegExp);
  return (file) => {
    if (!regs.length) return false;
    const segs = file.split('/');
    for (let i = 1; i <= segs.length; i++) {
      const prefix = segs.slice(0, i).join('/');
      if (regs.some((re) => re.test(prefix))) return true;
    }
    return false;
  };
}

function walkFiles(root, rel = '') {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(root, p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Tracked files under `root` (git ls-files, no shell); a plain directory walk when `root` is not a git checkout. */
function listProjectFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch {
    return walkFiles(root);
  }
}

const isBuildOrDependency = (file) => {
  const segs = file.split('/');
  return segs.includes('node_modules') || BUILD_DIRS.has(segs[0]);
};

/**
 * Is this tracked path one the scan reads, or reports as unscanned (a Vue, Svelte or MDX file)? The add-on uses it to
 * read only those blobs when it scans a committed tree instead of the working directory.
 */
export const isProjectSourcePath = (file) => !isBuildOrDependency(file) && (SCANNABLE.test(file) || Object.hasOwn(UNREADABLE, path.posix.extname(file)));

// ---------------------------------------------------------------- scanProject

/**
 * Scans a project's code for key uses.
 *   root        project directory (default: the working directory)
 *   files       project-relative paths to scan, or a Map of path to source text; omitted: `git ls-files`
 *   catalogKeys the catalog's keys; with them, strings equal to a key or a key prefix become `literal` records
 *   config      { modules, factories, names, exclude }: see the add-on's README
 *   parsers     the result of loadParsers (without one nothing can be read and every source file is unscanned)
 *   only        paths whose records to return; the whole project is still read for cross-file facts
 * Resolves to { usages, unscanned, sweep, parsers, stats }. Never throws: a file that cannot be read or parsed is
 * listed in `unscanned` with the reason.
 */
export function scanProject({ root = process.cwd(), files = null, catalogKeys = null, config = {}, parsers = null, only = null } = {}) {
  const cfg = config ?? {};
  const keys = catalogKeys ? new Set(catalogKeys) : null;
  const isExcluded = excludeMatcher(cfg.exclude);
  const unscanned = [];
  const sources = new Map();

  const inMemory = files instanceof Map;
  const listed = inMemory ? [...files.keys()] : files ?? listProjectFiles(root);
  for (const raw of [...new Set(listed.map((f) => String(f).split(path.sep).join('/')))].sort()) {
    const file = raw.replace(/^\.\//, '');
    if (isExcluded(file) || (!files && isBuildOrDependency(file))) continue;
    const ext = path.posix.extname(file);
    if (UNREADABLE[ext]) {
      unscanned.push({ file, reason: `${UNREADABLE[ext]} files are not read by the scanner` });
      continue;
    }
    if (!SCANNABLE.test(file)) continue;
    if (inMemory) {
      sources.set(file, String(files.get(raw)));
      continue;
    }
    try {
      sources.set(file, readFileSync(path.join(root, file), 'utf8'));
    } catch (e) {
      if (e?.code !== 'ENOENT') unscanned.push({ file, reason: `could not be read: ${e?.message ?? e}` });
    }
  }

  const noParsers = { js: null, astro: null, report: { js: null, astro: null, versions: {}, tried: [] } };
  const parserSet = parsers ?? noParsers;
  const project = createProject({ files: sources, parsers: parserSet, config: cfg });
  const usages = [];
  const sweep = [];
  const sweepSeen = new Set();
  const perFile = new Map();
  let scanned = 0;

  for (const file of sources.keys()) {
    if (only && !only.has(file)) continue;
    const M = project.load(file);
    if (M.error) {
      unscanned.push({ file, reason: M.error });
      continue;
    }
    try {
      const r = scanModule(project, M, { keys });
      perFile.set(file, r.usages);
      scanned++;
      for (const s of r.sweep) {
        const id = `${s.file}:${s.line}:${s.value}`;
        if (sweepSeen.has(id)) continue;
        sweepSeen.add(id);
        sweep.push(s);
      }
    } catch (e) {
      unscanned.push({ file, reason: `scan failed: ${String(e?.message ?? e).split('\n')[0]}` });
    }
  }
  for (const rec of project.origins.values()) {
    if (only && !only.has(rec.file)) continue;
    if (!perFile.has(rec.file)) perFile.set(rec.file, []);
    perFile.get(rec.file).push(rec);
    perFile.get(rec.file).sort((x, y) => x.start_line - y.start_line);
  }
  for (const file of [...perFile.keys()].sort()) usages.push(...perFile.get(file));
  unscanned.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));

  return {
    usages, unscanned, sweep, parsers: parserSet.report,
    stats: { files: sources.size, scanned, unscanned: unscanned.length, records: usages.length },
  };
}

// ---------------------------------------------------------------- classification

/** A regular expression for a pattern's parts: wildcards match any (possibly empty) text. */
function patternRegExp(parts) {
  return new RegExp(`^${parts.map((p) => (p.wild ? '[\\s\\S]*' : p.lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
}

/** Could `pattern` (parts with wildcards) produce `key`? */
export function patternMatches(parts, key) {
  return patternRegExp(parts).test(key);
}

/** Total uses by kind, counting merged same-line duplicates (`occurrences`) as separate uses. */
export function countUses(usages) {
  const out = { static: 0, set: 0, pattern: 0, opaque: 0 };
  for (const u of usages) if (u.kind in out) out[u.kind] += u.occurrences ?? 1;
  return out;
}

/**
 * Classifies every catalog key from the usages, as a pure function:
 *   alone      every use reaching it is a static literal
 *   family     some use is a set (a shared template): it is renamed only as part of a group whose `prefix` covers
 *              that template's fixed start (the longest dotted prefix shared by every template reaching the key)
 *   locked     an unresolved pattern could reach it, a file was left unscanned, or a shared template reaching it has
 *              no fixed dotted start (no group rename can rewrite it); `reasons` lists them
 *   unreached  no use reaches it
 * Unscanned files lock every key: nothing proves they do not use it. Resolves to an object keyed by key.
 */
export function classifyKeys(usages, catalogKeys, { unscanned = [] } = {}) {
  const origins = new Map();
  const staticKeys = new Set();
  const setBy = new Map();
  const patterns = [];
  for (const u of usages) {
    if (u.kind === 'template') origins.set(u.id, u);
    else if (u.kind === 'static') staticKeys.add(u.key);
    else if (u.kind === 'set') for (const k of u.keys) (setBy.get(k) ?? setBy.set(k, []).get(k)).push(u);
    else if (u.kind === 'pattern') patterns.push({ use: u, re: patternRegExp(u.parts ?? []) });
  }
  const startOf = (u) => (u.via?.length ? origins.get(u.via[0])?.parts?.[0]?.lit ?? null : u.parts?.[0]?.lit ?? null);
  const sharedPrefix = (starts) => {
    let p = starts[0] ?? '';
    for (const s of starts) {
      let i = 0;
      while (i < p.length && i < s.length && p[i] === s[i]) i++;
      p = p.slice(0, i);
    }
    const cut = p.lastIndexOf('.');
    return cut >= 0 ? p.slice(0, cut + 1) : '';
  };
  const fileLock = unscanned.map((f) => ({ type: 'unscanned', file: f.file, reason: f.reason }));

  const out = Object.create(null);
  for (const key of catalogKeys) {
    const reasons = [...fileLock];
    for (const { use, re } of patterns) {
      if (!re.test(key)) continue;
      reasons.push({ type: 'pattern', pattern: use.pattern, file: use.file, line: use.start_line, ...(use.reason ? { reason: use.reason } : {}) });
    }
    if (reasons.length) out[key] = { class: 'locked', reasons };
    else if (setBy.has(key)) {
      const sets = setBy.get(key);
      const starts = sets.map(startOf);
      const prefix = starts.some((s) => s == null) ? '' : sharedPrefix(starts);
      // A template with no fixed dotted start can't be rewritten by any group rename, so nothing renames the key.
      out[key] = prefix
        ? { class: 'family', prefix }
        : { class: 'locked', reasons: sets.map((u) => ({ type: 'shared_template', pattern: u.pattern, file: u.file, line: u.start_line })) };
    } else if (staticKeys.has(key)) out[key] = { class: 'alone' };
    else out[key] = { class: 'unreached' };
  }
  return out;
}

// ---------------------------------------------------------------- check

/** Is this a test file (its uses probe missing keys on purpose)? */
export function isTestFile(file) {
  return /\.(test|spec)\.[^/]*$/.test(file) || /(^|\/)(tests?|__tests__)\//.test(file);
}

/**
 * Compares the code's uses with the catalog keys. A problem is a use that reads a key which is not there:
 *   missing_key       a static use whose key is missing
 *   missing_keys      a set whose keys are ALL missing (a set over-approximates, so one missing member is normal)
 *   no_matching_keys  an unresolved pattern whose fixed start matches no catalog key
 * The same findings in test files are warnings. Each entry is { type, file, line, key | keys | pattern, message }.
 */
export function checkUsages(usages, catalogKeys) {
  const keys = new Set(catalogKeys);
  const keyList = [...keys];
  const problems = [];
  const warnings = [];
  const report = (u, entry) => {
    const where = `${u.file}:${u.start_line}`;
    (isTestFile(u.file) ? warnings : problems).push({ ...entry, file: u.file, line: u.start_line, message: `${where} ${entry.message}` });
  };
  for (const u of usages) {
    if (u.kind === 'static') {
      if (!keys.has(u.key)) report(u, { type: 'missing_key', key: u.key, message: `reads "${u.key}", which is not in the catalog` });
    } else if (u.kind === 'set') {
      if (u.keys.length && u.keys.every((k) => !keys.has(k))) {
        report(u, { type: 'missing_keys', keys: u.keys, message: `reads ${u.pattern ? `"${u.pattern}"` : 'a key set'} but none of its ${u.keys.length} keys is in the catalog` });
      }
    } else if (u.kind === 'pattern') {
      const start = u.parts?.[0]?.lit;
      if (start && !keyList.some((k) => k.startsWith(start))) {
        report(u, { type: 'no_matching_keys', pattern: u.pattern, message: `builds "${u.pattern}", which matches no key in the catalog` });
      }
    }
  }
  return { problems, warnings };
}
