/**
 * How Claude's AskUserQuestion spells an answer, both ways.
 *
 * The broker writes an answer the app gave the way Claude's own picker would, and both the broker
 * and the transcript mapper read Claude's answer back into the rows the app sends, so a settled
 * card can show what was picked. The two halves live here, beside the transcript they read, so
 * the broker and the adapter cannot drift apart on either.
 */

/**
 * A multi-select answer, spelled the way Claude's own picker spells it: the chosen labels joined
 * with ", ", and each label holding ", " or a double quote written as a JSON string. This is the
 * function 2.1.292's AskUserQuestion joins its picker's choices with, so a label with a comma in it
 * reaches the model exactly as it would had the person picked it in the terminal; the mod reads it
 * back with that build's own parser.
 */
export function joinClaudeAnswerLabels(labels: readonly string[]): string {
  return labels.map((label) => (label.includes(', ') || label.includes('"') ? JSON.stringify(label) : label)).join(', ');
}

/** {@link joinClaudeAnswerLabels} read back, or undefined for text it could not have written. Claude's own parser. */
export function splitClaudeAnswerLabels(answer: string): string[] | undefined {
  const parts: string[] = [];
  let rest = answer;
  for (;;) {
    if (rest.startsWith('"')) {
      let end = -1;
      let escaped = false;
      for (let index = 1; index < rest.length; index += 1) {
        const char = rest[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          end = index;
          break;
        }
      }
      if (end === -1) return undefined;
      try {
        const label: unknown = JSON.parse(rest.slice(0, end + 1));
        if (typeof label !== 'string') return undefined;
        parts.push(label);
      } catch {
        return undefined;
      }
      rest = rest.slice(end + 1);
    } else {
      const comma = rest.indexOf(', ');
      const part = comma === -1 ? rest : rest.slice(0, comma);
      if (part.includes('"')) return undefined;
      parts.push(part);
      rest = comma === -1 ? '' : rest.slice(comma);
    }
    if (rest === '') break;
    if (!rest.startsWith(', ')) return undefined;
    rest = rest.slice(2);
    if (rest === '') return undefined;
  }
  return parts;
}

/** One question of a card, as far as reading its answer back needs it. */
export interface ClaudeAnsweredQuestion {
  question: string;
  multiple?: boolean;
  options: readonly { label: string }[];
}

/**
 * Claude's `{ [question text]: answer }` back to the app's rows: one row per question, in the
 * card's order.
 *
 * A row's values are what the card can draw. A single answer is one value, which the card checks
 * when it is a label and shows as typed text when it is not. A multi-select answer is its labels
 * only when every part it splits into is one of the question's labels; otherwise it is kept whole,
 * as typed text. Older builds joined a label holding ", " without quoting it, and a typed answer
 * can sit beside picked labels, so a part that is not a label is never guessed into an option, and
 * the answer is never cut into fragments that read as something nobody wrote. A question with no
 * answer is an empty row. Undefined when there is no answer map at all.
 */
export function claudeAnswerRows(questions: readonly ClaudeAnsweredQuestion[], answers: unknown): string[][] | undefined {
  if (questions.length === 0 || !answers || typeof answers !== 'object' || Array.isArray(answers)) return undefined;
  const map = answers as Record<string, unknown>;
  return questions.map((question) => {
    const value = Object.prototype.hasOwnProperty.call(map, question.question) ? map[question.question] : undefined;
    if (typeof value !== 'string' || !value.trim()) return [];
    if (question.multiple !== true) return [value];
    const labels = new Set(question.options.map((option) => option.label));
    const parts = splitClaudeAnswerLabels(value);
    return parts && parts.length > 0 && parts.every((part) => labels.has(part)) ? parts : [value];
  });
}
