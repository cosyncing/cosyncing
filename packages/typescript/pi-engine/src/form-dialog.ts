/**
 * omp's `form` dialog, read onto the app's existing question card.
 *
 * omp 19.1.0 sends an HTML form as one RPC dialog (measured, `rpc-mode.ts` `requestRpcFormDialog`):
 * `{type:'extension_ui_request', id, method:'form', html, timeout?}`. Its native `ask` tool uses it
 * (under `--mode rpc-ui`), and so does any extension's `formDialog` (also under `--mode rpc`). The
 * answer is `{type:'extension_ui_response', id, data:{<name>: value}}`, which omp validates strictly
 * against the form it parsed (`parseFormDialogResponse`, `@oh-my-pi/pi-tui` `html-form`):
 *
 * - a radio group or single `<select>` takes one option value; a checkbox group or multi-select
 *   takes an array, but only when it has two or more options, disabled and repeated ones counted
 *   (`isArrayChoice`); a lone checkbox takes its value alone;
 * - a text control takes a string (`number`/`range` also a number);
 * - every field must then pass `fieldError`: `required`, numeric `min`/`max`, `minlength`/
 *   `maxlength`, the `email` and `url` shapes, and `pattern` (anchored, `v` flag, an invalid one
 *   ignored);
 * - a name the form does not have fails the whole answer, and so does any field that fails.
 *
 * A failed answer rejects the extension's dialog outright, so the same rules run here BEFORE
 * anything is sent ({@link piFormAnswer}); a refused answer leaves the card open.
 *
 * Each named control becomes one question, in document order. A form this reader cannot represent
 * faithfully (a file input, a name shared by two different controls, a required group with nothing
 * left to choose, a `pattern` too expensive to check, no answerable control at all) is not offered:
 * the caller cancels it, as it does any dialog it cannot answer. Hidden inputs keep the form's own
 * values, so they are never sent.
 *
 * The form is untrusted runtime input read on the broker's event loop: every scan here is linear in
 * the HTML's length.
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
  /** The options a person can pick: enabled ones, the first of each value. */
  options: PiFormOption[];
  /** Whether omp takes this field's answer as an array: a checkbox group or multi-select with two or
   *  more options in the HTML, disabled and repeated ones included (omp `isArrayChoice`). */
  arrayAnswer: boolean;
  /** `required` on the control (on any option, for a radio or checkbox group). */
  required: boolean;
  /** A text control's `type` (`text`, `email`, `url`, `number`, …), `textarea` for a textarea. */
  inputType?: string;
  /** A text control's own value attribute (or a textarea's content): the answer when none is given. */
  defaultText?: string;
  min?: number;
  max?: number;
  step?: number;
  minLength?: number;
  maxLength?: number;
  /** A `pattern` that compiles the way omp compiles it; an invalid one is dropped, as omp ignores it. */
  pattern?: string;
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

/** Larger forms are not offered. omp itself refuses a frame past its protocol's intact size. */
export const PI_FORM_HTML_MAX_CHARS = 1024 * 1024;
/** A `pattern` longer than this is not checked here, so its form is not offered. */
const PATTERN_MAX_CHARS = 512;
/** An answer longer than this is not run against a `pattern` (bounds a polynomial backtrack). */
const PATTERN_ANSWER_MAX_CHARS = 1024;

const SKIPPED = new Set(['script', 'style', 'template', 'head', 'title', 'noscript', 'iframe', 'button']);
/** Elements whose content is text, not markup, up to their own end tag (HTML raw text / RCDATA). */
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'iframe', 'noscript']);
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'section', 'article', 'blockquote', 'pre', 'table', 'tr', 'td', 'th', 'form', 'fieldset', 'br', 'hr']);
const TEXT_INPUTS = new Set(['text', 'email', 'url', 'tel', 'search', 'password', 'date', 'time', 'datetime-local', 'month', 'week', 'color']);
const IGNORED_INPUTS = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,8}|#[0-9]{1,8}|[a-z]{1,32});/gi, (whole, body: string) => {
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

type FormToken =
  | { kind: 'text'; text: string }
  | { kind: 'tag'; closing: boolean; name: string; source: string };

const isAsciiLetter = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isTagNameChar = (code: number): boolean => isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 45;

