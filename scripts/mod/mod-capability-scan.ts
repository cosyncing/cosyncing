/**
 * What the shipped mod reaches through the build, read from its syntax tree.
 *
 * This is a tripwire, not a sandbox. The mod runs inside every Claude session that installed it,
 * and the build -- not this file -- decides what a hooks module can actually do at run time. What
 * this scan does is make a change to the mod's reach impossible to land quietly: every use of the
 * handle and of the registration function has to sit in one of a few shapes a reviewer can read
 * at a glance, and anything else fails the gate until someone argues for it here. A clean result
 * says "the mod's reach is exactly the listed calls, as far as source review can tell"; it does
 * not say the mod cannot misbehave.
 *
 * The rule is attribution, not following. An earlier version tried to chase the handle through
 * aliases, destructuring, containers and helpers, and every expression kind it did not model was
 * a hole: `(0, $.process.run)()`, `(e ? $ : $).process`, `[$][0]`, a spread, a default parameter,
 * a closure that returns `$`, `arguments[0]`, the registration's `.catch`, a handler passed by
 * name. Now the handle is spelled `$` everywhere it exists, and every `$` must be one of:
 *   - a parameter named `$` (no default, no rest);
 *   - the base of a direct, un-parenthesized `$.ns.method(...)` call;
 *   - a whole argument to a function of this file whose parameter in that slot is also `$`.
 * The registration function is the first parameter of the exported `register`, and every use of
 * it must be a statement `on('name', [matcher,] (<$>, e, next) => ...)` with the handler inline.
 * Everything else is a refusal with a line number, including shapes that are harmless today.
 *
 * The transport has the same treatment. A dial must name the pinned origin followed directly by a
 * path (a literal starting with `/`, or a lookup in a constant routes table nothing writes), must
 * pass only `method`, `headers`, `body` and `socketPath`, and must take its socket from a slot that
 * only the socket resolver ever writes, behind a guard that turns an empty socket away first --
 * because `$.http.fetch` with an empty `socketPath` does not fail, it goes out over TCP.
 *
 * Only the curated `typescript` export surface is used: `ts.forEachToken`, `ts.isThisExpression`
 * and `ts.isAssignmentPattern` are absent from it, which is why some kind tests below are spelled
 * out rather than called as guards.
 */
import ts from 'typescript';

const KIND = ts.SyntaxKind;

/** Two namespace segments, which is the shape every `$` call in the build has. */
export const CAPABILITY_DEPTH = 2;

/** Namespaces the design decided against. Each is a capability, not a style preference. */
export const FORBIDDEN_NAMESPACES: readonly string[] = [
  'agent',
  'command',
  'config',
  'fs',
  'mcp',
  'model',
  'process',
  'session.authorize',
];

/** Globals whose presence is a refusal, by name, even when a local shadows them. */
export const FORBIDDEN_GLOBALS: readonly string[] = [
  'Bun',
  'Function',
  'Proxy',
  'Reflect',
  'WebAssembly',
  'child_process',
  'eval',
  'fetch',
  'global',
  'globalThis',
  'process',
  'require',
  'self',
  'setInterval',
  'setTimeout',
  'window',
];

/**
 * The only free names the mod may use: plain language built-ins with no reach of their own.
 *
 * A free name is one this file does not declare, so it is the environment's. Anything not on this
 * list -- a host API, a global the build adds later, a misspelled local -- is a refusal until it
 * is argued for here.
 */
export const ALLOWED_GLOBALS: readonly string[] = [
  'Array',
  'Boolean',
  'Date',
  'Error',
  'Infinity',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'RangeError',
  'Set',
  'String',
  'Symbol',
  'TypeError',
  'decodeURIComponent',
  'encodeURIComponent',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'undefined',
];

/**
 * Coarse backstop over code text, matched against the tokens joined with nothing between them.
 *
 * Joined with spaces -- which is how `codeOnlyText` reads -- `process.env` in code is the text
 * `process . env` and `classic.PreToolUse` is `classic . PreToolUse`, so those two needles could
 * only ever match the inside of a string literal. Joined tight they match code too.
 */
export const FORBIDDEN_TEXT: readonly string[] = ['child_process', 'classic.', 'node:', 'process.env'];

/** The options the mod's transport may set. `auth` is a credential and the rest retarget. */
export const ALLOWED_TRANSPORT_OPTIONS: readonly string[] = ['body', 'headers', 'method', 'socketPath'];

/** The function every socket path the transport uses must come from. */
export const SOCKET_RESOLVER = 'resolveSocketPath';
/** The predicate that must turn an empty or relative socket away before every dial. */
export const SOCKET_GUARD = 'isAbsolutePath';

/** A hook name the build can see: dotted words, no glob, no interpolation. */
const HOOK_NAME = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$/;
const ENV_NAME = /^[A-Z0-9_]+$/;
const SCHEME_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*/i;
/** The one handle spelling. A handle under any other name is a refusal, not something to chase. */
const HANDLE = '$';

export interface ScanOptions {
  /** Calls the mod may make, as `$.ns.method`. Anything else is a refusal. */
  intendedCalls: readonly string[];
  /** Environment names the mod may read. */
  intendedEnvReads: readonly string[];
  /** The one origin `$.http.fetch` may address. The socket carries the request, not the host. */
  fetchOrigin: string;
  /** The socket resolver's name; defaults to SOCKET_RESOLVER. */
  socketResolver?: string;
  /** The socket guard's name; defaults to SOCKET_GUARD. */
  socketGuard?: string;
}

