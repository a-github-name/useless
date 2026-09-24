import { fileURLToPath } from 'node:url';
import Parser from 'web-tree-sitter';

/**
 * Tree-sitter facts about a JS/TS test file. The parse replaces the regexes
 * whose false positives come from strings that merely contain the pattern:
 * test blocks, `expect(...)` assertions, file reads, and mock calls are
 * taken from real call expressions. Everything else stays regex-based.
 */

export type Unit = {
  /** The `it`/`test` title, as written. */
  name: string;
  /** Enclosing `describe` titles joined with the title by single spaces, as test runners report it. */
  fullName: string;
  startLine: number;
  endLine: number;
  startIndex: number;
  endIndex: number;
  /** `skip`, `only`, `todo`, `each`, ... */
  modifiers: string[];
  /** Cases registered by literal tables and loops; null when registration depends on runtime data. */
  staticCases: number | null;
};

export type LiteralKind = 'string' | 'regex' | 'number' | 'array' | 'object' | 'bool' | 'null';

export type Assertion = {
  line: number;
  startIndex: number;
  /** Matcher chain after `expect(...)`, e.g. `toContain`, `not.toHaveBeenCalled`, `resolves.toEqual`. */
  matcher: string;
  /** Source text of the `expect` argument. */
  subject: string;
  /** Identifiers referenced in the subject (not property names). */
  subjectIds: string[];
  /** The first matcher argument when it is a literal. */
  literal: string | null;
  literalKind: LiteralKind | null;
};

export type ReadCall = {
  line: number;
  /** Source text of the arguments, plus the initialiser of any bare identifier argument. */
  pathText: string;
  /** Variable the result was bound to, if any. */
  boundTo: string | null;
};

export type Call = {
  line: number;
  startIndex: number;
  /** Identifier-rooted callee chain, e.g. `describe.skipIf`, `execFileSync`. */
  chain: string;
  /** First argument when it is a string literal. */
  firstLiteral: string | null;
  argsText: string;
};

export type Facts = {
  language: 'typescript' | 'tsx';
  units: Unit[];
  assertions: Assertion[];
  reads: ReadCall[];
  /** Local functions that read files; a call to one is a read at the call site. */
  readerFns: Set<string>;
  /** Variable -> identifiers referenced in its initialiser. */
  deps: Map<string, string[]>;
  /** `vi.*` / `jest.*` calls by member name. */
  mockCalls: { name: string; startIndex: number }[];
  /** Every other identifier-rooted call with a chain of at most three names. */
  calls: Call[];
};

/**
 * Variables that carry the result of any of `reads`, transitively through
 * initialisers. A call to a reader function is itself one of `reads`, so
 * the function name is not a seed: that keeps a fixture loaded through the
 * helper apart from source loaded through it.
 */
export function derivedFrom(facts: Facts, reads: ReadCall[]): Set<string> {
  const derived = new Set<string>();
  for (const read of reads) if (read.boundTo) derived.add(read.boundTo);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, ids] of facts.deps) {
      if (derived.has(name)) continue;
      if (ids.some((id) => derived.has(id))) {
        derived.add(name);
        grew = true;
      }
    }
  }
  return derived;
}

type Node = Parser.SyntaxNode;

let parser: Parser | null = null;
const languages = new Map<string, Parser.Language>();

const GRAMMAR_DIR = new URL('../grammars/', import.meta.url);

/** Load the parser runtime and grammars once. Safe to call repeatedly. */
export async function initAst(): Promise<void> {
  if (parser) return;
  await Parser.init();
  parser = new Parser();
  for (const name of ['typescript', 'tsx'] as const) {
    const path = fileURLToPath(new URL(`tree-sitter-${name}.wasm`, GRAMMAR_DIR));
    languages.set(name, await Parser.Language.load(path));
  }
}

export function astReady(): boolean {
  return parser !== null;
}

function languageFor(file: string): 'typescript' | 'tsx' | null {
  if (/\.(ts|mts|cts)$/.test(file)) return 'typescript';
  if (/\.(tsx|jsx|js|mjs|cjs)$/.test(file)) return 'tsx';
  return null;
}

