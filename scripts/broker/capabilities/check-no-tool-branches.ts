#!/usr/bin/env bun
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

type Finding = {
  file: string;
  line: number;
  column: number;
  expression: string;
  agentId: string;
  suggestedReplacement: string;
};

const ROOT = join(import.meta.dir, '..', '..', '..');
const SCAN_ROOTS = [
  'packages/typescript/broker/src',
  'apps/poc-ui/public',
  'packages/typescript/protocol/src',
];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const AGENT_IDS = new Set(['opencode', 'pi', 'codex', 'claude']);
const TOOL_FIELD_NAMES = new Set(['id', 'tool', 'agent', 'agentId', 'toolId', 'backendId']);
const TOOL_IDENTIFIER_NAMES = new Set(['id', 'tool', 'agent', 'agentId', 'toolId', 'backend', 'backendId']);

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function usage(): never {
  console.error('usage: bun run scripts/broker/capabilities/check-no-tool-branches.ts --write-output <dir>');
  process.exit(2);
}

const outDir = argValue('--write-output') ?? 'output/capabilities/tool-branches';
if (!outDir) usage();

function argValues(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1]) values.push(process.argv[++i]!);
  }
  return values;
}

function collectFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const path = join(abs, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'fixtures' || entry === 'generated') continue;
      out.push(...collectFiles(relative(ROOT, path)));
    } else if (st.isFile() && EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) {
      out.push(path);
    }
  }
  return out;
}

function sourceKind(path: string): ts.ScriptKind {
  if (path.endsWith('.js')) return ts.ScriptKind.JS;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function readSource(path: string): string {
  return readFileSync(path).toString('utf8').replace(/\0/g, '');
}

function stringLiteralValue(node: ts.Node): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function regexLiteralAgentIds(node: ts.Node): string[] {
  if (node.kind !== ts.SyntaxKind.RegularExpressionLiteral) return [];
  const text = node.getText();
  return [...AGENT_IDS].filter((id) => text.includes(id));
}

function isToolLikeExpression(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return TOOL_FIELD_NAMES.has(node.name.text);
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression ? stringLiteralValue(node.argumentExpression) : undefined;
    return !!key && TOOL_FIELD_NAMES.has(key);
  }
  if (ts.isIdentifier(node)) return TOOL_IDENTIFIER_NAMES.has(node.text);
  return false;
}

function comparisonAgentId(node: ts.BinaryExpression): string | undefined {
  const isEquality =
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEquality) return undefined;

  const leftLiteral = stringLiteralValue(node.left);
  const rightLiteral = stringLiteralValue(node.right);
  if (rightLiteral && AGENT_IDS.has(rightLiteral) && isToolLikeExpression(node.left)) return rightLiteral;
  if (leftLiteral && AGENT_IDS.has(leftLiteral) && isToolLikeExpression(node.right)) return leftLiteral;
  return undefined;
}

function scanFile(path: string): Finding[] {
  const text = readSource(path);
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, sourceKind(path));
  const findings: Finding[] = [];
  const objectDispatchTables = new Set<string>();

  function agentLiteralIds(nodes: readonly ts.Node[]): string[] {
    return nodes.map(stringLiteralValue).filter((value): value is string => !!value && AGENT_IDS.has(value));
  }

  function arrayAgentIds(node: ts.Expression): string[] {
    return ts.isArrayLiteralExpression(node) ? agentLiteralIds(node.elements) : [];
  }

  function addFinding(node: ts.Node, agentId: string, expression?: string): void {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({
      file: relative(ROOT, path),
      line: pos.line + 1,
      column: pos.character + 1,
      expression: expression ?? node.getText(sf),
      agentId,
      suggestedReplacement: 'Move this behavior behind AgentCapabilities/AttachMode, or into the owning adapter.',
    });
  }

  function objectLiteralAgentKeys(node: ts.ObjectLiteralExpression): string[] {
    const ids: string[] = [];
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop) && !ts.isMethodDeclaration(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
      const name = prop.name;
      const key =
        name && ts.isIdentifier(name) ? name.text :
        name && ts.isStringLiteralLike(name) ? name.text :
        undefined;
      if (key && AGENT_IDS.has(key)) ids.push(key);
    }
    return ids;
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      if (objectLiteralAgentKeys(node.initializer).length) objectDispatchTables.add(node.name.text);
    }

    if (ts.isBinaryExpression(node)) {
      const agentId = comparisonAgentId(node);
      if (agentId) addFinding(node, agentId);
    } else if (ts.isSwitchStatement(node) && isToolLikeExpression(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        const agentId = stringLiteralValue(clause.expression);
        if (agentId && AGENT_IDS.has(agentId)) addFinding(clause, agentId, `switch (${node.expression.getText(sf)}) case '${agentId}'`);
      }
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const firstArg = node.arguments[0];
      if (method === 'includes' && firstArg && isToolLikeExpression(firstArg) && ts.isArrayLiteralExpression(receiver)) {
        for (const agentId of arrayAgentIds(receiver)) addFinding(node, agentId);
      } else if (method === 'has' && firstArg && isToolLikeExpression(firstArg) && ts.isNewExpression(receiver)) {
        const setArg = receiver.arguments?.[0];
        if (receiver.expression.getText(sf) === 'Set' && setArg && ts.isArrayLiteralExpression(setArg)) {
          for (const agentId of arrayAgentIds(setArg)) addFinding(node, agentId);
        }
      } else if (method === 'test' && firstArg && isToolLikeExpression(firstArg)) {
        for (const agentId of regexLiteralAgentIds(receiver)) addFinding(node, agentId);
      }
    } else if (ts.isElementAccessExpression(node) && isToolLikeExpression(node.argumentExpression)) {
      const table = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
      if (table && objectDispatchTables.has(table)) addFinding(node, 'codex', node.getText(sf));
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return findings;
}

function renderMarkdown(findings: Finding[]): string {
  const lines = [
    '# Tool-name branch report',
    '',
    'Report-only check for direct agent-id behavior branches in shared broker/app/core code.',
    '',
    `Findings: ${findings.length}`,
    '',
  ];
  for (const f of findings) {
    lines.push(
      `## ${f.file}:${f.line}`,
      '',
      `- expression: \`${f.expression}\``,
      `- agent id: \`${f.agentId}\``,
      `- suggested replacement: ${f.suggestedReplacement}`,
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

const extraFiles = argValues('--include').map((path) => path.startsWith('/') ? path : join(ROOT, path));
const files = [...SCAN_ROOTS.flatMap(collectFiles), ...extraFiles];
const findings = files.flatMap(scanFile).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'tool-branches.json'), JSON.stringify({ schemaVersion: 1, scannedRoots: SCAN_ROOTS, findings }, null, 2));
writeFileSync(join(outDir, 'tool-branches.md'), renderMarkdown(findings));

console.log(`tool-branch report: ${findings.length} finding(s) -> ${relative(ROOT, outDir)}`);