export interface Inventory {
  /** Every `$.ns.method` the mod calls directly. There is no other way for it to call one. */
  calls: string[];
  /** Namespaces touched by those calls. */
  namespaces: string[];
  /** Hook registrations, as `name` or `name{key=value}`. */
  hooks: string[];
  /** Literal names passed to `$.env.get`. */
  envReads: string[];
  /** Literal names passed to `$.env.set`. Expected to stay empty. */
  envWrites: string[];
  /** Stable refusals. Empty means the file is clean. */
  violations: string[];
  /** Parse diagnostics. A file that does not parse is not scannable. */
  syntaxErrors: string[];
}

type WriteKind = 'assign' | 'append' | 'compound' | 'update' | 'delete' | 'destructure';

type UrlPart = { kind: 'text'; text: string } | { kind: 'route' } | { kind: 'opaque' };

/** A socket slot: a local, or one named property of a module constant. */
type SocketLocation =
  | { kind: 'local'; symbol: ts.Symbol; name: string }
  | { kind: 'member'; base: ts.Symbol; baseName: string; name: string };

function unwrapParens(node: ts.Node | undefined): ts.Node | undefined {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** `scheme://authority` at the head of a string, when there is one. */
function originOf(text: string): string | undefined {
  const match = SCHEME_AUTHORITY.exec(text);
  return match ? match[0] : undefined;
}

function codeTokens(source: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const parts: string[] = [];
  let token = scanner.scan();
  while (token !== KIND.EndOfFileToken) {
    parts.push(source.slice(scanner.getTokenPos(), scanner.getTextPos()));
    token = scanner.scan();
  }
  return parts;
}

/** Code text with comments removed by the lexer, so `//` inside a string stays characters. */
export function codeOnlyText(source: string): string {
  return codeTokens(source).join(' ');
}

/** The same tokens with nothing between them: `process . env` in code reads `process.env`. */
export function compactCodeText(source: string): string {
  return codeTokens(source).join('');
}

/** The needles in FORBIDDEN_TEXT that the module's code contains. */
export function forbiddenTextHits(source: string): string[] {
  const text = compactCodeText(source);
  return FORBIDDEN_TEXT.filter((needle) => text.includes(needle));
}

/**
 * Scan one module for everything it reaches through the SDK handle and the registration function.
 */
export function scanModule(file: string, source: string, config: ScanOptions): Inventory {
  const host = ts.createCompilerHost({});
  host.fileExists = (name: string) => name === file;
  host.readFile = (name: string) => (name === file ? source : undefined);
  host.getSourceFile = (name: string, languageVersion: ts.ScriptTarget) =>
    (name === file ? ts.createSourceFile(name, source, languageVersion, true, ts.ScriptKind.JS) : undefined);
  const program = ts.createProgram({
    rootNames: [file],
    options: { allowJs: true, checkJs: false, noResolve: true, noLib: true, target: ts.ScriptTarget.ES2022 },
    host,
  });
  const sourceFile = program.getSourceFile(file);
  if (!sourceFile) {
    return { calls: [], namespaces: [], hooks: [], envReads: [], envWrites: [], syntaxErrors: ['the file did not parse at all'], violations: ['unparsable: the module could not be read'] };
  }
  const checker = program.getTypeChecker();
  const topLevel = sourceFile.statements;
  const syntaxErrors = program.getSyntacticDiagnostics(sourceFile)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 140));

  const resolverName = config.socketResolver ?? SOCKET_RESOLVER;
  const guardName = config.socketGuard ?? SOCKET_GUARD;
  const calls = new Set<string>();
  const namespaces = new Set<string>();
  const hooks = new Set<string>();
  const envReads = new Set<string>();
  const envWrites = new Set<string>();
  const violations = new Set<string>();
  const fail = (code: string, detail: string): void => {
    violations.add(`${code}: ${detail}`);
  };
  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const at = (node: ts.Node): string => `line ${lineOf(node)}`;
  const textOf = (node: ts.Node): string => node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 60);

  // ---- an index of every identifier, and of every value reference by symbol ----

  /** True when the identifier is a name being declared or a property key, not a value read. */
  function isNameOnly(id: ts.Identifier): boolean {
    const parent = id.parent;
    if (!parent) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
    if (ts.isQualifiedName(parent) && parent.right === id) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === id) return true;
    if ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isGetAccessor(parent)
      || ts.isSetAccessor(parent) || ts.isPropertySignature(parent)) && parent.name === id) return true;
    if (ts.isBindingElement(parent) && (parent.propertyName === id || parent.name === id)) return true;
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)
      || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent))
      && parent.name === id) return true;
    if ((ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent))
      && parent.label === id) return true;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)
      || ts.isNamespaceImport(parent) || ts.isMetaProperty(parent)) return true;
    return false;
  }

  function valueSymbolOf(id: ts.Identifier): ts.Symbol | undefined {
    const parent = id.parent;
    if (parent && ts.isShorthandPropertyAssignment(parent) && parent.name === id) {
      return checker.getShorthandAssignmentValueSymbol(parent);
    }
    return checker.getSymbolAtLocation(id);
  }

  const identifiers: ts.Identifier[] = [];
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  (function index(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      identifiers.push(node);
      if (!isNameOnly(node)) {
        const symbol = valueSymbolOf(node);
        if (symbol) {
          const list = references.get(symbol) ?? [];
          list.push(node);
          references.set(symbol, list);
        }
      }
    }
    ts.forEachChild(node, index);
  })(sourceFile);

  const referencesOf = (symbol: ts.Symbol | undefined): ts.Identifier[] =>
    (symbol === undefined ? [] : references.get(symbol) ?? []);

  /** Whether a destructuring assignment target encloses the node: `[a] = x`, `({ a } = x)`. */
  function inAssignmentPattern(node: ts.Node): boolean {
    let current: ts.Node = node;
    for (;;) {
      const parent: ts.Node | undefined = current.parent;
      if (!parent) return false;
      if (ts.isParenthesizedExpression(parent) || ts.isArrayLiteralExpression(parent)
        || ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent) || ts.isObjectLiteralExpression(parent)) {
        current = parent;
        continue;
      }
      if (ts.isPropertyAssignment(parent) && parent.initializer === current) {
        current = parent;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(parent) && parent.name === current) {
        current = parent;
        continue;
      }
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === KIND.EqualsToken && parent.left === current) {
        return current !== node;
      }
      if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === current) return true;
      return false;
    }
  }

  /** How an expression is written to, or undefined when it is only read. */
  function writeKindOf(node: ts.Node): WriteKind | undefined {
    let current: ts.Node = node;
    while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
    const parent = current.parent;
    if (parent && ts.isBinaryExpression(parent) && parent.left === current) {
      const operator = parent.operatorToken.kind;
      if (operator === KIND.EqualsToken) return 'assign';
      if (operator === KIND.PlusEqualsToken) return 'append';
      if (operator >= KIND.FirstAssignment && operator <= KIND.LastAssignment) return 'compound';
    }
    if (parent && (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
      && (parent.operator === KIND.PlusPlusToken || parent.operator === KIND.MinusMinusToken)) return 'update';
    if (parent && ts.isDeleteExpression(parent)) return 'delete';
    if (inAssignmentPattern(current)) return 'destructure';
    return undefined;
  }

  /** The right-hand side of a plain `=` whose left side is the node. */
  function assignedValue(node: ts.Node): ts.Expression | undefined {
    let current: ts.Node = node;
    while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
    const parent = current.parent;
    return parent && ts.isBinaryExpression(parent) && parent.left === current ? parent.right : undefined;
  }

  const isWritten = (symbol: ts.Symbol | undefined): boolean =>
    referencesOf(symbol).some((reference) => writeKindOf(reference) !== undefined);

  /** A declaration in a `const` list. */
  function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
    return ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
  }

  /** The one function this identifier names in this file, when it can be nothing else. */
  function localFunction(callee: ts.Node): ts.FunctionLikeDeclaration | undefined {
    if (!ts.isIdentifier(callee)) return undefined;
    const symbol = checker.getSymbolAtLocation(callee);
    const declarations = symbol?.declarations ?? [];
    if (declarations.length !== 1 || isWritten(symbol)) return undefined;
    const declaration = declarations[0]!;
    if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration;
    if (ts.isVariableDeclaration(declaration) && isConstDeclaration(declaration)) {
      const value = unwrapParens(declaration.initializer);
      if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) return value;
    }
    return undefined;
  }

  /** The top-level function declaration with this name, when there is exactly one and nothing rebinds it. */
  function namedFunction(name: string): ts.FunctionDeclaration | undefined {
    const found = topLevel.filter((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body !== undefined);
    if (found.length !== 1) return undefined;
    const symbol = checker.getSymbolAtLocation(found[0]!.name!);
    if ((symbol?.declarations ?? []).length !== 1 || isWritten(symbol)) return undefined;
    return found[0];
  }

  /** `const NAME = 'text'`, read through its one declaration. */
  function constString(node: ts.Node | undefined): string | undefined {
    const value = unwrapParens(node);
    if (!value) return undefined;
    if (ts.isStringLiteralLike(value)) return value.text;
    if (!ts.isIdentifier(value)) return undefined;
    const declarations = checker.getSymbolAtLocation(value)?.declarations ?? [];
    if (declarations.length !== 1) return undefined;
    const declaration = declarations[0]!;
    if (!ts.isVariableDeclaration(declaration) || !isConstDeclaration(declaration)) return undefined;
    const initializer = unwrapParens(declaration.initializer);
    return initializer && ts.isStringLiteralLike(initializer) ? initializer.text : undefined;
  }

  function propertyNameOf(property: ts.ObjectLiteralElementLike): string | undefined {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
      || ts.isMethodDeclaration(property) || ts.isGetAccessor(property) || ts.isSetAccessor(property)) {
      const name = property.name;
      if (ts.isIdentifier(name)) return name.text;
      if (ts.isStringLiteralLike(name)) return name.text;
    }
    return undefined;
  }

  // ---- globals, `this`, `arguments`, imports ----

  const forbiddenGlobals = new Set(FORBIDDEN_GLOBALS);
  const allowedGlobals = new Set(ALLOWED_GLOBALS);
  for (const id of identifiers) {
    if (isNameOnly(id)) continue;
    if (id.text === 'arguments') {
      fail('forbidden-global', `${at(id)} reads arguments, which reaches every parameter by position, the handle included`);
      continue;
    }
    if (forbiddenGlobals.has(id.text)) {
      fail('forbidden-global', `${at(id)} refers to ${id.text}`);
      continue;
    }
    const symbol = valueSymbolOf(id);
    const free = symbol === undefined || (symbol.declarations ?? []).length === 0;
    if (free && id.text !== HANDLE && !allowedGlobals.has(id.text)) {
      fail('unlisted-global', `${at(id)} uses ${id.text}, which this file does not declare and the allowed globals do not list`);
    }
  }
  (function walkSpecial(node: ts.Node): void {
    if (node.kind === KIND.ThisKeyword) {
      fail('forbidden-global', `${at(node)} uses this, which the build may bind to anything, the handle included`);
    }
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      fail('forbidden-global', `${at(node)} imports a module`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === KIND.ImportKeyword) {
      fail('forbidden-global', `${at(node)} imports at runtime`);
    }
    if (ts.isMetaProperty(node)) fail('forbidden-global', `${at(node)} uses import.meta or new.target`);
    ts.forEachChild(node, walkSpecial);
  })(sourceFile);

  // ---- the handle ----

  /** Where a `$` sits, in words, for a refusal a person can act on. */
  function describeHandleUse(id: ts.Identifier): string {
    const parent = id.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
      if (parent.questionDotToken) return 'through optional chaining';
      const outer = parent.parent;
      if (ts.isElementAccessExpression(outer) && outer.expression === parent) return 'through a computed member';
      if (ts.isPropertyAccessExpression(outer) && outer.expression === parent) {
        if (outer.questionDotToken) return 'through optional chaining';
        const use = outer.parent;
        if (ts.isPropertyAccessExpression(use) || ts.isElementAccessExpression(use)) return `past the namespace pair (${textOf(use)})`;
        if (ts.isTaggedTemplateExpression(use)) return `as a tagged template (${textOf(outer)}), not a call`;
        if (ts.isCallExpression(use) && use.questionDotToken) return 'through an optional call';
        return `as a value (${textOf(outer)}) rather than calling it directly`;
      }
      return `as a value (${textOf(parent)}) rather than calling one of its members directly`;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === id) return 'through a computed member';
    if (ts.isVariableDeclaration(parent)) return 'bound to another name';
    if (ts.isBinaryExpression(parent)) {
      if (parent.operatorToken.kind === KIND.CommaToken) return 'inside a comma expression';
      if (parent.operatorToken.kind === KIND.EqualsToken) return parent.left === id ? 'as an assignment target' : 'assigned somewhere';
      return 'inside an expression';
    }
    if (ts.isConditionalExpression(parent)) return 'as a conditional branch';
    if (ts.isArrayLiteralExpression(parent)) return 'inside an array';
    if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) return 'inside an object literal';
    if (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) return 'spread';
    if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) return 'returned';
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return 'iterated';
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return `handed to ${textOf(parent.expression)}`;
    return `in a ${KIND[parent.kind]}`;
  }

  /** `$.ns.method(...)` with the `$` as its base: direct, un-parenthesized, no optional link. */
  function directCall(id: ts.Identifier): { capability: string; namespace: string; node: ts.CallExpression } | undefined {
    const first = id.parent;
    if (!ts.isPropertyAccessExpression(first) || first.expression !== id || first.questionDotToken) return undefined;
    const second = first.parent;
    if (!ts.isPropertyAccessExpression(second) || second.expression !== first || second.questionDotToken) return undefined;
    const call = second.parent;
    if (!ts.isCallExpression(call) || call.expression !== second || call.questionDotToken) return undefined;
    if (!ts.isIdentifier(first.name) || !ts.isIdentifier(second.name)) return undefined;
    return { capability: `$.${first.name.text}.${second.name.text}`, namespace: first.name.text, node: call };
  }

  /** A `$` handed whole to a function of this file. Undefined when the `$` is not an argument. */
  function handOff(id: ts.Identifier): { code: string; detail: string } | 'ok' | undefined {
    const call = id.parent;
    if (!ts.isCallExpression(call) || call.expression === id) return undefined;
    const index = call.arguments.indexOf(id);
    if (index < 0) return undefined;
    const name = textOf(call.expression);
    if (call.arguments.slice(0, index).some((argument) => ts.isSpreadElement(argument))) {
      return { code: 'handle-unattributable', detail: `${at(id)} hands $ to ${name} after a spread, so its slot cannot be named` };
    }
    const callee = localFunction(call.expression);
    if (!callee) {
      return { code: 'handle-unattributable', detail: `${at(id)} hands $ to ${name}, which is not a function of this file that nothing rebinds` };
    }
    const parameter = callee.parameters[index];
    if (!parameter) {
      return { code: 'handle-unattributable', detail: `${at(id)} hands $ to ${name}, which declares no parameter in that slot` };
    }
    if (parameter.dotDotDotToken || parameter.initializer || !ts.isIdentifier(parameter.name) || parameter.name.text !== HANDLE) {
      return { code: 'handle-renamed', detail: `${at(id)} hands $ to ${name}, whose parameter ${textOf(parameter)} is not a plain $` };
    }
    return 'ok';
  }

  const directCalls: { capability: string; namespace: string; node: ts.CallExpression }[] = [];
  for (const id of identifiers) {
    if (id.text !== HANDLE) continue;
    const parent = id.parent;
    if (ts.isParameter(parent) && parent.name === id) {
      if (parent.dotDotDotToken || parent.initializer) {
        fail('handle-unattributable', `${at(id)} declares $ with a default or as a rest parameter`);
      }
      continue;
    }
    if (isNameOnly(id)) {
      fail('handle-unattributable', `${at(id)} uses the name $ for something other than a parameter`);
      continue;
    }
    const direct = directCall(id);
    if (direct) {
      directCalls.push(direct);
      continue;
    }
    const handed = handOff(id);
    if (handed === 'ok') continue;
    if (handed) {
      fail(handed.code, handed.detail);
      continue;
    }
    fail('handle-unattributable', `${at(id)} uses $ ${describeHandleUse(id)}`);
  }

  // ---- the registration function, and the hooks it registers ----

  /** Hook names and matchers, which the build reads the same way, so both sides must be literal. */
  function checkRegistration(node: ts.CallExpression): void {
    const where = at(node);
    if (node.arguments.some((argument) => ts.isSpreadElement(argument))) {
      fail('hook-registration-unreadable', `${where} registers with spread arguments`);
      return;
    }
    if (node.arguments.length !== 2 && node.arguments.length !== 3) {
      fail('hook-registration-unreadable', `${where} registers with ${node.arguments.length} arguments`);
      return;
    }
    const handler = unwrapParens(node.arguments[node.arguments.length - 1]);
    if (!handler || !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
      fail('hook-registration-unreadable', `${where} registers a handler that is not written inline, so its handle cannot be named`);
    } else {
      const first = handler.parameters[0];
      if (first && (first.dotDotDotToken || first.initializer || !ts.isIdentifier(first.name) || first.name.text !== HANDLE)) {
        fail('handle-renamed', `${where} names its handler's handle ${textOf(first)} instead of a plain $`);
      }
    }
    const nameNode = unwrapParens(node.arguments[0]);
    const name = nameNode && ts.isStringLiteralLike(nameNode) ? nameNode.text : undefined;
    if (name === undefined || name.length === 0) {
      fail('hook-name-not-literal', `${where} registers a hook under a name built at runtime, a glob, or nothing`);
      return;
    }
    if (!HOOK_NAME.test(name)) {
      fail('hook-name-not-literal', `${where} registers hook ${JSON.stringify(name)}`);
      return;
    }
    if (name === 'engine' || name.startsWith('engine.')) {
      fail('forbidden-hook', `${where} registers ${name}, whose next(e) hands back the built handle`);
    }
    if (node.arguments.length === 2) {
      hooks.add(name);
      return;
    }
    const matcher = unwrapParens(node.arguments[1]);
    if (!matcher || !ts.isObjectLiteralExpression(matcher)) {
      fail('hook-name-not-literal', `${where} matches ${name} with something other than an object literal`);
      return;
    }
    const pairs: string[] = [];
    for (const property of matcher.properties) {
      const key = propertyNameOf(property);
      if (key === undefined || !ts.isPropertyAssignment(property)) {
        fail('hook-name-not-literal', `${where} builds a matcher for ${name} at runtime`);
        continue;
      }
      const value = constString(property.initializer);
      if (value === undefined) {
        fail('hook-name-not-literal', `${where} matches ${name}.${key} with a value this scan cannot read`);
        continue;
      }
      pairs.push(`${key}=${value}`);
    }
    hooks.add(`${name}{${pairs.sort().join(',')}}`);
  }

  const registerExports: ts.FunctionLikeDeclaration[] = [];
  const exported = (statement: ts.FunctionDeclaration | ts.VariableStatement): boolean =>
    (statement.modifiers ?? []).some((modifier) => modifier.kind === KIND.ExportKeyword);
  for (const statement of topLevel) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'register' && exported(statement) && statement.body) {
      registerExports.push(statement);
    }
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'register') continue;
        const value = unwrapParens(declaration.initializer);
        if (isConstDeclaration(declaration) && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
          registerExports.push(value);
        } else {
          fail('hook-registration-unreadable', `${at(declaration)} exports register as something other than a constant function`);
        }
      }
    }
  }
  if (registerExports.length !== 1) {
    fail('hook-registration-unreadable', registerExports.length === 0
      ? 'the module exports no register function, so no hook it registers can be read'
      : `the module exports register ${registerExports.length} times`);
  }
  const registrationParameter = registerExports.length === 1 ? registerExports[0]!.parameters[0] : undefined;
  if (registrationParameter) {
    if (registrationParameter.dotDotDotToken || registrationParameter.initializer || !ts.isIdentifier(registrationParameter.name)) {
      fail('hook-registration-unreadable', `${at(registrationParameter)} takes the registration function in a shape this scan cannot name`);
    } else {
      for (const reference of referencesOf(checker.getSymbolAtLocation(registrationParameter.name))) {
        const call = reference.parent;
        if (ts.isCallExpression(call) && call.expression === reference && !call.questionDotToken && ts.isExpressionStatement(call.parent)) {
          checkRegistration(call);
          continue;
        }
        const how = ts.isCallExpression(call) && call.expression === reference
          ? 'inside an expression, where what it returns can register more'
          : ts.isCallExpression(call) ? `as an argument to ${textOf(call.expression)}` : `in a ${KIND[call.kind]}`;
        fail('hook-registration-unreadable', `${at(reference)} uses the registration function ${how}`);
      }
    }
  }

  // Hook-shaped calls that are not `on(...)`: the rename that would hide a registration entirely.
  (function walkHookShapedCalls(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const first = unwrapParens(node.arguments[0]);
      const handler = node.arguments.slice(1).some((argument) => {
        const value = unwrapParens(argument);
        return value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value));
      });
      const callee = unwrapParens(node.expression);
      const isRegistration = registrationParameter !== undefined && callee !== undefined && ts.isIdentifier(callee)
        && ts.isIdentifier(registrationParameter.name)
        && checker.getSymbolAtLocation(callee) === checker.getSymbolAtLocation(registrationParameter.name);
      if (!isRegistration && first !== undefined && ts.isStringLiteralLike(first) && handler) {
        fail('hook-registration-unreadable', `${at(node)} hands a handler to ${textOf(node.expression)}, so its hooks are invisible to both scans`);
      }
    }
    ts.forEachChild(node, walkHookShapedCalls);
  })(sourceFile);

  // ---- the transport ----

  /** A lookup in a constant routes table whose values are all paths and that nothing writes. */
  function routeLookup(node: ts.Node): boolean {
    if (!ts.isElementAccessExpression(node) && !ts.isPropertyAccessExpression(node)) return false;
    if (node.questionDotToken) return false;
    const base = node.expression;
    if (!ts.isIdentifier(base)) return false;
    const symbol = checker.getSymbolAtLocation(base);
    const declarations = symbol?.declarations ?? [];
    if (declarations.length !== 1) return false;
    const declaration = declarations[0]!;
    if (!ts.isVariableDeclaration(declaration) || !isConstDeclaration(declaration)) return false;
    const table = unwrapParens(declaration.initializer);
    if (!table || !ts.isObjectLiteralExpression(table)) return false;
    for (const property of table.properties) {
      if (!ts.isPropertyAssignment(property) || propertyNameOf(property) === undefined) return false;
      const value = unwrapParens(property.initializer);
      if (!value || !ts.isStringLiteralLike(value) || !value.text.startsWith('/') || value.text.startsWith('//')) return false;
    }
    for (const reference of referencesOf(symbol)) {
      const access = reference.parent;
      const isMemberRead = (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access))
        && access.expression === reference && writeKindOf(access) === undefined
        && !(ts.isCallExpression(access.parent) && access.parent.expression === access);
      if (!isMemberRead) {
        fail('fetch-destination', `${at(reference)} ${writeKindOf(access) !== undefined ? 'writes' : 'uses'} the routes table ${base.text} other than by reading one route, so its paths are not pinned`);
        return false;
      }
    }
    return true;
  }

  /** The pieces a URL is built from, in order: fixed text, a pinned route, or something else. */
  function urlParts(node: ts.Node | undefined, seen: Set<ts.Node>): UrlPart[] {
    const current = unwrapParens(node);
    if (!current || seen.has(current)) return [{ kind: 'opaque' }];
    seen.add(current);
    if (ts.isStringLiteralLike(current)) return [{ kind: 'text', text: current.text }];
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === KIND.PlusToken) {
      return [...urlParts(current.left, seen), ...urlParts(current.right, seen)];
    }
    if (ts.isTemplateExpression(current)) {
      const parts: UrlPart[] = [{ kind: 'text', text: current.head.text }];
      for (const span of current.templateSpans) {
        parts.push(...urlParts(span.expression, seen), { kind: 'text', text: span.literal.text });
      }
      return parts;
    }
    if (ts.isIdentifier(current)) {
      const fixed = constString(current);
      if (fixed !== undefined) return [{ kind: 'text', text: fixed }];
      return builtUrl(current, seen);
    }
    if (routeLookup(current)) return [{ kind: 'route' }];
    return [{ kind: 'opaque' }];
  }

  /** A local the URL was built in: one initializer, then appends only. */
  function builtUrl(id: ts.Identifier, seen: Set<ts.Node>): UrlPart[] {
    const symbol = checker.getSymbolAtLocation(id);
    const declarations = symbol?.declarations ?? [];
    const declaration = declarations[0];
    if (declarations.length !== 1 || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      return [{ kind: 'opaque' }];
    }
    let appended = false;
    for (const reference of referencesOf(symbol)) {
      const kind = writeKindOf(reference);
      if (kind === undefined) continue;
      if (kind === 'append') {
        appended = true;
        continue;
      }
      fail('fetch-destination', `${at(reference)} rewrites the URL ${id.text} after it was built, rather than appending to it`);
      return [{ kind: 'opaque' }];
    }
    const parts = urlParts(declaration.initializer, seen);
    return appended ? [...parts, { kind: 'opaque' }] : parts;
  }

  /** The pinned origin, then a path, and no second authority anywhere in the fixed text. */
  function checkUrl(node: ts.Node | undefined, where: string): void {
    const parts = urlParts(node, new Set());
    let prefix = '';
    let index = 0;
    while (index < parts.length && parts[index]!.kind === 'text') {
      prefix += (parts[index] as { text: string }).text;
      index += 1;
    }
    const origin = config.fetchOrigin;
    if (!prefix.startsWith(origin)) {
      const named = originOf(prefix);
      fail('fetch-destination', `${where} addresses ${named ?? (prefix.length > 0 ? JSON.stringify(prefix.slice(0, 48)) : 'a URL built at runtime')} instead of ${origin}`);
      return;
    }
    const rest = prefix.slice(origin.length);
    if (rest.length > 0 && !rest.startsWith('/')) {
      fail('fetch-destination', `${where} continues the pinned host with ${JSON.stringify(rest.slice(0, 48))}; only a path may follow it, and an @ or a port there is a different host`);
      return;
    }
    if (rest.length === 0 && parts[index]?.kind !== 'route') {
      fail('fetch-destination', `${where} follows the pinned host with ${parts[index] ? 'a value built at runtime' : 'nothing'}, so the authority is not pinned`);
    }
    for (const part of parts.slice(1)) {
      if (part.kind !== 'text') continue;
      if (originOf(part.text) !== undefined || part.text.includes('//')) {
        fail('fetch-destination', `${where} builds a URL from ${JSON.stringify(part.text.slice(0, 48))}, which carries an authority`);
      }
    }
  }

  function socketLocationOf(node: ts.Node | undefined): SocketLocation | undefined {
    const value = unwrapParens(node);
    if (!value) return undefined;
    if (ts.isIdentifier(value)) {
      const symbol = valueSymbolOf(value);
      return symbol ? { kind: 'local', symbol, name: value.text } : undefined;
    }
    if (ts.isPropertyAccessExpression(value) && !value.questionDotToken && ts.isIdentifier(value.expression) && ts.isIdentifier(value.name)) {
      const base = checker.getSymbolAtLocation(value.expression);
      return base ? { kind: 'member', base, baseName: value.expression.text, name: value.name.text } : undefined;
    }
    return undefined;
  }

  const sameLocation = (left: SocketLocation | undefined, right: SocketLocation): boolean =>
    left !== undefined && left.kind === right.kind && left.name === right.name
    && (left.kind === 'local' ? left.symbol === (right as { symbol: ts.Symbol }).symbol
      : left.base === (right as { base: ts.Symbol }).base);

  const resolverFunction = namedFunction(resolverName);
  const guardFunction = namedFunction(guardName);
  const resolverSymbol = resolverFunction?.name ? checker.getSymbolAtLocation(resolverFunction.name) : undefined;
  const guardSymbol = guardFunction?.name ? checker.getSymbolAtLocation(guardFunction.name) : undefined;

  /** `resolveSocketPath(...)`, called directly. */
  function isResolverCall(node: ts.Node | undefined): boolean {
    const value = unwrapParens(node);
    return resolverSymbol !== undefined && value !== undefined && ts.isCallExpression(value)
      && ts.isIdentifier(value.expression) && checker.getSymbolAtLocation(value.expression) === resolverSymbol;
  }

  const isEmptyString = (node: ts.Node | undefined): boolean => {
    const value = unwrapParens(node);
    return value !== undefined && ts.isStringLiteralLike(value) && value.text === '';
  };

  /**
   * Every write to the socket slot, which must be the resolver's answer. The slot's declared
   * starting value may be empty -- that is the resolver's own "unresolved" answer -- and the
   * guard before the dial is what keeps an empty slot off the wire.
   */
  function checkSocketWrites(location: SocketLocation, where: string): void {
    let resolverWrites = 0;
    const describe = location.kind === 'local' ? location.name : `${location.baseName}.${location.name}`;
    const checkWrite = (reference: ts.Node): void => {
      const kind = writeKindOf(reference);
      if (kind === undefined) return;
      if (kind === 'assign' && isResolverCall(assignedValue(reference))) {
        resolverWrites += 1;
        return;
      }
      fail('fetch-destination', `${at(reference)} writes the socket ${describe} from something other than ${resolverName}(...)`);
    };
    if (location.kind === 'local') {
      const declarations = location.symbol.declarations ?? [];
      const declaration = declarations[0];
      if (declarations.length !== 1 || !declaration || !ts.isVariableDeclaration(declaration)) {
        fail('fetch-destination', `${where} takes its socket from ${describe}, which is not a plain local`);
        return;
      }
      if (isResolverCall(declaration.initializer)) resolverWrites += 1;
      else if (declaration.initializer !== undefined && !isEmptyString(declaration.initializer)) {
        fail('fetch-destination', `${at(declaration)} starts the socket ${describe} as ${textOf(declaration.initializer)}, not ${resolverName}(...)`);
      }
      for (const reference of referencesOf(location.symbol)) checkWrite(reference);
    } else {
      const declarations = location.base.declarations ?? [];
      const declaration = declarations[0];
      const holder = declaration && ts.isVariableDeclaration(declaration) && isConstDeclaration(declaration)
        ? unwrapParens(declaration.initializer) : undefined;
      if (declarations.length !== 1 || !holder || !ts.isObjectLiteralExpression(holder)) {
        fail('fetch-destination', `${where} takes its socket from ${describe}, and ${location.baseName} is not a constant object literal`);
        return;
      }
      let declared = 0;
      for (const property of holder.properties) {
        const key = propertyNameOf(property);
        if (key === undefined || ts.isSpreadAssignment(property)) {
          fail('fetch-destination', `${at(property)} builds ${location.baseName}, which holds the socket, with a key this scan cannot read`);
          continue;
        }
        if (key !== location.name) continue;
        declared += 1;
        if (!ts.isPropertyAssignment(property)) {
          fail('fetch-destination', `${at(property)} declares the socket ${describe} in a shape this scan cannot read`);
        } else if (isResolverCall(property.initializer)) {
          resolverWrites += 1;
        } else if (!isEmptyString(property.initializer)) {
          fail('fetch-destination', `${at(property)} starts the socket ${describe} as ${textOf(property.initializer)}, not ${resolverName}(...)`);
        }
      }
      if (declared > 1) fail('fetch-destination', `${where}: ${location.baseName} declares ${location.name} ${declared} times`);
      for (const reference of referencesOf(location.base)) {
        const access = reference.parent;
        if (!ts.isPropertyAccessExpression(access) || access.expression !== reference) {
          fail('fetch-destination', `${at(reference)} uses ${location.baseName}, which holds the socket, whole, where the socket can be written unseen`);
          continue;
        }
        if (access.name.text === location.name) checkWrite(access);
      }
    }
    if (!resolverFunction) {
      fail('fetch-destination', `${where}: the module has no single ${resolverName} function that nothing rebinds, so no socket can be traced to it`);
    } else if (resolverWrites === 0) {
      fail('fetch-destination', `${where} takes its socket from ${describe}, which ${resolverName} never writes`);
    }
  }

  /** The statement of a function body that contains the node, with the body it belongs to. */
  function bodyStatementOf(node: ts.Node): { body: ts.Block; index: number } | undefined {
    let current: ts.Node = node;
    while (current.parent) {
      const parent: ts.Node = current.parent;
      if (ts.isBlock(parent) && parent.parent && (ts.isFunctionDeclaration(parent.parent) || ts.isFunctionExpression(parent.parent)
        || ts.isArrowFunction(parent.parent) || ts.isMethodDeclaration(parent.parent))) {
        return { body: parent, index: parent.statements.indexOf(current as ts.Statement) };
      }
      if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isArrowFunction(parent)) return undefined;
      current = parent;
    }
    return undefined;
  }

  /** `if (!isAbsolutePath(<the socket>)) throw|return`, as one statement. */
  function isGuard(statement: ts.Statement, location: SocketLocation): boolean {
    if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
    const test = unwrapParens(statement.expression);
    if (!test || !ts.isPrefixUnaryExpression(test) || test.operator !== KIND.ExclamationToken) return false;
    const call = unwrapParens(test.operand);
    if (!call || !ts.isCallExpression(call) || call.arguments.length !== 1 || guardSymbol === undefined) return false;
    if (!ts.isIdentifier(call.expression) || checker.getSymbolAtLocation(call.expression) !== guardSymbol) return false;
    if (!sameLocation(socketLocationOf(call.arguments[0]), location)) return false;
    let exit: ts.Statement = statement.thenStatement;
    if (ts.isBlock(exit)) {
      if (exit.statements.length !== 1) return false;
      exit = exit.statements[0]!;
    }
    return ts.isThrowStatement(exit) || ts.isReturnStatement(exit);
  }

  /**
   * An await or yield in the node, outside any function nested in it. With `before`, only one that
   * finishes before that position counts: the `await` wrapped around the dial itself suspends after
   * the request is built, which is the one suspension that cannot change the socket it carries.
   */
  function suspends(node: ts.Node, before?: number): boolean {
    let found = false;
    (function visit(current: ts.Node): void {
      if (found) return;
      if ((ts.isAwaitExpression(current) || ts.isYieldExpression(current)) && (before === undefined || current.end <= before)) {
        found = true;
        return;
      }
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) return;
      ts.forEachChild(current, visit);
    })(node);
    return found;
  }

  /**
   * The dial runs only after the guard turned an empty socket away, with nothing in between that
   * could hand control to code that writes the slot again.
   */
  function checkGuard(fetchCall: ts.CallExpression, location: SocketLocation, where: string): void {
    if (!guardFunction) {
      fail('fetch-destination', `${where}: the module has no single ${guardName} function that nothing rebinds, so no dial can be shown to be guarded`);
      return;
    }
    const site = bodyStatementOf(fetchCall);
    const statements = site?.body.statements ?? [];
    let guardAt = -1;
    for (let i = 0; site !== undefined && i < site.index; i += 1) {
      if (isGuard(statements[i]!, location)) guardAt = i;
    }
    if (!site || guardAt < 0) {
      fail('fetch-destination', `${where} dials without first turning an empty socket away (if (!${guardName}(socket)) throw)`);
      return;
    }
    const between = statements.slice(guardAt + 1, site.index).some((statement) => suspends(statement));
    const containing = statements[site.index]!;
    const beforeDial = suspends(containing, fetchCall.getStart(sourceFile))
      || fetchCall.arguments.some((argument) => suspends(argument));
    if (between || beforeDial) {
      fail('fetch-destination', `${where} can suspend between the socket guard and the dial, where the socket can change`);
    }
  }

  function checkTransportOptions(node: ts.Node | undefined, fetchCall: ts.CallExpression, where: string): void {
    const init = unwrapParens(node);
    if (!init || !ts.isObjectLiteralExpression(init)) {
      fail('fetch-destination', `${where} has no readable options object, so the socket cannot be proven`);
      return;
    }
    const keys = new Set<string>();
    let socket: ts.Node | undefined;
    for (const property of init.properties) {
      if (ts.isSpreadAssignment(property)) {
        fail('fetch-destination', `${where} spreads its transport options, which hides the socket`);
        continue;
      }
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        fail('fetch-destination', `${where} defines a transport option as a method or an accessor`);
        continue;
      }
      const key = propertyNameOf(property);
      if (key === undefined) {
        fail('fetch-destination', `${where} builds a transport option name at runtime`);
        continue;
      }
      if (keys.has(key)) fail('fetch-destination', `${where} sets ${key} twice, and the later one is the one that counts`);
      keys.add(key);
      if (!ALLOWED_TRANSPORT_OPTIONS.includes(key)) {
        fail('fetch-destination', `${where} sets ${key}, which can carry a credential or move a request off the socket`);
      }
      if (key === 'socketPath') socket = ts.isPropertyAssignment(property) ? property.initializer : property.name;
    }
    if (socket === undefined) {
      fail('fetch-destination', `${where} sets no socketPath, so the request goes out over TCP`);
      return;
    }
    const location = socketLocationOf(socket);
    if (!location) {
      fail('fetch-destination', `${where} takes its socketPath from ${textOf(socket)}, which this scan cannot trace to ${resolverName}`);
      return;
    }
    checkSocketWrites(location, where);
    checkGuard(fetchCall, location, where);
  }

  function checkFetch(node: ts.CallExpression): void {
    const where = at(node);
    if (node.arguments.length !== 2 || node.arguments.some((argument) => ts.isSpreadElement(argument))) {
      fail('fetch-destination', `${where} calls the transport with an arity or a spread this scan cannot read`);
      return;
    }
    checkUrl(node.arguments[0], where);
    checkTransportOptions(node.arguments[1], node, where);
  }

  // ---- the direct calls themselves ----

  const intendedNamespaces = new Set(config.intendedCalls.map((call) => call.split('.')[1] ?? ''));
  for (const { capability, namespace, node } of directCalls) {
    const where = at(node);
    calls.add(capability);
    namespaces.add(namespace);
    if (FORBIDDEN_NAMESPACES.some((forbidden) => capability === `$.${forbidden}` || capability.startsWith(`$.${forbidden}.`))) {
      fail('forbidden-capability', `${where} reaches ${capability}`);
    }
    if (!intendedNamespaces.has(namespace)) fail('unintended-capability', `${where} touches the ${namespace} namespace`);
    if (!config.intendedCalls.includes(capability)) fail('unintended-capability', `${where} calls ${capability}`);
    if (capability === '$.env.get') {
      const argument = unwrapParens(node.arguments[0]);
      const name = argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
      if (node.arguments.length !== 1 || name === undefined) {
        fail('env-read-not-literal', `${where} reads an environment name this scan cannot see`);
      } else if (!ENV_NAME.test(name)) {
        fail('env-read-not-literal', `${where} reads ${JSON.stringify(name)}`);
      } else {
        envReads.add(name);
        if (!config.intendedEnvReads.includes(name)) fail('unintended-env-read', `${where} reads ${name}, which the intended list does not name`);
      }
    }
    if (capability === '$.env.set') {
      const name = constString(node.arguments[0]) ?? '<unreadable>';
      envWrites.add(name);
      fail('forbidden-capability', `${where} writes the environment (${name})`);
    }
    if (capability === '$.http.fetch') checkFetch(node);
  }

  for (const needle of forbiddenTextHits(source)) {
    fail('forbidden-text', `the code contains ${JSON.stringify(needle)}`);
  }

  return {
    calls: [...calls].sort(),
    namespaces: [...namespaces].sort(),
    hooks: [...hooks].sort(),
    envReads: [...envReads].sort(),
    envWrites: [...envWrites].sort(),
    violations: [...violations].sort(),
    syntaxErrors,
  };
}