const TEST_FNS = new Set(['it', 'test', 'specify']);
const SUITE_FNS = new Set(['describe', 'suite', 'context']);
const READ_FNS = /^(readFileSync|readFile|readdirSync|readdir|readTextFile|readTextFileSync)$/;
/** Roots that make a `.readFile` chain the real filesystem rather than a fake. */
const FS_ROOTS = new Set(['fs', 'fsp', 'fsPromises', 'promises', 'Deno', 'node']);

/** `a.b.c` -> ['a','b','c'] for identifier-rooted member chains; null otherwise. */
function memberChain(node: Node): string[] | null {
  if (node.type === 'identifier') return [node.text];
  if (node.type === 'member_expression') {
    const object = node.childForFieldName('object');
    const property = node.childForFieldName('property');
    if (!object || !property) return null;
    const head = memberChain(object);
    return head ? [...head, property.text] : null;
  }
  return null;
}

function stringValue(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === 'string') {
    return node.namedChildren
      .filter((c) => c.type === 'string_fragment' || c.type === 'escape_sequence')
      .map((c) => c.text)
      .join('');
  }
  if (node.type === 'template_string') return node.text.slice(1, -1);
  return null;
}

function literalKind(node: Node): LiteralKind | null {
  switch (node.type) {
    case 'string':
    case 'template_string':
      return 'string';
    case 'regex':
      return 'regex';
    case 'number':
      return 'number';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    case 'true':
    case 'false':
      return 'bool';
    case 'null':
    case 'undefined':
      return 'null';
    case 'unary_expression':
      return node.namedChildren[0]?.type === 'number' ? 'number' : null;
    default:
      return null;
  }
}

function identifiersIn(node: Node): string[] {
  return node.descendantsOfType('identifier').map((n) => n.text);
}

/**
 * Split a call whose callee chain starts at `expect` into the matcher chain.
 * Handles `expect(x).not.toBe(y)`, `expect.soft(x).toBe(y)`, and
 * `await expect(p).resolves.toEqual(y)`.
 */
function expectAssertion(call: Node): Assertion | null {
  const callee = call.childForFieldName('function');
  if (!callee || callee.type !== 'member_expression') return null;
  const chain: string[] = [];
  let cursor: Node | null = callee;
  let expectCall: Node | null = null;
  while (cursor) {
    if (cursor.type === 'member_expression') {
      chain.unshift(cursor.childForFieldName('property')?.text ?? '');
      cursor = cursor.childForFieldName('object');
    } else if (cursor.type === 'call_expression') {
      const fn: Node | null = cursor.childForFieldName('function');
      const fnChain = fn ? memberChain(fn) : null;
      if (fnChain && fnChain[0] === 'expect' && fnChain.length <= 2) {
        expectCall = cursor;
        break;
      }
      // A matcher call in the middle of the chain (rare): stop.
      return null;
    } else if (cursor.type === 'await_expression' || cursor.type === 'parenthesized_expression') {
      cursor = cursor.namedChildren[0] ?? null;
    } else {
      return null;
    }
  }
  if (!expectCall) return null;
  const subjectNode = expectCall.childForFieldName('arguments')?.namedChildren[0] ?? null;
  const firstArg = call.childForFieldName('arguments')?.namedChildren[0] ?? null;
  const kind = firstArg ? literalKind(firstArg) : null;
  return {
    line: call.startPosition.row + 1,
    startIndex: call.startIndex,
    matcher: chain.join('.'),
    subject: subjectNode?.text ?? '',
    subjectIds: subjectNode ? identifiersIn(subjectNode) : [],
    literal: firstArg && kind ? firstArg.text : null,
    literalKind: kind,
  };
}

function enclosingDeclarator(node: Node): string | null {
  let cursor: Node | null = node.parent;
  while (cursor) {
    if (cursor.type === 'variable_declarator')
      return cursor.childForFieldName('name')?.text ?? null;
    if (
      cursor.type === 'statement_block' ||
      cursor.type === 'program' ||
      cursor.type === 'arrow_function' ||
      cursor.type === 'function_declaration' ||
      cursor.type === 'function_expression' ||
      cursor.type === 'method_definition'
    )
      return null;
    cursor = cursor.parent;
  }
  return null;
}