/**
 * The HTML's text runs and tags, in one forward pass. Each `<` is examined once and the scan never
 * returns behind a tag it has read, so crafted input (thousands of `<` with no `>`, unclosed quotes
 * or comments) costs time linear in its length. Like an HTML tokenizer, a tag still open at the end
 * of the input is dropped with everything after it, a comment runs to `-->` or the end, `<!…>` and
 * `<?…>` are skipped, and a raw-text element's content is one text run up to its end tag.
 */
function* formTokens(html: string): Generator<FormToken> {
  const length = html.length;
  let at = 0;
  /** Where the text run not yet yielded starts: a `<` that opens nothing stays part of it. */
  let textFrom = 0;
  while (at < length) {
    const open = html.indexOf('<', at);
    if (open < 0) break;
    const next = html.charCodeAt(open + 1);
    const comment = html.startsWith('<!--', open);
    const bogus = !comment && (next === 33 /* ! */ || next === 63 /* ? */);
    const closing = next === 47; /* / */
    const nameStart = closing ? open + 2 : open + 1;
    if (!comment && !bogus && !isAsciiLetter(html.charCodeAt(nameStart))) {
      at = open + 1;
      continue;
    }
    if (open > textFrom) yield { kind: 'text', text: html.slice(textFrom, open) };
    if (comment || bogus) {
      const end = comment ? html.indexOf('-->', open + 4) : html.indexOf('>', open + 2);
      at = end < 0 ? length : end + (comment ? 3 : 1);
      textFrom = at;
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < length && isTagNameChar(html.charCodeAt(nameEnd))) nameEnd++;
    // To the tag's `>`, outside an attribute value's quotes (a quote opens a value only after `=`).
    let quote = 0;
    let previous = 0;
    let end = nameEnd;
    for (; end < length; end++) {
      const code = html.charCodeAt(end);
      if (quote) {
        if (code === quote) quote = 0;
        continue;
      }
      if (code === 62 /* > */) break;
      if ((code === 34 || code === 39) && previous === 61 /* = */) quote = code;
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12) previous = code;
    }
    if (end >= length) return;
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const source = html.slice(nameEnd, end);
    yield { kind: 'tag', closing, name, source };
    at = end + 1;
    if (!closing && RAW_TEXT.has(name)) {
      const close = endTagAt(html, name, at);
      const contentEnd = close < 0 ? length : close;
      if (contentEnd > at) yield { kind: 'text', text: html.slice(at, contentEnd) };
      at = contentEnd;
    }
    textFrom = at;
  }
  if (textFrom < length) yield { kind: 'text', text: html.slice(textFrom) };
}

/** Where `</name` (any case, then a non-name character) next starts at or after `from`, or -1. */
function endTagAt(html: string, name: string, from: number): number {
  let at = from;
  for (;;) {
    const found = html.indexOf('</', at);
    if (found < 0) return -1;
    const after = found + 2 + name.length;
    if (html.slice(found + 2, after).toLowerCase() === name && !isTagNameChar(html.charCodeAt(after))) return found;
    at = found + 2;
  }
}

/**
 * Whether a `pattern` can backtrack exponentially: a repeated group whose body itself repeats or
 * alternates (`(\w+\s?)+`, `(a|ab)*`). Such a pattern is not run on the broker, so its form is not
 * offered. Linear in the pattern's length.
 */
