import { basename } from 'node:path';
import type {
  AgentMessage,
  FileChange,
  ToolCommandState,
  ToolDisplayClass,
  ToolSearchGroup,
  ToolSemantic,
} from '@cosyncing/adapter-api';
import {
  boundToolSemantic,
  boundedStream,
  commandSemantic,
  fileReadSemantic,
  searchGroup,
  searchSemantic,
  splitUnifiedDiffFiles,
  webSemantic,
} from '@cosyncing/adapter-api';

export interface OpenCodePartMapOptions {
  historical?: boolean;
  productId?: string;
}

export function parseOpenCodeJsonObject(value: unknown): any | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return undefined; }
}

export function openCodePartTime(part: any): number | undefined {
  return Number(part?.timeUpdated ?? part?.time?.end ?? part?.time?.updated
    ?? part?.time?.created ?? part?.timeCreated) || undefined;
}

/**
 * Whether a text part has reached its terminal timestamp.
 *
 * `time.end` ONLY. `timeUpdated` looks like a fallback and is not one: six lines
 * above, `openCodePartTime` uses it as a LAST-TOUCHED stamp, and `sqlite.ts`
 * fills it from the `part.time_updated` column — a row-mutation time that a
 * still-streaming assistant part carries. Accepting it marked partial text
 * `final`, and `_withCarriedFinality` on the client makes that permanent: the
 * turn could never again be read aloud or copied in full. The measurement
 * behind this — 138/138 assistant text parts complete, 148/148 user parts not —
 * is a measurement of `time.end`, so `time.end` is what it licenses.
 */
function openCodePartComplete(part: any): boolean {
  return Number(part?.time?.end ?? 0) > 0;
}

function elapsedMs(part: any): number | undefined {
  const start = Number(part?.time?.start ?? part?.timeCreated ?? 0);
  const end = Number(part?.time?.end ?? part?.timeUpdated ?? 0);
  return start && end && end >= start ? end - start : undefined;
}

function todoState(part: any, productId: string): AgentMessage | undefined {
  const state = part?.state;
  const output = state?.output;
  let todos = Array.isArray(state?.input?.todos) ? state.input.todos
    : Array.isArray(state?.metadata?.todos) ? state.metadata.todos
      : Array.isArray(output) ? output : undefined;
  if (!todos && typeof output === 'string' && output.trim()) {
    const parsed = parseOpenCodeJsonObject(output);
    todos = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.todos) ? parsed.todos : undefined;
  }
  if (!todos?.length) return undefined;
  const items: Array<{
    id: string;
    title: string;
    status: 'open' | 'in-progress' | 'done' | 'cancelled';
    priority?: 'low' | 'normal' | 'high';
  }> = todos.flatMap((todo: any, index: number) => {
    const title = String(todo?.content ?? todo?.title ?? '').trim();
    if (!title) return [];
    const rawStatus = String(todo?.status ?? '').toLowerCase().replace(/[_\s-]+/g, '-');
    const status = ['completed', 'complete', 'done'].includes(rawStatus) ? 'done' as const
      : ['in-progress', 'running', 'active'].includes(rawStatus) ? 'in-progress' as const
        : ['cancelled', 'canceled'].includes(rawStatus) ? 'cancelled' as const : 'open' as const;
    const rawPriority = String(todo?.priority ?? '').toLowerCase();
    const priority = rawPriority === 'low' || rawPriority === 'high' ? rawPriority
      : rawPriority === 'medium' || rawPriority === 'normal' ? 'normal' as const : undefined;
    return [{ id: todo?.id != null ? String(todo.id) : String(index), title, status, ...(priority ? { priority } : {}) }];
  });
  if (!items.length) return undefined;
  return {
    type: 'task-list-state',
    key: `${productId}:todo:${part.sessionID ?? 'current'}`,
    title: 'Tasks',
    status: items.every((item) => item.status === 'done' || item.status === 'cancelled') ? 'done' : 'running',
    source: 'tool-call',
    sourceTool: 'todowrite',
    updatedAt: openCodePartTime(part),
    items,
  };
}

function firstLine(value: unknown): string | undefined {
  return String(value ?? '').split('\n').find((line) => line.trim())?.trim();
}