/** Name of the function a node sits in when that function is nameable. */
function enclosingFunctionName(node: Node): string | null {
  let cursor: Node | null = node.parent;
  while (cursor) {
    if (cursor.type === 'function_declaration')
      return cursor.childForFieldName('name')?.text ?? null;
    if (cursor.type === 'arrow_function' || cursor.type === 'function_expression') {
      const parent = cursor.parent;
      if (parent?.type === 'variable_declarator')
        return parent.childForFieldName('name')?.text ?? null;
      return null;
    }
    if (cursor.type === 'method_definition') return cursor.childForFieldName('name')?.text ?? null;
    cursor = cursor.parent;
  }
  return null;
}

function unitTitle(call: Node): { title: string; modifiers: string[] } | null {
  let fn = call.childForFieldName('function');
  const modifiers: string[] = [];
  // `it.each(table)('title', fn)`: the callee is itself a call.
  if (fn?.type === 'call_expression') {
    const inner = fn.childForFieldName('function');
    const chain = inner ? memberChain(inner) : null;
    if (!chain || !TEST_FNS.has(chain[0] ?? '')) return null;
    modifiers.push(...chain.slice(1));
    fn = inner;
  } else {
    const chain = fn ? memberChain(fn) : null;
    if (!chain) return null;
    if (chain[0] === 'Deno' && chain[1] === 'test') modifiers.push('deno');
    else if (TEST_FNS.has(chain[0] ?? '')) modifiers.push(...chain.slice(1));
    else return null;
  }
  const first = call.childForFieldName('arguments')?.namedChildren[0] ?? null;
  const title = stringValue(first);
  if (title === null) {
    // `test(function named() {})` or `Deno.test({ name, fn })`: take what we can.
    if (first?.type === 'object') {
      const name = first.namedChildren
        .find((p) => p.type === 'pair' && p.childForFieldName('key')?.text === 'name')
        ?.childForFieldName('value');
      const v = stringValue(name ?? null);
      return v === null ? null : { title: v, modifiers };
    }
    if (first?.type === 'function_expression' || first?.type === 'arrow_function')
      return { title: first.childForFieldName('name')?.text ?? '', modifiers };
    return null;
  }
  return { title, modifiers };
}

function suiteTitles(node: Node): string[] {
  const titles: string[] = [];
  let cursor: Node | null = node.parent;
  while (cursor) {
    if (cursor.type === 'call_expression') {
      const fn = cursor.childForFieldName('function');
      const chain = fn ? memberChain(fn) : null;
      if (chain && SUITE_FNS.has(chain[0] ?? '')) {
        const title = stringValue(cursor.childForFieldName('arguments')?.namedChildren[0] ?? null);
        if (title !== null) titles.unshift(title);
      }
    }
    cursor = cursor.parent;
  }
  return titles;
}

/** Count only literal array entries. Evaluating an identifier or a spread would execute user code. */
function literalArrayLength(node: Node | null): number | null {
  let value = node;
  while (
    value &&
    (value.type === 'as_expression' ||
      value.type === 'satisfies_expression' ||
      value.type === 'parenthesized_expression' ||
      value.type === 'non_null_expression')
  )
    value = value.namedChildren[0] ?? null;
  if (value?.type !== 'array') return null;
  if (value.namedChildren.some((entry) => entry.type === 'spread_element')) return null;
  return value.namedChildren.length;
}

/** Static registration count for a call site, without evaluating test modules. */
function staticCases(call: Node): number | null {
  let cases = 1;
  const fn = call.childForFieldName('function');
  if (fn?.type === 'call_expression') {
    const inner = fn.childForFieldName('function');
    const chain = inner ? memberChain(inner) : null;
    if (chain?.includes('each')) {
      const length = literalArrayLength(
        fn.childForFieldName('arguments')?.namedChildren[0] ?? null,
      );
      if (length === null) return null;
      cases *= length;
    }
  }
  let parent = call.parent;
  while (parent) {
    if (parent.type === 'for_in_statement' || parent.type === 'for_statement') {
      if (parent.type !== 'for_in_statement' || !parent.children.some((c) => c.type === 'of'))
        return null;
      const length = literalArrayLength(parent.childForFieldName('right'));
      if (length === null) return null;
      cases *= length;
    }
    // A registration inside a conditional cannot be counted from syntax alone.
    if (parent.type === 'if_statement' || parent.type === 'switch_statement') return null;
    parent = parent.parent;
  }
  return cases;
}

