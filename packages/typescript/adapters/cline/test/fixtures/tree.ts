import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClineNativeMessage } from '../../src/store.ts';

export const CLINE_FIXTURE_ID = '1787424308272_2eapl';
export const CLINE_FIXTURE_CHILD_SUFFIX = 'agent_1787424313729_lbwhkj';
export const CLINE_FIXTURE_CHILD_ID = `${CLINE_FIXTURE_ID}__${CLINE_FIXTURE_CHILD_SUFFIX}`;

export function fixtureParentMessages(): ClineNativeMessage[] {
  return [
    { id: 'msg-user-1', role: 'user', ts: '2026-08-23T10:00:00.000Z', content: [{ type: 'text', text: 'fixture prompt' }] },
    {
      id: 'msg-assistant-1',
      role: 'assistant',
      ts: '2026-08-23T10:00:01.000Z',
      modelInfo: { id: 'claude-sonnet-4-20250514', provider: 'anthropic' },
      metrics: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10 },
      content: [
        { type: 'thinking', thinking: 'fixture thought' },
        { type: 'text', text: 'fixture answer' },
        { type: 'tool_use', id: 'call-spawn', name: 'spawn_agent', input: { task: 'Inspect fixture', systemPrompt: 'fixture' } },
      ],
    },
    {
      id: 'msg-tool-1',
      role: 'user',
      ts: '2026-08-23T10:00:02.000Z',
      content: [{ type: 'tool_result', tool_use_id: 'call-spawn', name: 'spawn_agent', content: 'done' }],
    },
    { id: 'msg-assistant-2', role: 'assistant', ts: '2026-08-23T10:00:03.000Z', content: [{ type: 'text', text: 'fixture final' }] },
  ];
}

export function fixtureChildMessages(): ClineNativeMessage[] {
  return [
    { id: 'child-user-1', role: 'user', content: [{ type: 'text', text: 'child prompt' }] },
    {
      id: 'child-assistant-1',
      role: 'assistant',
      modelInfo: { id: 'qwen3.8-27B-FP8', provider: 'openai-compatible' },
      content: [{ type: 'text', text: 'child answer' }],
    },
  ];
}

export interface ClineFixtureTree {
  root: string;
  dataRoot: string;
  cwd: string;
  id: string;
  childId: string;
  sessionDir: string;
  metadataPath: string;
  messagesPath: string;
  childPath: string;
  parentMessages: ClineNativeMessage[];
  writeMetadata(overrides?: Record<string, unknown>): void;
  writeParent(messages: ClineNativeMessage[], updatedAt?: string, overrides?: Record<string, unknown>): void;
  writeChild(messages: ClineNativeMessage[], overrides?: Record<string, unknown>): void;
  cleanup(): void;
}

export function buildClineFixtureTree(): ClineFixtureTree {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-cline-tree-'));
  const dataRoot = join(root, 'data');
  const cwd = join(root, 'workspace');
  const id = CLINE_FIXTURE_ID;
  const childId = CLINE_FIXTURE_CHILD_ID;
  const sessionDir = join(dataRoot, 'sessions', id);
  const metadataPath = join(sessionDir, `${id}.json`);
  const messagesPath = join(sessionDir, `${id}.messages.json`);
  const childPath = join(sessionDir, `${CLINE_FIXTURE_CHILD_SUFFIX}.messages.json`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const parentMessages = fixtureParentMessages();
  const tree: ClineFixtureTree = {
    root,
    dataRoot,
    cwd,
    id,
    childId,
    sessionDir,
    metadataPath,
    messagesPath,
    childPath,
    parentMessages,
    writeMetadata(overrides = {}) {
      writeFileSync(metadataPath, `${JSON.stringify({
        session_id: id,
        cwd,
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        started_at: '2026-08-23T10:00:00.000Z',
        status: 'running',
        pid: 424242,
        metadata: {
          title: 'Cline fixture',
          aggregateUsage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 40,
            cacheWriteTokens: 10,
            totalCost: 0.02,
          },
        },
        ...overrides,
      })}\n`);
    },
    writeParent(messages, updatedAt = '2026-08-23T10:00:03.000Z', overrides = {}) {
      writeFileSync(messagesPath, `${JSON.stringify({
        version: 1,
        agent: 'lead',
        sessionId: id,
        origin: {
          source: 'cli',
          mode: 'user',
          sessionId: id,
          version: '3.0.60',
        },
        updated_at: updatedAt,
        messages,
        ...overrides,
      })}\n`);
    },
    writeChild(messages, overrides = {}) {
      writeFileSync(childPath, `${JSON.stringify({
        version: 1,
        agent: 'subagent',
        taskType: 'subagent_task',
        sessionId: childId,
        updated_at: '2026-08-23T10:00:05.000Z',
        origin: {
          version: '3.0.60',
          source: 'cli',
          mode: 'subagent',
          sessionId: childId,
          parentThreadId: id,
          subagent: CLINE_FIXTURE_CHILD_SUFFIX,
        },
        messages,
        ...overrides,
      })}\n`);
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
  tree.writeMetadata();
  tree.writeParent(parentMessages);
  tree.writeChild(fixtureChildMessages());
  writeFileSync(join(dataRoot, 'sessions.db'), 'not authoritative');
  return tree;
}