function taskActivity(part: any, historical: boolean): AgentMessage | undefined {
  if (historical) return undefined;
  const state = part?.state ?? {};
  const status = String(state.status ?? 'pending');
  if (!['running', 'completed', 'error'].includes(status)) return undefined;
  const input = state.input ?? {};
  return {
    type: 'agent-activity',
    key: `agent:${part.callID ?? part.id}`,
    kind: 'subagent',
    title: String(input.description ?? firstLine(input.prompt) ?? 'Subagent task').trim(),
    ...(input.subagent_type ? { subtitle: String(input.subagent_type) } : {}),
    status: status === 'completed' ? 'done' : status === 'error' ? 'error' : 'running',
    elapsedMs: elapsedMs(part),
    agentsDone: status === 'running' ? 0 : 1,
    agentsTotal: 1,
  };
}

function family(tool: string): 'command' | 'file-read' | 'search' | 'web' | null {
  if (tool === 'bash' || tool === 'interactive_bash') return 'command';
  if (tool === 'read') return 'file-read';
  if (['grep', 'glob', 'list'].includes(tool)) return 'search';
  if (['webfetch', 'websearch', 'google_search'].includes(tool)) return 'web';
  return null;
}

function semantic(tool: string, input: any, state: any, status: string): ToolSemantic | undefined {
  const kind = family(tool);
  if (!kind) return undefined;
  const args = input && typeof input === 'object' ? input : {};
  const md = state?.metadata && typeof state.metadata === 'object' ? state.metadata : {};
  const terminal = status === 'completed' || status === 'error';
  if (kind === 'command') {
    const exit = md.exit != null ? Number(md.exit) : undefined;
    const commandState: ToolCommandState = !terminal ? 'running'
      : md.aborted === true ? 'interrupted'
        : exit !== undefined && Number.isFinite(exit) ? (exit === 0 ? 'completed' : 'failed')
          : status === 'error' ? 'failed' : 'unknown';
    return boundToolSemantic(commandSemantic({
      command: args.command, cwd: args.cwd ?? md.cwd, state: commandState,
      stdout: boundedStream(md.stdout), stderr: boundedStream(md.stderr),
    }));
  }
  if (kind === 'file-read') return boundToolSemantic(fileReadSemantic({
    path: args.filePath ?? md.filepath,
    startLine: typeof args.offset === 'number' ? args.offset + 1 : undefined,
    preview: terminal ? (md.preview ?? state?.output) : undefined,
    totalLines: md.totalLines ?? md.lines,
    previewTruncated: md.truncated === true,
  }));
  if (kind === 'search') {
    const files = Array.isArray(md.files) ? md.files : Array.isArray(md.filenames) ? md.filenames : [];
    const groups: Array<ToolSearchGroup | undefined> = files.map((file: any) => typeof file === 'string'
      ? searchGroup({ path: file })
      : searchGroup({ path: file?.path, matchCount: file?.count, matches: file?.matches }));
    return boundToolSemantic(searchSemantic({
      query: args.pattern ?? args.query, scope: args.path ?? args.glob ?? args.include,
      matchCount: md.matches, fileCount: md.count ?? (files.length || undefined), groups,
    }));
  }
  return boundToolSemantic(webSemantic({
    query: args.query, url: args.url,
    results: Array.isArray(md.results) ? md.results : undefined,
  }));
}

function displayClass(tool: string): ToolDisplayClass {
  const name = String(tool || '').toLowerCase();
  if (/^(bash|shell|exec|interactive_bash|background_task)$/.test(name)) return 'execute';
  if (/(^|[_-])(edit|write|patch|create|delete|move|rename)([_-]|$)/.test(name)) return 'edit';
  if (/^(read|grep|glob|list|ls|webfetch|websearch|google_search|look_at|todoread|codesearch)$/.test(name)
    || /(^|[_-])(read|grep|glob|search|fetch|list|query|diagnostic|symbols)([_-]|$)/.test(name)
    || /directory_tree/.test(name)) return 'lookup';
  return 'other';
}

