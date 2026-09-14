#!/usr/bin/env bun
export {};
import { mapKiloPart, validateKiloPart } from '../src/mapping.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const text = mapKiloPart({ id: 'p1', type: 'text', text: 'answer' })[0];
const thought = mapKiloPart({ id: 'p2', type: 'reasoning', text: 'thought' })[0];
check('text and reasoning retain provider-issued part identity',
  text?.type === 'model-output' && text.key === 'p1'
    && thought?.type === 'thinking' && thought.key === 'p2');

const tool = mapKiloPart({
  id: 'p3', type: 'tool', callID: 'call-1', tool: 'read',
  state: { status: 'completed', input: { filePath: 'src/a.ts' }, output: 'ok' },
});
check('a synthetic shared-lineage tool shape preserves canonical read semantics without claiming Kilo capture',
  tool[0]?.type === 'tool-result'
    && tool[0].semantic?.kind === 'file-read'
    && tool[0].semantic.path === 'src/a.ts',
  JSON.stringify(tool));

check('measured step boundary parts remain non-rendering lifecycle records',
  mapKiloPart({ type: 'step-start' }).length === 0 && mapKiloPart({ type: 'step-finish' }).length === 0);

check('empty measured content parts remain non-rendering instead of becoming unknown context',
  mapKiloPart({ id: 'empty-text', type: 'text', text: '' }).length === 0
    && mapKiloPart({ id: 'empty-reasoning', type: 'reasoning', text: '' }).length === 0);

check('malformed nested tool fields fail the Kilo storage validator before shared mapping',
  !validateKiloPart({
    id: 'bad-tool', type: 'tool', tool: 'bash',
    state: { status: 'completed', input: { command: { bad: true } }, output: 'ok', metadata: {} },
  }));

const traces: string[] = [];
const unknown = mapKiloPart({ type: 'future-kilo-part', secret: 'withheld' }, true,
  (event) => traces.push(`${event.op}:${event.detail}`));
check('unknown parts become named neutral context and trace, never human text',
  unknown[0]?.type === 'event' && traces.some((trace) => trace.startsWith('unknown-part:')),
  JSON.stringify({ unknown, traces }));

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
