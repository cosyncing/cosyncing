/**
 * omp's `form` dialog, read onto the app's existing question card.
 *
 * omp 19.1.0 sends an HTML form as one RPC dialog (measured, `rpc-mode.ts` `requestRpcFormDialog`):
 * `{type:'extension_ui_request', id, method:'form', html, timeout?}`. Its native `ask` tool uses it
 * (under `--mode rpc-ui`), and so does any extension's `formDialog`. The answer is
 * `{type:'extension_ui_response', id, data:{<name>: value}}`, which omp validates strictly against
 * the form it parsed: a radio group or single `<select>` takes one option value, a checkbox group of
 * two or more or a multi-select takes an array of option values, a lone checkbox takes its value, a
 * text control takes a string (`number`/`range` also a number), and a name the form does not have
 * fails the whole answer. Hidden inputs keep the form's own values, so they are never sent.
 *
 * Each named control becomes one question, in document order, worded the way omp's own answer
 * summary words it (measured): a group's `<legend>`, else the control's `<label>`, else the text
 * just before it. A form this reader cannot represent faithfully (a file input, a name shared by
 * two different kinds of control, no answerable control at all) is not offered: the caller cancels
 * it, as it does any dialog it cannot answer.
 */

/** One option of a choice question: what omp expects back (`value`) and what the card shows. */
export interface PiFormOption {
  value: string;
  label: string;
  checked: boolean;
}

/** One question of a form, keyed by the control `name` omp validates the answer against. */
export interface PiFormField {
  name: string;
  /** `single`: radio group or `<select>`; `multiple`: checkbox group or `<select multiple>`. */
  kind: 'single' | 'multiple' | 'text' | 'number';
  question: string;
  options: PiFormOption[];
  /** A text control's own value attribute (or a textarea's content): the answer when none is given. */
  defaultText?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface PiFormDialog {
  fields: PiFormField[];
}

/** The question-card rows for a form: one per field. */
export interface PiFormQuestion {
  question: string;
  options: { label: string }[];
  multiple?: boolean;
  freeText?: boolean;
  kind?: 'text' | 'number';
  min?: number;
  max?: number;
  step?: number;
}

const SKIPPED = new Set(['script', 'style', 'template', 'head', 'title', 'noscript', 'iframe', 'button']);
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'section', 'article', 'blockquote', 'pre', 'table', 'tr', 'td', 'th', 'form', 'fieldset', 'br', 'hr']);
const TEXT_INPUTS = new Set(['text', 'email', 'url', 'tel', 'search', 'password', 'date', 'time', 'datetime-local', 'month', 'week', 'color']);
const IGNORED_INPUTS = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const squash = (text: string): string => decodeEntities(text).replace(/\s+/g, ' ').trim();

function attributes(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1]!.toLowerCase();
    if (!out.has(name)) out.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return out;
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

interface DraftField {
  field: PiFormField;
  /** The control kind the name was first seen with; a different kind under the same name is unsupported. */
  control: 'radio' | 'checkbox' | 'select' | 'text';
  legend?: string;
  before?: string;
  label?: string;
}

/**
 * Read an omp form's HTML into questions, or `undefined` when it cannot be offered faithfully.
 * Never throws: a form is untrusted runtime input.
 */
