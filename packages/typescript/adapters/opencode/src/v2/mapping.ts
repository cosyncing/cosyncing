export { nativeMessageId as newNativeId } from '../native-id.ts';
import { ControlRefusedError, isOpaqueSessionId, type AgentMessage, type ModelOption, type SessionInfo } from '@cosyncing/adapter-api';
import { V2Error } from './transport.ts';

export type Native = Record<string, any>;
export const object = (value: unknown): value is Native => !!value && typeof value === 'object' && !Array.isArray(value);
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const nativeId = (value: unknown, prefix: string): value is string => typeof value === 'string' && value.startsWith(prefix) && isOpaqueSessionId(value);

/** Why an archived session is read-only here. OpenCode lists it again once it is restored. */
export const OPENCODE_ARCHIVED_REASON = 'This session is archived in OpenCode. Restore it there to continue.';

export function arrayData(value: unknown): Native[] {
  if (!object(value) || !Array.isArray(value.data) || !value.data.every(object)) throw new V2Error('invalid-response');
  return value.data;
}

export function isSession(value: unknown): value is Native {
  return object(value) && nativeId(value.id, 'ses') && object(value.location) && typeof value.location.directory === 'string'
    && object(value.time) && finite(value.time.created) && finite(value.time.updated)
    && (value.parentID === undefined || nativeId(value.parentID, 'ses'))
    && (value.model === undefined || (object(value.model) && typeof value.model.providerID === 'string' && typeof value.model.id === 'string'));
}

export function sessionInfo(value: Native, status: SessionInfo['status']): SessionInfo {
  if (!isSession(value)) throw new V2Error('invalid-response');
  return {
    id: value.id, nativeId: value.id, tool: 'opencode', title: typeof value.title === 'string' ? value.title : '',
    cwd: value.location.directory, status, attachMode: value.parentID ? 'observe' : 'live',
    ...(value.parentID ? { origin: 'subagent', parentThreadId: value.parentID } : {}),
    ...(value.model ? { model: value.model.id, currentModel: { providerID: value.model.providerID, modelID: value.model.id, ...(typeof value.model.variant === 'string' ? { variant: value.model.variant } : {}) } } : {}),
    ...(typeof value.agent === 'string' ? { currentAgent: value.agent } : {}),
    createdAt: value.time.created, updatedAt: value.time.updated,
    control: {
      drive: value.parentID ? { supported: false, state: 'observing', reason: 'This session is controlled by its parent agent.' } : { supported: true, state: 'driving' },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    },
  };
}

export function modelsFrom(value: unknown, providers: unknown, current?: SessionInfo['currentModel']): ModelOption[] {
  const names = new Map(arrayData(providers).filter((row) => typeof row.id === 'string').map((row) => [row.id, typeof row.name === 'string' ? row.name : row.id]));
  const result: ModelOption[] = [];
  for (const model of arrayData(value)) {
    if (model.enabled === false || typeof model.providerID !== 'string' || typeof model.id !== 'string') continue;
    result.push({
      providerID: model.providerID, providerLabel: names.get(model.providerID), modelID: model.id,
      label: typeof model.name === 'string' ? model.name : model.id,
      ...(Array.isArray(model.variants) ? { reasoningEfforts: model.variants.filter((v: any) => object(v) && typeof v.id === 'string').map((v: any) => ({ effort: v.id, label: v.id })) } : {}),
    });
  }
  if (current && !result.some((model) => model.providerID === current.providerID && model.modelID === current.modelID)) {
    result.push({ providerID: current.providerID, modelID: current.modelID, label: current.label || current.modelID });
  }
  return result;
}

export function permissionCard(value: Native): Extract<AgentMessage, { type: 'permission-request' }> {
  if (!nativeId(value.id, 'per_') || !nativeId(value.sessionID, 'ses') || typeof value.action !== 'string' || !Array.isArray(value.resources) || !value.resources.every((v: unknown) => typeof v === 'string')) throw new V2Error('invalid-response');
  return { type: 'permission-request', requestId: value.id, title: value.action, toolName: value.action, detail: value.resources.join('\n'), inputPreview: value.resources.join(', ').slice(0, 240) };
}

function visibleFields(form: Native): Native[] { return form.fields.filter((field: Native) => !field.hidden); }