function backtrackingPattern(pattern: string): boolean {
  /** Per open group: whether its body holds a quantifier or an alternation. */
  const bodies: boolean[] = [false];
  const length = pattern.length;
  const quantifierAt = (at: number): { length: number; repeats: boolean } | undefined => {
    const ch = pattern[at];
    let consumed: number;
    let repeats: boolean;
    if (ch === '*' || ch === '+') {
      consumed = 1;
      repeats = true;
    } else if (ch === '?') {
      consumed = 1;
      repeats = false;
    } else if (ch === '{') {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(at, at + 24));
      if (!match) return undefined;
      consumed = match[0].length;
      const most = match[2] === undefined ? Number(match[1]) : match[3] ? Number(match[3]) : Number.POSITIVE_INFINITY;
      repeats = most > 1;
    } else {
      return undefined;
    }
    if (pattern[at + consumed] === '?') consumed += 1;
    return { length: consumed, repeats };
  };
  let at = 0;
  let classDepth = 0;
  while (at < length) {
    const ch = pattern[at]!;
    if (ch === '\\') {
      const kind = pattern[at + 1];
      if ((kind === 'p' || kind === 'P' || kind === 'u' || kind === 'q') && pattern[at + 2] === '{') {
        const close = pattern.indexOf('}', at + 3);
        at = close < 0 ? length : close + 1;
      } else if (kind === 'k' && pattern[at + 2] === '<') {
        const close = pattern.indexOf('>', at + 3);
        at = close < 0 ? length : close + 1;
      } else {
        at += 2;
      }
      if (classDepth === 0) {
        const quantifier = quantifierAt(at);
        if (quantifier) {
          bodies[bodies.length - 1] = true;
          at += quantifier.length;
        }
      }
      continue;
    }
    if (classDepth > 0) {
      if (ch === '[') classDepth++;
      else if (ch === ']') classDepth--;
      at++;
      if (classDepth === 0) {
        const quantifier = quantifierAt(at);
        if (quantifier) {
          bodies[bodies.length - 1] = true;
          at += quantifier.length;
        }
      }
      continue;
    }
    if (ch === '[') {
      classDepth = 1;
      at++;
      continue;
    }
    if (ch === '(') {
      bodies.push(false);
      at++;
      if (pattern[at] === '?') {
        // A group prefix (`?:`, `?=`, `?!`, `?<=`, `?<!`, `?<name>`, `?i:`) is not a quantifier.
        at++;
        if (pattern[at] === '<' && pattern[at + 1] !== '=' && pattern[at + 1] !== '!') {
          const close = pattern.indexOf('>', at);
          at = close < 0 ? length : close + 1;
        } else {
          while (at < length && /[a-zA-Z-]/.test(pattern[at]!)) at++;
          if (pattern[at] === '<') at++;
          at++;
        }
      }
      continue;
    }
    if (ch === ')') {
      const body = bodies.length > 1 ? bodies.pop()! : false;
      at++;
      const quantifier = quantifierAt(at);
      if (quantifier) {
        if (quantifier.repeats && body) return true;
        at += quantifier.length;
        bodies[bodies.length - 1] = true;
      }
      if (body) bodies[bodies.length - 1] = true;
      continue;
    }
    if (ch === '|') {
      bodies[bodies.length - 1] = true;
      at++;
      continue;
    }
    at++;
    const quantifier = quantifierAt(at);
    if (quantifier) {
      bodies[bodies.length - 1] = true;
      at += quantifier.length;
    }
  }
  return false;
}

/** `^(?:pattern)$` as omp (and HTML) matches `pattern`, or undefined when it does not compile. */
function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, 'v');
  } catch {
    return undefined;
  }
}

interface DraftField {
  field: PiFormField;
  /** The control kind the name was first seen with; a different kind under the same name is unsupported. */
  control: 'radio' | 'checkbox' | 'select' | 'text';
  /** Every option the HTML gave this field, disabled and repeated ones included (omp counts them). */
  rawOptions: number;
  /** The option offered for each value, so a repeated value is offered once. */
  byValue: Map<string, PiFormOption>;
  legend?: string;
  before?: string;
  label?: string;
}

/**
 * Read an omp form's HTML into questions, or `undefined` when it cannot be offered faithfully.
 * Never throws: a form is untrusted runtime input.
 */