/**
 * Parse one file and extract the facts the analyser consumes. Returns null
 * for languages without a grammar, or before `initAst()` has run.
 */
export function extractFacts(file: string, text: string): Facts | null {
  const language = languageFor(file);
  if (!parser || !language) return null;
  const grammar = languages.get(language);
  if (!grammar) return null;
  parser.setLanguage(grammar);
  const tree = parser.parse(text);
  try {
    const root = tree.rootNode;
    const units: Unit[] = [];
    const assertions: Assertion[] = [];
    const reads: ReadCall[] = [];
    const mockCalls: { name: string; startIndex: number }[] = [];
    const calls: Call[] = [];
    const readerFns = new Set<string>();
    const deps = new Map<string, string[]>();
    const initialisers = new Map<string, string>();

    for (const decl of root.descendantsOfType('variable_declarator')) {
      const name = decl.childForFieldName('name');
      const value = decl.childForFieldName('value');
      if (!name || !value) continue;
      for (const id of name.type === 'identifier' ? [name.text] : identifiersIn(name)) {
        deps.set(id, identifiersIn(value));
        initialisers.set(id, value.text);
      }
    }

    const readCalls: Node[] = [];
    for (const call of root.descendantsOfType('call_expression')) {
      const fn = call.childForFieldName('function');
      if (!fn) continue;
      const chain = memberChain(fn);
      const last = chain?.[chain.length - 1] ?? '';

      const title = unitTitle(call);
      if (title) {
        // Nested `it` inside another `it` is not a separate unit for our purposes.
        units.push({
          name: title.title,
          fullName: [...suiteTitles(call), title.title].join(' '),
          startLine: call.startPosition.row + 1,
          endLine: call.endPosition.row + 1,
          startIndex: call.startIndex,
          endIndex: call.endIndex,
          modifiers: title.modifiers,
          staticCases: staticCases(call),
        });
        continue;
      }
      const assertion = expectAssertion(call);
      if (assertion) {
        assertions.push(assertion);
        continue;
      }
      if (chain && (chain[0] === 'vi' || chain[0] === 'jest') && chain.length === 2) {
        mockCalls.push({ name: chain[1] ?? '', startIndex: call.startIndex });
        continue;
      }
      if (chain && READ_FNS.test(last) && (chain.length === 1 || FS_ROOTS.has(chain[0] ?? ''))) {
        readCalls.push(call);
        const owner = enclosingFunctionName(call);
        if (owner) readerFns.add(owner);
        continue;
      }
      if (chain && chain.length <= 3) {
        const args = call.childForFieldName('arguments');
        calls.push({
          line: call.startPosition.row + 1,
          startIndex: call.startIndex,
          chain: chain.join('.'),
          firstLiteral: stringValue(args?.namedChildren[0] ?? null),
          argsText: args?.text ?? '',
        });
      }
    }
    // Calls to a local helper that reads files count as reads at the call site.
    for (const call of root.descendantsOfType('call_expression')) {
      const fn = call.childForFieldName('function');
      if (fn?.type === 'identifier' && readerFns.has(fn.text)) readCalls.push(call);
    }
    for (const call of readCalls) {
      const args = call.childForFieldName('arguments');
      const parts: string[] = [args?.text ?? ''];
      for (const arg of args?.namedChildren ?? [])
        if (arg.type === 'identifier') parts.push(initialisers.get(arg.text) ?? '');
      reads.push({
        line: call.startPosition.row + 1,
        pathText: parts.join(' '),
        boundTo: enclosingDeclarator(call),
      });
    }
    units.sort((a, b) => a.startIndex - b.startIndex);
    return { language, units, assertions, reads, readerFns, deps, mockCalls, calls };
  } finally {
    tree.delete();
  }
}