export function formCard(form: Native): Extract<AgentMessage, { type: 'question-request' }> {
  if (!nativeId(form.id, 'frm_') || !nativeId(form.sessionID, 'ses') || !Array.isArray(form.fields) || !form.fields.length || !form.fields.every((field: unknown) => object(field) && typeof field.key === 'string' && typeof field.type === 'string')) throw new V2Error('invalid-response');
  const unsupported = form.fields.some((field: Native) =>
    !['string', 'multiselect', 'number', 'integer', 'boolean'].includes(field.type)
    || field.when !== undefined || field.pattern !== undefined || field.format !== undefined
    || (field.hidden && field.required && field.default === undefined)
    || (field.options !== undefined && (!Array.isArray(field.options) || !field.options.every((option: unknown) => object(option) && typeof option.value === 'string' && (option.label === undefined || typeof option.label === 'string')))));
  const fields = visibleFields(form);
  return {
    type: 'question-request', requestId: form.id,
    ...(unsupported ? { readOnly: true, answerInTerminal: true } : {}),
    questions: (fields.length ? fields : form.fields).map((field: Native) => ({
      question: typeof field.description === 'string' ? field.description : typeof field.title === 'string' ? field.title : field.key,
      header: typeof field.title === 'string' ? field.title : field.key,
      options: field.type === 'boolean' ? [{ label: 'true' }, { label: 'false' }]
        : Array.isArray(field.options) ? field.options.filter(object).map((option: Native) => ({ label: option.label ?? option.value, ...(typeof option.description === 'string' ? { description: option.description } : {}) })) : [],
      ...(field.type === 'multiselect' ? { multiple: true } : {}),
      ...(field.options || field.type === 'boolean' ? (field.custom === true ? {} : { freeText: false }) : {}),
      ...(field.type === 'string' && !field.options ? { kind: 'text' as const } : {}),
      ...(['number', 'integer'].includes(field.type) ? { kind: 'number' as const, ...(finite(field.min) ? { min: field.min } : {}), ...(finite(field.max) ? { max: field.max } : {}), ...(field.type === 'integer' ? { step: 1 } : {}) } : {}),
    })),
  };
}

export function formAnswer(form: Native, answers: string[][]): Record<string, unknown> {
  if (formCard(form).readOnly) throw new ControlRefusedError('Answer this form in the OpenCode terminal.', 'command-unsupported');
  const fields = visibleFields(form);
  if (answers.length !== fields.length) throw new Error('Answer every form field.');
  const result: Record<string, unknown> = Object.create(null);
  for (const field of form.fields as Native[]) if (field.hidden && field.default !== undefined) result[field.key] = field.default;
  fields.forEach((field, index) => {
    const selected = answers[index]!;
    if (!Array.isArray(selected) || !selected.every((value) => typeof value === 'string')) throw new Error('Invalid form answer.');
    if (field.required === true && (!selected.length || selected.every((value) => !value.trim()))) throw new Error('Answer every required form field.');
    if (!selected.length && field.required !== true) return;
    const mapChoice = (value: string): string => {
      const matches = (field.options ?? []).filter((option: Native) => (option.label ?? option.value) === value);
      if (matches.length > 1) throw new Error('This choice is ambiguous; answer in the OpenCode terminal.');
      if (matches.length === 1) return matches[0].value;
      if (field.options && field.custom !== true) throw new Error('Choose one of the offered answers.');
      return value;
    };
    if (field.type === 'multiselect') { result[field.key] = selected.map(mapChoice); return; }
    if (selected.length !== 1) throw new Error('Choose exactly one answer for this field.');
    const text = selected[0]!;
    if (field.type === 'boolean') {
      if (text !== 'true' && text !== 'false') throw new Error('Choose true or false.');
      result[field.key] = text === 'true';
    } else if (field.type === 'number' || field.type === 'integer') {
      const number = Number(text);
      if (!text.trim() || !Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number)) || (finite(field.min) && number < field.min) || (finite(field.max) && number > field.max)) throw new Error('Enter a number within the form limits.');
      result[field.key] = number;
    } else {
      if ((finite(field.minLength) && text.length < field.minLength) || (finite(field.maxLength) && text.length > field.maxLength)) throw new Error('The answer does not meet the form length limits.');
      result[field.key] = mapChoice(text);
    }
  });
  return result;
}

export const contentKey = (id: string, ordinal: number): string => `${id}:${ordinal}`;

/** Keep attachment metadata and image count without retaining hydrated base64. */
export function compactAttachments(value: Native): Native {
  if (!Array.isArray(value.files)) return value;
  const imageCount = value.files.filter((file: Native) => typeof file?.data === 'string' && typeof file.mime === 'string' && file.mime.startsWith('image/') && object(file.source) && ['uri', 'inline'].includes(file.source.type)).length;
  return { ...value, imageCount, files: value.files.filter(object).map(({ data: _data, ...file }: Native) => file) };
}

