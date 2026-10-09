// The mod's own tests, run by `claude plugin test mods/cosyncing-claude`.
//
// The harness gives a real `$` and the plugin's real hooks, but no network: `$.http`
// is absent there. So this file covers the decisions the mod can get wrong on its own,
// the ones no broker-side suite can see: the answer shape it may return for
// AskUserQuestion, the input summary it puts on a card, and how it finds the socket.

import { expect, test } from 'claude-code/testing';
import { briefInput, fullInput, resolveSocketPath, splitLabels, steerRoute, validateAnswers, withoutPreviews } from './register.js';

const ONE = {
  question: 'Which report should I send?',
  header: 'Report',
  multiSelect: false,
  options: [
    { label: 'Weekly', description: 'The weekly rollup.' },
    { label: 'Monthly', description: 'The monthly rollup.' },
  ],
};

test('a label answer validates', () => {
  expect(validateAnswers([ONE], { [ONE.question]: 'Weekly' })).toBe(true);
});

// Measured against the build's own dialog, not against a preference: `$.ui.ask` resolves a
// choice to "the label chosen, the chosen labels comma-joined, or free text typed under
// 'Other'". A free-text answer is therefore a legitimate answer to a single choice, and the
// mod returns it rather than throwing the human's own answer back. Which call an answer
// belongs to is carried by the hold it came back on, not by the label matching a list.
test("a free-text answer to one choice is the engine's own 'Other'", () => {
  expect(validateAnswers([ONE], { [ONE.question]: 'Whatever you think' })).toBe(true);
});

// The guard that survives the relaxation: a multi-select answer is comma-joined labels, so a
// part that is not an option means the answer came from somewhere else, and handing that to
// the tool would put words in the human's mouth.
test('a multi-select part that is not an option is refused', () => {
  const many = { ...ONE, multiSelect: true };
  expect(validateAnswers([many], { [many.question]: 'Weekly, Invented' })).toBe(false);
  expect(validateAnswers([many], { [many.question]: 'Weekly, Monthly' })).toBe(true);
});

// Written the way Claude's own number control writes one: digits, an optional minus and an optional
// fraction. Anything else is not an answer that control could have given.
test('a number answer is a plain number inside the question range', () => {
  const howMany = { question: 'How many rows?', header: 'Rows', kind: 'number', min: 1, max: 10 };
  expect(validateAnswers([howMany], { [howMany.question]: '5' })).toBe(true);
  expect(validateAnswers([howMany], { [howMany.question]: '5.5' })).toBe(true);
  expect(validateAnswers([howMany], { [howMany.question]: '10' })).toBe(true);
  expect(validateAnswers([howMany], { [howMany.question]: '50' })).toBe(false);
  expect(validateAnswers([howMany], { [howMany.question]: 'ten' })).toBe(false);
  for (const unplain of ['1e1', '+5', ' 5', '5.', '.5', '0x5']) {
    expect(validateAnswers([howMany], { [howMany.question]: unplain })).toBe(false);
  }
});

// B1: the mod has to find the socket the broker binds without being told, and must never hand
// `$.http.fetch` an empty one -- with `socketPath: ''` the URL becomes real and the request
// leaves over TCP to whatever answers cosyncing.local.
test('the socket path resolves in the broker order, and never as a relative path', () => {
  expect(resolveSocketPath({ override: '/tmp/other.sock', stamped: '/run/a.sock', cosyncingHome: '/h/.cs', home: '/h' }))
    .toBe('/tmp/other.sock');
  expect(resolveSocketPath({ stamped: '/run/a.sock', cosyncingHome: '/h/.cs', home: '/h' })).toBe('/run/a.sock');
  expect(resolveSocketPath({ cosyncingHome: '/srv/cosyncing', home: '/h' })).toBe('/srv/cosyncing/claude-mod.sock');
  expect(resolveSocketPath({ cosyncingHome: '/srv/cosyncing/', home: '/h' })).toBe('/srv/cosyncing/claude-mod.sock');
  expect(resolveSocketPath({ home: '/h' })).toBe('/h/.cosyncing/claude-mod.sock');
  // Nothing absolute anywhere: no sync, and nothing that could reach the network.
  expect(resolveSocketPath({ override: 'relative.sock', stamped: '', cosyncingHome: 'x', home: 'y' })).toBe('');
  expect(resolveSocketPath({})).toBe('');
});

test('the key must be the question text, not the header', () => {
  expect(validateAnswers([ONE], { [ONE.header]: 'Weekly' })).toBe(false);
});

test('one answer per question, no more and no less', () => {
  const two = { ...ONE, question: 'And the format?' };
  expect(validateAnswers([ONE, two], { [ONE.question]: 'Weekly' })).toBe(false);
  expect(validateAnswers([ONE, two], { [ONE.question]: 'Weekly', [two.question]: 'Monthly' })).toBe(true);
});

test('a multi-select answer is comma-joined labels', () => {
  const many = { ...ONE, multiSelect: true };
  expect(validateAnswers([many], { [many.question]: 'Weekly, Monthly' })).toBe(true);
  expect(validateAnswers([many], { [many.question]: 'Weekly, Nonsense' })).toBe(false);
  expect(validateAnswers([many], { [many.question]: 'Weekly, Weekly' })).toBe(false);
});