export function parsePiFormDialog(html: unknown): PiFormDialog | undefined {
  if (typeof html !== 'string' || !html.trim() || html.length > PI_FORM_HTML_MAX_CHARS) return undefined;
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
      // Radios and checkboxes of one name are one group; any other repeated name is two controls
      // omp answers from one entry, which a single card question cannot carry.
      if (existing.control !== control || (control !== 'radio' && control !== 'checkbox')) unsupported = true;
      return unsupported ? undefined : existing;
    }
    settleText();
    const draft: DraftField = {
      field: { name, kind, question: name, options: [], arrayAnswer: false, required: false },
      control,
      rawOptions: 0,
      byValue: new Map(),
      legend: legends.at(-1),
      before: lastText,
    };
    drafts.set(name, draft);
    return draft;
  };
  const addOption = (draft: DraftField, value: string, text: string, checked: boolean, disabled: boolean): PiFormOption | undefined => {
    draft.rawOptions += 1;
    if (disabled) return undefined;
    const first = draft.byValue.get(value);
    if (first) {
      // omp answers a repeated value with the first enabled option that carries it.
      if (checked) first.checked = true;
      return undefined;
    }
    const option: PiFormOption = { value, label: text || value, checked };
    draft.byValue.set(value, option);
    draft.field.options.push(option);
    return option;
  };
  const target = (attrs: Map<string, string>, entry: { draft: DraftField; option?: PiFormOption }): void => {
    if (label) label.targets.push(entry);
    const id = attrs.get('id');
    if (id) byId.set(id, entry);
  };

  for (const token of formTokens(html)) {
    if (token.kind === 'text') {
      if (skipping) continue;
      if (textarea) textarea.text += token.text;
      else if (select?.option) select.option.text += token.text;
      else if (legendText !== undefined) legendText += token.text;
      else if (label) label.text += token.text;
      else pending += token.text;
      continue;
    }
    const { closing, name: tag, source } = token;
    if (skipping) {
      if (closing && tag === skipping) skipping = undefined;
      continue;
    }
    if (!closing && SKIPPED.has(tag)) {
      if (!/\/\s*$/.test(source)) skipping = tag;
      continue;
    }
    const attrs = attributes(source);
    if (tag === 'textarea') {
      if (closing) {
        if (textarea) textarea.draft.field.defaultText = decodeEntities(textarea.text.replace(/^\r?\n/, ''));
        textarea = undefined;
        continue;
      }
      const name = attrs.get('name');
      const draft = name ? draftFor(name, 'text', 'text') : undefined;
      if (draft) {
        draft.field.inputType = 'textarea';
        draft.field.required = attrs.has('required');
        const minLength = finiteNumber(attrs.get('minlength'));
        const maxLength = finiteNumber(attrs.get('maxlength'));
        if (minLength !== undefined) draft.field.minLength = minLength;
        if (maxLength !== undefined) draft.field.maxLength = maxLength;
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
        draft.field.required = attrs.has('required');
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
        if (attrs.has('required')) draft.field.required = true;
        const value = attrs.get('value') ?? 'on';
        const option = addOption(draft, value, value, attrs.has('checked'), attrs.has('disabled'));
        if (option) target(attrs, { draft, option });
        continue;
      }
      const numeric = type === 'number' || type === 'range';
      if (!numeric && !TEXT_INPUTS.has(type)) {
        unsupported = true;
        continue;
      }
      const draft = draftFor(name, 'text', numeric ? 'number' : 'text');
      if (!draft) continue;
      draft.field.inputType = type;
      draft.field.required = attrs.has('required');
      if (attrs.has('value')) draft.field.defaultText = attrs.get('value');
      if (numeric) {
        const min = finiteNumber(attrs.get('min'));
        const max = finiteNumber(attrs.get('max'));
        const step = finiteNumber(attrs.get('step'));
        if (min !== undefined) draft.field.min = min;
        if (max !== undefined) draft.field.max = max;
        if (step !== undefined && step > 0) draft.field.step = step;
      }
      const minLength = finiteNumber(attrs.get('minlength'));
      const maxLength = finiteNumber(attrs.get('maxlength'));
      if (minLength !== undefined) draft.field.minLength = minLength;
      if (maxLength !== undefined) draft.field.maxLength = maxLength;
      const pattern = attrs.get('pattern');
      if (pattern !== undefined) {
        // omp ignores a pattern that does not compile; one that does is checked here first, so
        // one too long or too expensive to run on the broker keeps its form from being offered.
        if (pattern.length > PATTERN_MAX_CHARS) unsupported = true;
        else if (compilePattern(pattern)) {
          if (backtrackingPattern(pattern)) unsupported = true;
          else draft.field.pattern = pattern;
        }
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
    const text = squash(option.text);
    addOption(select.draft, option.value ?? text, text, option.checked, option.disabled);
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
    if (choice) {
      // A required choice with nothing left to pick cannot be answered in a way omp accepts.
      if (field.options.length === 0) {
        if (field.required) return undefined;
        continue;
      }
      field.arrayAnswer = field.kind === 'multiple' && draft.rawOptions > 1;
      // A single select always has a selection: its first enabled option unless one is marked.
      if (draft.control === 'select' && field.kind === 'single' && !field.options.some((option) => option.checked)) {
        field.options[0]!.checked = true;
      }
    }
    field.question = (choice
      ? draft.legend || draft.label || draft.before
      : draft.label || draft.legend || draft.before) || field.name;
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

/** The `data` omp validates for one form, or why omp would refuse it. */
export type PiFormAnswer =
  | { ok: true; data: Record<string, string | number | string[]> }
  | { ok: false; problem: string };

/** Why omp would refuse `value` for a text or number field (`fieldError`), or undefined. */
function textFieldProblem(field: PiFormField, value: string | number | undefined): string | undefined {
  const text = value === undefined ? '' : String(value);
  if (text.trim() === '') return field.required ? 'Required' : undefined;
  if (field.kind === 'number') {
    const number = Number(text);
    if (!Number.isFinite(number)) return 'Enter a number';
    if (field.min !== undefined && number < field.min) return `Must be at least ${field.min}`;
    if (field.max !== undefined && number > field.max) return `Must be at most ${field.max}`;
  }
  if (field.minLength !== undefined && text.length < field.minLength) return `Needs at least ${field.minLength} characters`;
  if (field.maxLength !== undefined && text.length > field.maxLength) return `At most ${field.maxLength} characters`;
  if (field.inputType === 'email' && !/^[^\s@]+@[^\s@]+$/.test(text)) return 'Enter an email address';
  if (field.inputType === 'url' && !canParseUrl(text)) return 'Enter a full URL';
  if (field.pattern) {
    if (text.length > PATTERN_ANSWER_MAX_CHARS) return `Too long to check against the form's pattern (at most ${PATTERN_ANSWER_MAX_CHARS} characters)`;
    if (compilePattern(field.pattern)?.test(text) === false) return `Must match ${field.pattern}`;
  }
  return undefined;
}

function canParseUrl(text: string): boolean {
  if (typeof URL.canParse === 'function') return URL.canParse(text);
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `data` object omp validates, from the card's answer rows (one per question; values are option
 * labels or typed text), or the first reason omp would refuse it. A question left unanswered keeps
 * the form's own defaults, as omp does when a form times out.
 */
export function piFormAnswer(form: PiFormDialog, answers: readonly (readonly string[])[] | undefined): PiFormAnswer {
  const data: Record<string, string | number | string[]> = Object.create(null);
  for (const [index, field] of form.fields.entries()) {
    const row = (answers?.[index] ?? []).filter((value): value is string => typeof value === 'string');
    if (field.kind === 'text' || field.kind === 'number') {
      const text = row.length ? row[0]! : field.defaultText;
      let value: string | number | undefined;
      if (text !== undefined) {
        const number = field.kind === 'number' && text.trim() !== '' ? Number(text) : Number.NaN;
        value = Number.isFinite(number) ? number : text;
        data[field.name] = value;
      }
      const problem = textFieldProblem(field, value);
      if (problem) return { ok: false, problem: `${field.question}: ${problem}` };
      continue;
    }
    let values: string[];
    if (row.length) {
      values = [];
      for (const answer of row) {
        const option = field.options.find((candidate) => candidate.label === answer)
          ?? field.options.find((candidate) => candidate.value === answer);
        if (!option) return { ok: false, problem: `${field.question}: "${answer}" is not one of its options` };
        if (!values.includes(option.value)) values.push(option.value);
      }
    } else {
      values = field.options.filter((option) => option.checked).map((option) => option.value);
    }
    if (field.arrayAnswer) {
      if (field.required && values.length === 0) return { ok: false, problem: `${field.question}: Select at least one` };
      data[field.name] = values;
      continue;
    }
    if (values.length > 1) return { ok: false, problem: `${field.question}: takes one answer` };
    if (values.length) data[field.name] = values[0]!;
    else if (field.required) return { ok: false, problem: `${field.question}: Required` };
  }
  return { ok: true, data };
}