export function toolMessages(tool: Native): AgentMessage[] {
  if (typeof tool.id !== 'string' || typeof tool.name !== 'string') return [];
  const state = object(tool.state) ? tool.state : {};
  const complete = state.status === 'completed' || state.status === 'error';
  const metadata = object(state.metadata) ? state.metadata : {};
  const result = Array.isArray(state.content) ? state.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') : typeof state.error === 'string' ? state.error : undefined;
  return [
    { type: 'tool-call', callId: tool.id, toolName: tool.name, args: state.input, historySlot: true },
    { type: 'tool-result', callId: tool.id, toolName: tool.name, historySlot: true, ...(!complete ? { pending: true } : { result, isError: state.status === 'error' }), ...(finite(metadata.exit) ? { exitCode: metadata.exit } : {}), ...(typeof metadata.truncated === 'boolean' ? { truncated: metadata.truncated } : {}), ...(finite(tool.time?.completed) && finite(tool.time?.ran) ? { durationMs: Math.max(0, tool.time.completed - tool.time.ran) } : {}) },
  ];
}

export function messageRows(message: Native, clientKeys: ReadonlyMap<string, string>): AgentMessage[] {
  if (!nativeId(message.id, 'msg_') || !object(message.time) || !finite(message.time.created)) return [];
  if (message.type === 'user' && typeof message.text === 'string') {
    const clientKey = clientKeys.get(message.id);
    const imageCount = finite(message.imageCount) ? message.imageCount : compactAttachments(message).imageCount ?? 0;
    return [{ type: 'user-message', key: message.id, text: message.text, turnId: message.id, sentAt: message.time.created, ...(imageCount ? { imageCount } : {}), ...(clientKey ? { clientKey } : {}) }];
  }
  if (message.type === 'compaction' && message.status === 'completed' && typeof message.summary === 'string') return [{ type: 'model-output', key: `${message.id}:compaction`, text: message.summary, final: true }];
  if (message.type !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part: Native, ordinal: number): AgentMessage[] => {
    if (!object(part)) return [];
    if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') return [{ type: part.type === 'text' ? 'model-output' : 'thinking', key: contentKey(message.id, ordinal), text: part.text, ...(part.type === 'text' && finite(message.time.completed) ? { final: true } : {}) }];
    return part.type === 'tool' ? toolMessages(part) : [];
  });
}

/** `fromUser` is false for an execution OpenCode started itself (a background subagent or shell
 *  report, a staged revert): its key names that input, which has no user row to attach to. */
export function runSummary(key: string, status: 'running' | 'done' | 'error' | 'cancelled', startedAt?: number, completedAt?: number, assistant?: Native, fromUser = key.startsWith('msg_')): Extract<AgentMessage, { type: 'run-summary' }> {
  const tokens = assistant?.tokens;
  return { type: 'run-summary', key: `opencode-v2:run:${key}`, turnId: key, userMessageKey: fromUser ? key : undefined, status, startedAt, completedAt,
    ...(finite(startedAt) && finite(completedAt) ? { totalRuntimeMs: Math.max(0, completedAt - startedAt) } : {}),
    ...(object(tokens) ? { tokens: { ...(finite(tokens.input) ? { input: tokens.input } : {}), ...(finite(tokens.output) ? { output: tokens.output } : {}), ...(finite(tokens.cache?.read) ? { cacheRead: tokens.cache.read } : {}), ...(finite(tokens.cache?.write) ? { cacheWrite: tokens.cache.write } : {}), ...(finite(assistant?.cost) ? { cost: assistant.cost } : {}) } } : {}), source: 'opencode' };
}

/** What starts an execution: a user prompt, or (2.3.x) the `synthetic` report OpenCode queues when a
 *  background subagent goes idle or a background shell exits. The synthetic report is not shown
 *  as a row; it only names the execution it starts. */
export function isRunInput(message: Native): boolean {
  return (message.type === 'user' || message.type === 'synthetic') && nativeId(message.id, 'msg_');
}

export function historyRows(messages: Native[], clientKeys: ReadonlyMap<string, string>): AgentMessage[] {
  const result: AgentMessage[] = [];
  let input: Native | undefined;
  let assistant: Native | undefined;
  for (const message of messages) {
    if (isRunInput(message) && !input) input = message;
    if (message.type === 'assistant') assistant = message;
    result.push(...messageRows(message, clientKeys));
    if (message.type === 'idle' && ['succeeded', 'failed', 'interrupted'].includes(message.outcome) && nativeId(message.id, 'msg_')) {
      result.push(runSummary(input?.id ?? message.id, message.outcome === 'succeeded' ? 'done' : message.outcome === 'interrupted' ? 'cancelled' : 'error', input?.time?.created ?? assistant?.time?.created, message.time?.created, assistant, input?.type === 'user'));
      input = undefined; assistant = undefined;
    }
  }
  return result;
}

/** Only these native projections are mutable through the broker's sessionInfo patch surface. */
export function sessionPatch(info: SessionInfo): Partial<SessionInfo> {
  return { title: info.title, status: info.status, attachMode: info.attachMode,
    model: info.model, currentModel: info.currentModel, currentAgent: info.currentAgent,
    updatedAt: info.updatedAt, control: info.control, terminalSyncHint: info.terminalSyncHint };
}