export function parsePiFormDialog(html: unknown): PiFormDialog | undefined {
  if (typeof html !== 'string' || !html.trim() || html.length > 1024 * 1024) return undefined;
  const drafts = new Map<string, DraftField>();
  const byId = new Map<string, { draft: DraftField; option?: PiFormOption }>();
  const forLabels = new Map<string, string>();
  const legends: string[] = [];
  let legendText: string | undefined;
  let label: { text: string; targets: Array<{ draft: DraftField; option?: PiFormOption }>; forId?: string } | undefined;
  let select: { draft: DraftField; option?: { value?: string; text: string; checked: boolean; disabled: boolean } } | undefined;
  let textarea: { draft: DraftField; text: string } | undefined;
  let skipping: string | undefined;
  let pending = '';
  let lastText: string | undefined;
  let unsupported = false;

  const settleText = (): void => {
    const text = squash(pending);
    if (text) lastText = text;
    pending = '';
  };
  const draftFor = (name: string, control: DraftField['control'], kind: PiFormField['kind']): DraftField | undefined => {
    const existing = drafts.get(name);
    if (existing) {
      if (existing.control !== control) unsupported = true;
      return existing.control === control ? existing : undefined;
    }
    settleText();
    const draft: DraftField = {
      field: { name, kind, question: name, options: [] },
      control,
      legend: legends.at(-1),
      before: lastText,
    };
    drafts.set(name, draft);
    return draft;
  };
  const target = (attrs: Map<string, string>, entry: { draft: DraftField; option?: PiFormOption }): void => {
    if (label) label.targets.push(entry);
    const id = attrs.get('id');
    if (id) byId.set(id, entry);
  };

  for (const match of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g)) {
    if (match[0].startsWith('<!--')) continue;
    const closing = match[1] === '/';
    const tag = match[2]?.toLowerCase();
    const text = match[4] ?? (tag === undefined && match[0] === '<' ? '<' : undefined);
    if (skipping) {
      if (closing && tag === skipping) skipping = undefined;
      continue;
    }
    if (text !== undefined) {
      if (textarea) textarea.text += text;
      else if (select?.option) select.option.text += text;
      else if (legendText !== undefined) legendText += text;
      else if (label) label.text += text;
      else pending += text;
      continue;
    }
    if (!tag) continue;
    if (!closing && SKIPPED.has(tag)) {
      if (!/\/\s*$/.test(match[3] ?? '')) skipping = tag;
      continue;
    }
    const attrs = attributes(match[3] ?? '');
    if (tag === 'textarea') {
      if (closing) {
        if (textarea) textarea.draft.field.defaultText = decodeEntities(textarea.text.replace(/^\r?\n/, ''));
        textarea = undefined;
        continue;
      }
      const name = attrs.get('name');
      const draft = name ? draftFor(name, 'text', 'text') : undefined;
      if (draft) {
        textarea = { draft, text: '' };
        target(attrs, { draft });
      }
      continue;
    }
    if (tag === 'select') {
      if (closing) {
        if (select?.option) finishOption();
        select = undefined;
        continue;
      }
      const name = attrs.get('name');
      const draft = name ? draftFor(name, 'select', attrs.has('multiple') ? 'multiple' : 'single') : undefined;
      if (draft) {
        select = { draft };
        target(attrs, { draft });
      }
      continue;
    }
    if (tag === 'option' && select) {
      if (select.option) finishOption();
      if (!closing) {
        select.option = {
          ...(attrs.has('value') ? { value: attrs.get('value') } : {}),
          text: '',
          checked: attrs.has('selected'),
          disabled: attrs.has('disabled'),
        };
      }
      continue;
    }
    if (tag === 'legend') {
      if (closing) {
        if (legendText !== undefined && legends.length) legends[legends.length - 1] = squash(legendText);
        legendText = undefined;
      } else legendText = '';
      continue;
    }
    if (tag === 'fieldset') {
      settleText();
      if (closing) legends.pop();
      else legends.push('');
      continue;
    }
    if (tag === 'label') {
      if (closing) {
        if (label) {
          const text = squash(label.text);
          if (label.forId) forLabels.set(label.forId, text);
          for (const entry of label.targets) {
            if (entry.option) entry.option.label = text || entry.option.label;
            else if (text) entry.draft.label = text;
          }
        }
        label = undefined;
      } else {
        settleText();
        label = { text: '', targets: [], ...(attrs.get('for') ? { forId: attrs.get('for') } : {}) };
      }
      continue;
    }
    if (tag === 'input' && !closing) {
      const type = (attrs.get('type') ?? 'text').toLowerCase();
      const name = attrs.get('name');
      if (IGNORED_INPUTS.has(type)) continue;
      if (type === 'file') {
        unsupported = true;
        continue;
      }
      if (!name) continue;
      if (type === 'radio' || type === 'checkbox') {
        const draft = draftFor(name, type, type === 'radio' ? 'single' : 'multiple');
        if (!draft) continue;
        if (attrs.has('disabled')) continue;
        const value = attrs.get('value') ?? 'on';
        if (draft.field.options.some((option) => option.value === value)) continue;
        const option: PiFormOption = { value, label: value, checked: attrs.has('checked') };
        draft.field.options.push(option);
        target(attrs, { draft, option });
        continue;
      }
      const numeric = type === 'number' || type === 'range';
      if (!numeric && !TEXT_INPUTS.has(type)) {
        unsupported = true;
        continue;
      }
      const draft = draftFor(name, 'text', numeric ? 'number' : 'text');
      if (!draft) continue;
      if (attrs.has('value')) draft.field.defaultText = attrs.get('value');
      if (numeric) {
        const min = finiteNumber(attrs.get('min'));
        const max = finiteNumber(attrs.get('max'));
        const step = finiteNumber(attrs.get('step'));
        if (min !== undefined) draft.field.min = min;
        if (max !== undefined) draft.field.max = max;
        if (step !== undefined && step > 0) draft.field.step = step;
      }
      target(attrs, { draft });
      continue;
    }
    if (BLOCK.has(tag)) settleText();
  }

  function finishOption(): void {
    const option = select?.option;
    if (!select || !option) return;
    select.option = undefined;
    if (option.disabled) return;
    const label = squash(option.text);
    const value = option.value ?? label;
    if (select.draft.field.options.some((existing) => existing.value === value)) return;
    select.draft.field.options.push({ value, label: label || value, checked: option.checked });
  }

  if (unsupported) return undefined;
  for (const [id, text] of forLabels) {
    const entry = byId.get(id);
    if (!entry || !text) continue;
    if (entry.option) entry.option.label = text;
    else entry.draft.label ??= text;
  }
  const fields: PiFormField[] = [];
  for (const draft of drafts.values()) {
    const { field } = draft;
    const choice = draft.control !== 'text';
    if (choice && field.options.length === 0) continue;
    field.question = (choice
      ? draft.legend || draft.label || draft.before
      : draft.label || draft.legend || draft.before) || field.name;
    // A lone checkbox is a yes/no: omp takes its value alone, never an array (`isArrayChoice`).
    fields.push(field);
  }
  return fields.length ? { fields } : undefined;
}

