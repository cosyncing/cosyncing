/**
 * Thinking levels for the existing effort picker, from what a Pi-family agent says it accepts.
 *
 * Measured (Pi 1.6.0 and omp 19.1.0, scripted local model):
 *  - Pi's `get_available_thinking_levels` answers the current model's levels. Pi's rule for every
 *    model (`getSupportedThinkingLevels`, pi-ai 0.78.1 through 1.6.0) offers each level the
 *    model's `thinkingLevelMap` does not mark `null`, and `xhigh` and `max` only when the map names
 *    them. A level the model lacks is not refused: `set_thinking_level xhigh` on a model without it
 *    leaves Pi on `high`.
 *  - omp models list their efforts (`thinking.efforts`, which may include `max`). omp 19.1.0's
 *    `get_state.thinkingLevels` lists the current model's selectors: `off`, `auto`, then its
 *    efforts (`[]` for a model without reasoning); omp's source (19.2.1 `getAvailableEffortSelectors`)
 *    offers `off` and `auto` for every model with reasoning. `configuredThinkingLevel` is `auto`
 *    while auto mode picks the effort; `thinkingLevel` is then the effort it picked. omp 17.4.2 has
 *    neither field and no `auto`.
 */
import type { ModelOption } from '@cosyncing/adapter-api';

/** Every selector a Pi-family agent names, in the order its own selector lists them. */
export const PI_THINKING_LEVELS = [
  { effort: 'off', label: 'Off' },
  { effort: 'auto', label: 'Auto' },
  { effort: 'minimal', label: 'Minimal' },
  { effort: 'low', label: 'Low' },
  { effort: 'medium', label: 'Medium' },
  { effort: 'high', label: 'High' },
  { effort: 'xhigh', label: 'Extra high' },
  { effort: 'max', label: 'Max' },
] as const;
const PI_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(PI_THINKING_LEVELS.map((level) => level.effort));
/** Pi's own levels: what its model rule chooses from. `auto` is omp's alone. */
const PI_RULE_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Selectors omp offers for every model with reasoning, beside the model's own efforts. */
const MODEL_INDEPENDENT_SELECTORS = ['off', 'auto'];

export function normalizePiThinkingLevel(value: unknown): string | undefined {
  const level = typeof value === 'string' ? value.trim() : '';
  return PI_THINKING_LEVEL_SET.has(level) ? level : undefined;
}

/** The selector a native state or `thinking_level_change` entry names: omp's configured selector
 *  (`auto` while auto mode picks the effort) before the effective level. */
export function piThinkingSelector(source: any): string | undefined {
  return normalizePiThinkingLevel(source?.configuredThinkingLevel ?? source?.configured)
    ?? normalizePiThinkingLevel(source?.thinkingLevel);
}

/** Levels the agent listed for its current model, known ones only, in selector order. */
export function piAdvertisedThinkingLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const listed = new Set(value.map((level) => normalizePiThinkingLevel(level)).filter(Boolean));
  return PI_THINKING_LEVELS.filter(({ effort }) => listed.has(effort)).map(({ effort }) => effort);
}

/** What one agent process said about thinking levels, for the model picker. */
export interface PiThinkingCatalog {
  /** The current model and the levels the agent listed for it. */
  current?: { providerID: string; modelID: string; levels: string[] };
  /** Selectors the agent offers for every model with reasoning: omp's `off` and `auto`, on a build
   *  that lists selectors at all. */
  selectors?: string[];
}

/** The catalog a native state gives: omp's `thinkingLevels`, else a separate Pi-style answer. */
export function piThinkingCatalog(state: any, advertised?: unknown): PiThinkingCatalog {
  const model = state?.model;
  const modelID = model?.id ?? model?.modelID;
  const selectorList = Array.isArray(state?.thinkingLevels);
  const levels = piAdvertisedThinkingLevels(state?.thinkingLevels) ?? piAdvertisedThinkingLevels(advertised);
  return {
    ...(typeof modelID === 'string' && modelID && levels
      ? { current: { providerID: String(model.provider ?? model.providerID ?? ''), modelID, levels } }
      : {}),
    ...(selectorList ? { selectors: [...MODEL_INDEPENDENT_SELECTORS] } : {}),
  };
}

/** Whether the agent listed `auto` for the current model: the only evidence that it takes one. */
export function piOffersAutoThinking(state: any): boolean {
  return piAdvertisedThinkingLevels(state?.thinkingLevels)?.includes('auto') === true;
}

function modelEfforts(model: any): string[] | undefined {
  const native = Array.isArray(model?.thinking)
    ? model.thinking
    : Array.isArray(model?.thinking?.efforts)
      ? model.thinking.efforts
      : undefined;
  return native ? native.map((value: unknown) => normalizePiThinkingLevel(value)).filter(Boolean) : undefined;
}

/** Pi's `getSupportedThinkingLevels` for one model of its catalog. */
function piRuleLevels(model: any): string[] {
  const map = model?.thinkingLevelMap && typeof model.thinkingLevelMap === 'object' ? model.thinkingLevelMap : undefined;
  return PI_RULE_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    return level === 'xhigh' || level === 'max' ? mapped !== undefined : true;
  });
}

/**
 * The levels one catalog model offers. The current model takes the agent's own list. Another omp
 * model takes its efforts plus the selectors the agent offers for any model (`off`, `auto`); a Pi
 * model follows Pi's rule. Without word from the agent (an older build, or a terminal bridge) omp
 * models offer their efforts, as before, and never `auto`.
 */
export function piThinkingEfforts(model: any, catalog?: PiThinkingCatalog): ModelOption['reasoningEfforts'] | undefined {
  if (model?.reasoning !== true) return undefined;
  const modelID = model?.id ?? model?.modelID;
  const providerID = String(model?.provider ?? model?.providerID ?? '');
  const current = catalog?.current;
  let levels: string[];
  if (current && current.modelID === modelID && current.providerID === providerID) {
    levels = current.levels;
  } else {
    const efforts = modelEfforts(model);
    const independent = catalog?.selectors ?? [];
    levels = efforts ? [...independent, ...efforts] : [...independent, ...piRuleLevels(model)];
  }
  const offered = new Set(levels);
  const efforts = PI_THINKING_LEVELS
    .filter(({ effort }) => offered.has(effort))
    .map(({ effort, label }) => ({ effort, label }));
  return efforts.length ? efforts : undefined;
}
