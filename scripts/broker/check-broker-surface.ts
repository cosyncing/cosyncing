/**
 * Broker drift guard (W1): verify that the machine-readable broker contract surface in
 * packages/typescript/protocol/src/index.ts stays aligned with runtime.ts and the multi-file client contract export
 * remains self-contained.
 *
 * - literal /api routes in runtime.ts must exist in BROKER_ROUTES
 * - literal stable error `code` values in runtime.ts JSON responses must exist in
 *   BROKER_ERROR_CODES
 *
 * Why it intentionally does not require route methods: most broker routes are method-guarded
 * outside path normalization (`req.method`) and this guard is designed to catch the route shape
 * first; method mismatches are validated by explicit endpoint tests.
 */
export {};

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import {
  BROKER_CLIENT_MESSAGE_KINDS,
  BROKER_ERROR_CODES,
  BROKER_INTEGRATION_ROUTES,
  BROKER_ROUTES,
  BROKER_WIRE_FRAME_KINDS,
} from '../../packages/typescript/protocol/src/index.ts';
import { CLIENT_CONTRACT_SOURCE_FILES, renderClientContract } from './lib/client-contract.ts';

const ROOT = join(import.meta.dir, '..', '..');
const CORE_TS = join(ROOT, 'packages/typescript/protocol/src/index.ts');
const MAIN_TS = join(ROOT, 'packages/typescript/broker/src/runtime/runtime.ts');
const HUB_TS = join(ROOT, 'packages/typescript/broker/src/sessions/hub.ts');
const R2_EXPORT_TS = join(ROOT, 'packages/typescript/broker/src/security/r2-export.ts');
const HISTORY_DELTA_TS = join(ROOT, 'packages/typescript/broker/src/sessions/history-delta.ts');
const CLIENT_MESSAGE_POLICY_TS = join(ROOT, 'packages/typescript/broker/src/sessions/client-message-policy.ts');
const PROTOCOL_JOURNAL_TS = join(ROOT, 'packages/typescript/broker/src/sessions/protocol-journal.ts');
const DRIVE_ATTACH_REFUSAL_TS = CLIENT_MESSAGE_POLICY_TS;

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function isPathIdentifier(expr: ts.Expression): boolean {
  return ts.isIdentifier(expr) && expr.text === 'path';
}