/** The question card for a form: one question per field, in the form's order. */
export function piFormQuestions(form: PiFormDialog): PiFormQuestion[] {
  return form.fields.map((field) => {
    if (field.kind === 'text') return { question: field.question, options: [], kind: 'text' as const };
    if (field.kind === 'number') {
      return {
        question: field.question,
        options: [],
        kind: 'number' as const,
        ...(field.min !== undefined ? { min: field.min } : {}),
        ...(field.max !== undefined ? { max: field.max } : {}),
        ...(field.step !== undefined ? { step: field.step } : {}),
      };
    }
    // Only the listed options: omp accepts free text for some groups ("Other"), but which ones
    // depends on its own reading of the form, and a value it does not accept fails the answer.
    return {
      question: field.question,
      options: field.options.map((option) => ({ label: option.label })),
      ...(field.kind === 'multiple' ? { multiple: true } : {}),
      freeText: false,
    };
  });
}

/**
 * The `data` object omp validates, from the card's answer rows (one per question, values are option
 * labels or typed text). A question left unanswered keeps the form's own defaults, as omp does when a
 * form times out.
 */
export function piFormAnswerData(form: PiFormDialog, answers: readonly (readonly string[])[] | undefined): Record<string, string | number | string[]> {
  const data: Record<string, string | number | string[]> = Object.create(null);
  form.fields.forEach((field, index) => {
    const row = (answers?.[index] ?? []).filter((value): value is string => typeof value === 'string');
    if (field.kind === 'text' || field.kind === 'number') {
      const text = row.length ? row[0]! : field.defaultText;
      if (text === undefined) return;
      const number = field.kind === 'number' && text.trim() !== '' ? Number(text) : Number.NaN;
      data[field.name] = Number.isFinite(number) ? number : text;
      return;
    }
    const chosen = row.length
      ? row.flatMap((answer) => {
        const option = field.options.find((candidate) => candidate.label === answer)
          ?? field.options.find((candidate) => candidate.value === answer);
        return option ? [option.value] : [];
      })
      : field.options.filter((option) => option.checked).map((option) => option.value);
    const values = [...new Set(chosen)];
    if (field.kind === 'multiple' && field.options.length > 1) {
      data[field.name] = values;
      return;
    }
    if (values.length) data[field.name] = values[0]!;
  });
  return data;
}