// The answers Claude 2.1.292's own picker wrote in a probe on 2026-10-06, copied from the tool
// results in its transcripts: a label holding ", " or a double quote is written as a JSON string.
const MEASURED = [
  { labels: ['Paris, France', 'Austin, Texas', 'Tokyo'], answer: '"Paris, France", Tokyo', picked: ['Paris, France', 'Tokyo'] },
  { labels: ['Say "hi", now', 'Tokyo', 'Quote " only'], answer: '"Say \\"hi\\", now", Tokyo, "Quote \\" only"', picked: ['Say "hi", now', 'Tokyo', 'Quote " only'] },
  { labels: ['C:\\temp', 'Tokyo', 'x y'], answer: 'C:\\temp, Tokyo, x y', picked: ['C:\\temp', 'Tokyo', 'x y'] },
];

test("a multi-select answer is read back the way Claude's own picker wrote it", () => {
  for (const { labels, answer, picked } of MEASURED) {
    expect(splitLabels(answer)).toEqual(picked);
    const question = { question: 'Which?', header: 'Which', multiSelect: true, options: labels.map((label) => ({ label })) };
    expect(validateAnswers([question], { 'Which?': answer })).toBe(true);
  }
});

test('a comma inside a label keeps it one label, and only in the form the picker writes', () => {
  const sizes = { question: 'Which sizes?', header: 'Sizes', multiSelect: true, options: [{ label: 'Small, cheap' }, { label: 'Large' }] };
  expect(validateAnswers([sizes], { [sizes.question]: '"Small, cheap", Large' })).toBe(true);
  expect(validateAnswers([sizes], { [sizes.question]: 'Small, cheap, Large' })).toBe(false);
  for (const broken of ['"Small, cheap', '"Small, cheap"Large', 'Large, ', 'La"rge']) {
    expect(splitLabels(broken)).toBe(null);
  }
});

// Claude's own admission limit for an answer a hook returns. A longer one would be refused there and
// the person handed the picker after the app had said Sent.
test("an answer may be as long as Claude takes from a hook, and no longer", () => {
  const free = { question: 'Anything else?', header: 'Note', kind: 'text' };
  expect(validateAnswers([free], { [free.question]: 'x'.repeat(8192) })).toBe(true);
  expect(validateAnswers([free], { [free.question]: 'x'.repeat(8193) })).toBe(false);
});

test("an option's preview is left out of what the broker is sent, and the tool's questions are untouched", () => {
  const layout = { question: 'Which layout?', header: 'Layout', multiSelect: false,
    options: [{ label: 'Grid', description: 'Cells', preview: '<div>grid</div>' }, { label: 'List' }] };
  const sent = withoutPreviews([layout]);
  expect(sent).toEqual([{ ...layout, options: [{ label: 'Grid', description: 'Cells' }, { label: 'List' }] }]);
  expect(layout.options[0]!.preview).toBe('<div>grid</div>');
  const text = { question: 'Name?', header: 'Name', kind: 'text' };
  expect(withoutPreviews([text])[0]).toBe(text);
});

test('a free-text question takes any non-empty string', () => {
  const free = { question: 'Anything else?', header: 'Note', multiSelect: false, kind: 'text' as const, options: [] };
  expect(validateAnswers([free], { [free.question]: 'yes, please' })).toBe(true);
  expect(validateAnswers([free], { [free.question]: '' })).toBe(false);
});

test('garbage shapes are refused rather than thrown on', () => {
  expect(validateAnswers([], {})).toBe(false);
  expect(validateAnswers(ONE as unknown as unknown[], {})).toBe(false);
  expect(validateAnswers([ONE], 'Weekly' as unknown as Record<string, string>)).toBe(false);
  expect(validateAnswers([ONE], { [ONE.question]: 7 as unknown as string })).toBe(false);
});

test('the input summary names one field and stays short', () => {
  expect(briefInput({ command: 'ls -la' })).toBe('command: ls -la');
  expect(briefInput({})).toBe('');
  expect(briefInput({ command: 'x'.repeat(500) }).length).toBeLessThan(300);
});

test('a plan is summarised by its first line, and a command still wins over it', () => {
  expect(briefInput({ plan: '\n# Ship the release\n\n1. Tag it.', planFilePath: '/w/plan.md' })).toBe('plan: # Ship the release');
  expect(briefInput({ command: 'ls', plan: '# Other' })).toBe('command: ls');
});

test('the full input names every field, whole, one per line', () => {
  expect(fullInput({ command: 'npm test -- --watch=false', description: 'Run the suite', timeout: 60000 }))
    .toBe('command: npm test -- --watch=false\ndescription: Run the suite\ntimeout: 60000');
  expect(fullInput({ file_path: '/w/a.ts', old_string: 'a\nb', new_string: 'c' }))
    .toBe('file_path: /w/a.ts\nold_string: a\nb\nnew_string: c');
  expect(fullInput({ options: { recursive: true } })).toBe('options: {"recursive":true}');
  expect(fullInput({})).toBe('');
  expect(fullInput(null)).toBe('');
});

test('the full input is cut at 8,000 characters, and says so with an ellipsis', () => {
  const long = fullInput({ content: 'x'.repeat(20000) });
  expect(long.length).toBe(8002);
  expect(long.endsWith('\n\u2026')).toBe(true);
  expect(fullInput({ content: 'x'.repeat(7000) }).endsWith('\u2026')).toBe(false);
});

test('steering on appends into the running turn', () => {
  expect(steerRoute(true)).toBe('append');
});

test('steering off queues instead, and never drops the message', () => {
  // The off switch belongs to the terminal, so the fallback is the route that still delivers.
  expect(steerRoute(false)).toBe('prompt');
  expect(steerRoute(undefined)).toBe('prompt');
});