function templateOrString(value: ts.Expression): string | undefined {
  if (ts.isStringLiteral(value)) return value.text;
  if (ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  return undefined;
}

function normalizePath(path: string): string {
  if (!path.startsWith('/')) return `/${path}`;
  return path;
}

function normalizeRegexRoute(raw: string): string {
  let src = raw;
  if (src.startsWith('^')) src = src.slice(1);
  if (src.endsWith('$')) src = src.slice(0, -1);
  src = src.replace(/\\\//g, '/');
  src = src.replace(/\(\[\^\/\]\+\)/g, '{id}');
  src = src.replace(/\([^)]*\)/g, '{id}');
  src = src.replace(/\\([.^$|?+*[\]{}()])/g, '$1');
  src = src.replace(/\\\w/g, (m) => m.slice(1));
  src = src.replace(/\/+/g, '/');
  return normalizePath(src);
}

function extractRegexSource(node: ts.RegularExpressionLiteral): string {
  const raw = node.getText();
  const first = raw.indexOf('/');
  const last = raw.lastIndexOf('/');
  if (first === -1 || last <= first) return raw;
  return raw.slice(first + 1, last);
}

function extractRoutesFromMain(source: string, prefixes: readonly string[]): Set<string> {
  const sf = ts.createSourceFile(MAIN_TS, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const routes = new Set<string>();
  const add = (route: string | undefined) => {
    if (!route) return;
    if (prefixes.some((prefix) => route.startsWith(prefix))) routes.add(normalizePath(route));
  };

  const visit = (node: ts.Node): void => {
    // path === '/api/...'
    if (ts.isBinaryExpression(node)) {
      const isEq =
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken;
      if (isEq) {
        const left = templateOrString(node.left);
        const right = templateOrString(node.right);
        if (isPathIdentifier(node.left as ts.Expression) && right !== undefined) add(right);
        else if (isPathIdentifier(node.right as ts.Expression) && left !== undefined) add(left);
      }
    }

    // path.match(/^\/api\/.../)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length === 1) {
      const { expression, name } = node.expression;
      if (isPathIdentifier(expression)) {
        const arg = node.arguments[0];
        if (name.text === 'match' && arg && ts.isRegularExpressionLiteral(arg)) {
          add(normalizeRegexRoute(extractRegexSource(arg)));
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return routes;
}

function collectRunTranscriptResultVariables(sourceFile: ts.SourceFile): Set<string> {
  const vars = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      const call =
        ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'runTranscriptExport'
          ? init.expression
          : ts.isAwaitExpression(init) && ts.isCallExpression(init.expression)
            ? ts.isIdentifier(init.expression.expression) && init.expression.expression.text === 'runTranscriptExport'
              ? init.expression.expression
              : undefined
            : undefined;
      if (call && ts.isIdentifier(node.name)) vars.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return vars;
}

function extractErrorCodesFromMain(source: string): { literals: Set<string>; dynamicTranscriptExportCodes: boolean } {
  const sf = ts.createSourceFile(MAIN_TS, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const literals = new Set<string>();
  const resultVars = collectRunTranscriptResultVariables(sf);
  let dynamicTranscriptExportCodes = false;

  const isCodeProperty = (node: ts.Node): node is ts.PropertyAssignment =>
    ts.isPropertyAssignment(node) && node.name.getText(sf) === 'code';

  const visit = (node: ts.Node): void => {
    if (isCodeProperty(node)) {
      if (ts.isStringLiteral(node.initializer)) literals.add(node.initializer.text);
      else if (ts.isNoSubstitutionTemplateLiteral(node.initializer)) literals.add(node.initializer.text);
      else if (ts.isPropertyAccessExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
        const base = node.initializer.expression.text;
        if (node.initializer.name.text === 'code' && resultVars.has(base)) {
          dynamicTranscriptExportCodes = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { literals, dynamicTranscriptExportCodes };
}

function collectR2ExportCodes(source: string): Set<string> {
  const sf = ts.createSourceFile(R2_EXPORT_TS, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const codes = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'refuse' && node.arguments.length >= 3) {
        const codeArg = node.arguments[2]!;
        if (ts.isStringLiteral(codeArg)) codes.add(codeArg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return codes;
}

function collectStringUnion(source: string, fileName: string, typeName: string): Set<string> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const codes = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      const types = ts.isUnionTypeNode(node.type) ? node.type.types : [node.type];
      for (const type of types) {
        if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) codes.add(type.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return codes;
}

function routeDiff(found: string[], expected: string[]): string[] {
  const set = new Set(expected);
  return found.filter((route) => !set.has(route));
}

function codeDiff(found: string[], expected: string[]): string[] {
  const set = new Set(expected);
  return found.filter((code) => !set.has(code));
}

function extractWireEventKinds(source: string): Set<string> {
  const sf = ts.createSourceFile(HUB_TS, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const kinds = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'WireEvent' && ts.isUnionTypeNode(node.type)) {
      for (const type of node.type.types) {
        if (!ts.isTypeLiteralNode(type)) continue;
        for (const member of type.members) {
          if (!ts.isPropertySignature(member) || member.name?.getText(sf) !== 'kind' || !member.type) continue;
          if (ts.isLiteralTypeNode(member.type) && ts.isStringLiteral(member.type.literal)) kinds.add(member.type.literal.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return kinds;
}

function functionBodyByName(sf: ts.SourceFile, name: string): ts.Block | undefined {
  let found: ts.Block | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.body;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function isKindExpression(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr) && expr.text === 'kind') return true;
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'kind') return true;
  return false;
}

function extractClientMessageKinds(source: string): Set<string> {
  const sf = ts.createSourceFile(MAIN_TS, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const kinds = new Set<string>();
  const bodies = [
    'routeInbound',
    'handleManagedClientMessage',
    'isPromptClientMessage',
    'isMutatingClientMessage',
  ].map((name) => functionBodyByName(sf, name)).filter((body): body is ts.Block => Boolean(body));

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const isEq =
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken;
      if (isEq) {
        if (isKindExpression(node.left as ts.Expression) && ts.isStringLiteral(node.right)) kinds.add(node.right.text);
        if (isKindExpression(node.right as ts.Expression) && ts.isStringLiteral(node.left)) kinds.add(node.left.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const body of bodies) visit(body);
  return kinds;
}

function main(): void {
  let clientContractError: string | undefined;
  let clientContractBytes = 0;
  try {
    clientContractBytes = Buffer.byteLength(renderClientContract(ROOT));
  } catch (error) {
    clientContractError = error instanceof Error ? error.message : String(error);
  }
  const mainSource = readText(MAIN_TS);
  const brokerRoutes = extractRoutesFromMain(mainSource, ['/api']);
  const integrationRoutes = extractRoutesFromMain(mainSource, ['/pi/bridge/', '/omp/bridge/', '/claude/hook/']);
  const { literals: literalCodes, dynamicTranscriptExportCodes } = extractErrorCodesFromMain(mainSource);
  const wireKinds = extractWireEventKinds(readText(HUB_TS));
  const clientKinds = extractClientMessageKinds(mainSource);

  const requiredCodes = new Set(literalCodes);
  const { literals: protocolJournalCodes } = extractErrorCodesFromMain(readText(PROTOCOL_JOURNAL_TS));
  for (const code of protocolJournalCodes) requiredCodes.add(code);
  if (dynamicTranscriptExportCodes) {
    for (const code of collectR2ExportCodes(readText(R2_EXPORT_TS))) requiredCodes.add(code);
  }
  const coreSource = readText(CORE_TS);
  for (const code of collectStringUnion(coreSource, CORE_TS, 'FsRejectCode')) requiredCodes.add(code);
  for (const code of collectStringUnion(readText(HISTORY_DELTA_TS), HISTORY_DELTA_TS, 'HistoryGapCode')) requiredCodes.add(code);
  for (const code of collectStringUnion(coreSource, CORE_TS, 'UploadErrorCode')) requiredCodes.add(code);
  for (const code of collectStringUnion(coreSource, CORE_TS, 'WakePushErrorCode')) requiredCodes.add(code);
  for (const code of collectStringUnion(coreSource, CORE_TS, 'MachinePeerErrorCode')) requiredCodes.add(code);
  for (const code of collectStringUnion(coreSource, CORE_TS, 'MachineRouteErrorCode')) requiredCodes.add(code);
  for (const code of collectStringUnion(coreSource, CORE_TS, 'PairingErrorCode')) requiredCodes.add(code);
  for (const code of collectStringUnion(coreSource, CORE_TS, 'ScheduleErrorCode')) requiredCodes.add(code);
  for (const code of collectStringUnion(
    readText(CLIENT_MESSAGE_POLICY_TS),
    CLIENT_MESSAGE_POLICY_TS,
    'ClientMessagePolicyErrorCode',
  )) requiredCodes.add(code);
  for (const code of collectStringUnion(
    readText(DRIVE_ATTACH_REFUSAL_TS),
    DRIVE_ATTACH_REFUSAL_TS,
    'DriveAttachRefusalCode',
  )) requiredCodes.add(code);
  const sortedRoutes = [...brokerRoutes].sort();
  const sortedCodes = [...requiredCodes].sort();
  const sortedWireKinds = [...wireKinds].sort();
  const sortedClientKinds = [...clientKinds].sort();
  const routeGaps = routeDiff(sortedRoutes, [...BROKER_ROUTES]);
  const staleRoutes = routeDiff([...BROKER_ROUTES].sort(), sortedRoutes);
  const sortedIntegrationRoutes = [...integrationRoutes].sort();
  const integrationRouteGaps = routeDiff(sortedIntegrationRoutes, [...BROKER_INTEGRATION_ROUTES]);
  const staleIntegrationRoutes = routeDiff([...BROKER_INTEGRATION_ROUTES].sort(), sortedIntegrationRoutes);
  const codeGaps = codeDiff(sortedCodes, [...BROKER_ERROR_CODES]);
  const staleCodes = codeDiff([...BROKER_ERROR_CODES].sort(), sortedCodes);
  const wireGaps = codeDiff(sortedWireKinds, [...BROKER_WIRE_FRAME_KINDS]);
  const staleWireKinds = codeDiff([...BROKER_WIRE_FRAME_KINDS].sort(), sortedWireKinds);
  const clientKindGaps = codeDiff(sortedClientKinds, [...BROKER_CLIENT_MESSAGE_KINDS]);
  const staleClientKinds = codeDiff([...BROKER_CLIENT_MESSAGE_KINDS].sort(), sortedClientKinds);
  const fail =
    routeGaps.length > 0 ||
    staleRoutes.length > 0 ||
    integrationRouteGaps.length > 0 ||
    staleIntegrationRoutes.length > 0 ||
    codeGaps.length > 0 ||
    staleCodes.length > 0 ||
    wireGaps.length > 0 ||
    staleWireKinds.length > 0 ||
    clientKindGaps.length > 0 ||
    staleClientKinds.length > 0 ||
    clientContractError !== undefined;

  console.log('── Broker surface drift check (W1) ──');
  console.log(`client contract sources: ${CLIENT_CONTRACT_SOURCE_FILES.join(', ')}`);
  if (clientContractError) console.log(`FAIL: client contract export: ${clientContractError}`);
  else console.log(`client contract export: self-contained (${clientContractBytes} bytes)`);
  console.log(`/api routes discovered: ${sortedRoutes.length}`);
  console.log(`broker contract routes: ${BROKER_ROUTES.length}`);
  for (const route of sortedRoutes) console.log(`  route: ${route}`);

  if (routeGaps.length) {
    console.log(`\nFAIL: ${routeGaps.length} discovered /api route(s) are missing from BROKER_ROUTES:`);
    for (const route of routeGaps) console.log(`  - ${route}`);
  }
  if (staleRoutes.length) {
    console.log(`\nFAIL: ${staleRoutes.length} BROKER_ROUTES entr${staleRoutes.length === 1 ? 'y is' : 'ies are'} stale/not discovered in runtime.ts:`);
    for (const route of staleRoutes) console.log(`  - ${route}`);
  }

  console.log(`\nintegration routes discovered: ${sortedIntegrationRoutes.length}`);
  console.log(`broker integration contract routes: ${BROKER_INTEGRATION_ROUTES.length}`);
  for (const route of sortedIntegrationRoutes) console.log(`  integration route: ${route}`);
  if (integrationRouteGaps.length) {
    console.log(`\nFAIL: ${integrationRouteGaps.length} integration route(s) are missing from BROKER_INTEGRATION_ROUTES:`);
    for (const route of integrationRouteGaps) console.log(`  - ${route}`);
  }
  if (staleIntegrationRoutes.length) {
    console.log(`\nFAIL: ${staleIntegrationRoutes.length} BROKER_INTEGRATION_ROUTES entries are stale/not discovered in runtime.ts:`);
    for (const route of staleIntegrationRoutes) console.log(`  - ${route}`);
  }

  console.log(`\nstable error codes discovered: ${sortedCodes.length}`);
  for (const code of sortedCodes) console.log(`  code: ${code}`);
  if (codeGaps.length) {
    console.log(`\nFAIL: ${codeGaps.length} stable error code(s) are missing from BROKER_ERROR_CODES:`);
    for (const code of codeGaps) console.log(`  - ${code}`);
  }
  if (staleCodes.length) {
    console.log(`\nFAIL: ${staleCodes.length} BROKER_ERROR_CODES entr${staleCodes.length === 1 ? 'y is' : 'ies are'} stale/not emitted or declared by broker helpers:`);
    for (const code of staleCodes) console.log(`  - ${code}`);
  }

  console.log(`\nwire frame kinds discovered: ${sortedWireKinds.length}`);
  for (const kind of sortedWireKinds) console.log(`  wire: ${kind}`);
  if (wireGaps.length) {
    console.log(`\nFAIL: ${wireGaps.length} WireEvent kind(s) are missing from BROKER_WIRE_FRAME_KINDS:`);
    for (const kind of wireGaps) console.log(`  - ${kind}`);
  }
  if (staleWireKinds.length) {
    console.log(`\nFAIL: ${staleWireKinds.length} BROKER_WIRE_FRAME_KINDS entr${staleWireKinds.length === 1 ? 'y is' : 'ies are'} stale/not in WireEvent:`);
    for (const kind of staleWireKinds) console.log(`  - ${kind}`);
  }

  console.log(`\nclient message kinds discovered: ${sortedClientKinds.length}`);
  for (const kind of sortedClientKinds) console.log(`  client: ${kind}`);
  if (clientKindGaps.length) {
    console.log(`\nFAIL: ${clientKindGaps.length} handled client message kind(s) are missing from BROKER_CLIENT_MESSAGE_KINDS:`);
    for (const kind of clientKindGaps) console.log(`  - ${kind}`);
  }
  if (staleClientKinds.length) {
    console.log(`\nFAIL: ${staleClientKinds.length} BROKER_CLIENT_MESSAGE_KINDS entr${staleClientKinds.length === 1 ? 'y is' : 'ies are'} stale/not handled by runtime.ts:`);
    for (const kind of staleClientKinds) console.log(`  - ${kind}`);
  }

  if (dynamicTranscriptExportCodes) {
    console.log('\nINFO: runtime.ts forwards runTranscriptExport().code via result.code in /api/sessions/{id}/{id}/export');
  }

  if (fail) process.exit(1);
  console.log('\nPASS: broker surface and error-code contracts are aligned');
}

main();