function summary(tool: string, input: any, md: any, error: boolean): string {
  const base = (path?: string) => path ? basename(path) || path : '';
  switch (tool) {
    case 'edit': case 'apply_patch': return `Edited ${base(input?.filePath ?? md?.filepath)}`;
    case 'write': return `${md?.exists ? 'Edited' : 'Created'} ${base(input?.filePath ?? md?.filepath)}`;
    case 'read': return `Read ${base(input?.filePath)}`;
    case 'bash': return input?.description || input?.command || 'Ran command';
    case 'glob': return md?.count != null ? `Found ${md.count} file${md.count === 1 ? '' : 's'}` : `Glob ${input?.pattern ?? ''}`;
    case 'grep': return md?.matches != null ? `${md.matches} match${md.matches === 1 ? '' : 'es'} for "${input?.pattern ?? ''}"` : `Grep "${input?.pattern ?? ''}"`;
    case 'list': return `Listed ${base(input?.path) || 'directory'}`;
    case 'webfetch': return `Fetched ${input?.url ?? ''}`;
    case 'websearch': case 'google_search': return `Searched "${input?.query ?? ''}"`;
    case 'task': return `${input?.subagent_type ?? 'subagent'}: ${input?.description ?? ''}`.trim();
    case 'todowrite': return Array.isArray(input?.todos) ? `${input.todos.length} todo${input.todos.length === 1 ? '' : 's'}` : 'Updated todos';
    default: return error ? `${tool} failed` : tool;
  }
}

export function mapOpenCodePart(
  value: unknown,
  options: OpenCodePartMapOptions = {},
): AgentMessage[] {
  const part: any = value;
  if (!part || typeof part !== 'object') return [];
  const historical = options.historical ?? true;
  const productId = options.productId ?? 'opencode';
  // `final` is MEASURED, not assumed. It was hard-coded false, and the client
  // gates `readAloudSourceText` on `final === true` while `_modelTextAggregate`
  // skips non-final segments — so read-aloud and copy-turn-text were dead on
  // every OpenCode and Kilo session. `time.end` is the completion signal the
  // store actually carries: across 400 consecutive kilo text parts, 138/138
  // assistant parts had it and 148/148 user parts had none, and a part still
  // streaming has `time.start` alone. So a partial answer stays false, which is
  // what matters — `_withCarriedFinality` makes a wrong `true` permanent.
  if (part.type === 'text') {
    return part.text
      ? [{ type: 'model-output', text: part.text, key: part.id, final: openCodePartComplete(part) }]
      : [];
  }
  if (part.type === 'reasoning') return part.text ? [{ type: 'thinking', text: part.text, key: part.id }] : [];
  if (part.type === 'file') return [{
    type: 'file-artifact', path: part.filename ?? part.url ?? part.id,
    name: part.filename ?? 'file', mimeType: part.mime ?? 'application/octet-stream', url: part.url,
  }];
  if (part.type !== 'tool') return [];
  const state = part.state ?? {};
  const status = String(state.status ?? 'pending');
  const tool = String(part.tool ?? 'tool');
  const callId = part.callID ?? part.id;
  const input = state.input ?? {};
  if (tool === 'question') return [];
  if (tool === 'todowrite') {
    const taskList = todoState(part, productId);
    return taskList ? [taskList] : [];
  }
  const activity = tool === 'task' ? taskActivity(part, historical) : undefined;
  const toolSemantic = semantic(tool, input, state, status);
  if (status !== 'completed' && status !== 'error') return [
    ...(activity ? [activity] : []),
    {
      type: 'tool-call', callId, toolName: tool, toolClass: displayClass(tool),
      ...(toolSemantic ? { semantic: toolSemantic } : {}),
      title: state.title ?? summary(tool, input, {}, false), args: input,
    },
  ];
  const md = state.metadata ?? {};
  const fd = md.filediff ?? {};
  const path: string | undefined = input.filePath ?? md.filepath ?? fd.file;
  const exitCode = tool === 'bash' && md.exit != null ? Number(md.exit) : undefined;
  const diff: string | undefined = md.diff ?? fd.patch;
  let fileChanges: FileChange[] | undefined;
  if (typeof diff === 'string' && diff) {
    const changes = splitUnifiedDiffFiles(diff);
    if (changes.length) fileChanges = changes.map((change) => change.path ? change : { ...change, path: path ?? '' });
    else if (path) fileChanges = [{ path, operation: 'edit', diff, additions: fd.additions, deletions: fd.deletions }];
  }
  return [
    ...(activity ? [activity] : []),
    {
      type: 'tool-result', callId, toolName: tool, toolClass: displayClass(tool),
      ...(toolSemantic ? { semantic: toolSemantic } : {}),
      isError: status === 'error' || (exitCode != null && exitCode !== 0),
      result: tool === 'bash' ? (md.output ?? state.output) : (state.output ?? state.error),
      title: summary(tool, input, md, status === 'error'), path, diff, fileChanges,
      additions: fd.additions, deletions: fd.deletions, exitCode,
      truncated: md.truncated || undefined, durationMs: elapsedMs(part),
    },
  ];
}
