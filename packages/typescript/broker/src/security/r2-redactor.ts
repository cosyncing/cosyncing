/**
 * Deterministic, fail-closed transcript redactor for R2 `export-attachment` artifacts.
 *
 * GPT-Pro R2 review rules 11-13 (verified 2026-07-03): OpenCode `--sanitize` still leaks raw
 * `/home/tester` paths (5 occurrences reproduced on 1.16.2) and Pi `export_html` has no native
 * sanitize, so cosyncing MUST run this pass on BOTH surfaces. High-confidence credential classes
 * are redacted, then a post-redaction verification pass re-scans; if any high-confidence secret
 * survives — or the input is not decodable text, or the redactor throws — the caller fails closed
 * (refuses the export and deletes all temp material). There is NO unredacted remote override.
 *
 * No model calls. Pure function; fully covered by packages/typescript/broker/test/security-r2/test-r2-redactor.ts.
 */

export interface RedactionContext {
  /** Absolute home dir(s) to strip (e.g. `/home/tester`). */
  homeDirs?: string[];
  /** Absolute project/session root(s) to strip. */
  projectRoots?: string[];
}

export interface RedactionResult {
  /** false = fail-closed: refuse the export and delete temp material. */
  ok: boolean;
  text: string;
  /** Per-category redaction counts (for the no-content audit log, rule 19). */
  counts: Record<string, number>;
  /** High-confidence secret categories still present after redaction (empty when ok). */
  residual: string[];
  /** Human-readable refusal reason when !ok. */
  reason?: string;
}

interface Rule {
  category: string;
  regex: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
  /** High-confidence rules are re-scanned in the post-redaction verification pass. */
  high: boolean;
}

// Order matters: block/structured secrets first, then provider tokens (Anthropic before generic
// OpenAI so `sk-ant-...` is not mis-tagged), then header/URL/env/path context.
const RULES: Rule[] = [
  { category: 'PRIVATE_KEY', high: true, replacement: '[REDACTED_PRIVATE_KEY]',
    regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
  { category: 'JWT', high: true, replacement: '[REDACTED_JWT]',
    regex: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
  { category: 'ANTHROPIC_KEY', high: true, replacement: '[REDACTED_ANTHROPIC_KEY]',
    regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { category: 'OPENAI_KEY', high: true, replacement: '[REDACTED_OPENAI_KEY]',
    regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9]{20,}\b/g },
  { category: 'GITHUB_TOKEN', high: true, replacement: '[REDACTED_GITHUB_TOKEN]',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { category: 'NPM_TOKEN', high: true, replacement: '[REDACTED_NPM_TOKEN]',
    regex: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { category: 'SLACK_TOKEN', high: true, replacement: '[REDACTED_SLACK_TOKEN]',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { category: 'GOOGLE_KEY', high: true, replacement: '[REDACTED_GOOGLE_KEY]',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { category: 'GOOGLE_OAUTH', high: true, replacement: '[REDACTED_GOOGLE_OAUTH]',
    regex: /\bya29\.[0-9A-Za-z_-]{20,}\b/g },
  { category: 'AWS_KEY_ID', high: true, replacement: '[REDACTED_AWS_KEY_ID]',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { category: 'AWS_SECRET', high: true, replacement: (_m, p1: string) => `${p1}[REDACTED_AWS_SECRET]`,
    regex: /\b(aws_secret_access_key\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}\b["']?/gi },
  // Secret-bearing assignments (.env-style `NAME=...` and JSON `"NAME":"..."`). Names containing a
  // secret token are redacted regardless of value shape (catches DATABASE_URL, PASSWORD, etc.).
  { category: 'SECRET_ASSIGNMENT', high: false, replacement: (_m, p1: string, p2: string) => `${p1}${p2}[REDACTED_SECRET_ASSIGNMENT]`,
    regex: /^([ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|PRIVATE|COOKIE|DATABASE_URL))([ \t]*=[ \t]*)(?!\s*$).+$/gim },
  { category: 'SECRET_ASSIGNMENT', high: false, replacement: (_m, p1: string) => `${p1}"[REDACTED_SECRET_ASSIGNMENT]"`,
    regex: /("[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|PRIVATE|COOKIE|DATABASE_URL)"\s*:\s*)"[^"]*"/gi },
  { category: 'DATABASE_URL', high: false, replacement: '[REDACTED_DATABASE_URL]',
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*:[^\s"'<>@]+@[^\s"'<>]+/gi },
  // HTTP auth/cookie header values.
  { category: 'AUTH_HEADER', high: false, replacement: (_m, p1: string, p2: string) => `${p1}${p2}[REDACTED_HEADER]`,
    regex: /\b(Authorization|Cookie|Set-Cookie)(\s*[:=]\s*)(?!\s*$)[^\r\n]+/gi },
  // URL query parameters that commonly carry secrets.
  { category: 'URL_SECRET_PARAM', high: false, replacement: (_m, p1: string) => `${p1}[REDACTED_QUERY]`,
    regex: /([?&](?:token|key|secret|signature|sig|code|session|api[_-]?key|access[_-]?token)=)[^&\s"'#<>]+/gi },
];

function applyRule(text: string, rule: Rule, counts: Record<string, number>): string {
  return text.replace(rule.regex, (...args: unknown[]) => {
    counts[rule.category] = (counts[rule.category] ?? 0) + 1;
    if (typeof rule.replacement === 'function') {
      const groups = (args as [string, ...unknown[]]).slice(1, -2).map((g) => (typeof g === 'string' ? g : ''));
      return (rule.replacement as (match: string, ...g: string[]) => string)(args[0] as string, ...groups);
    }
    return rule.replacement;
  });
}

function redactPathPrefixes(text: string, ctx: RedactionContext, counts: Record<string, number>): string {
  let out = text;
  const prefixes: Array<{ value: string; token: string }> = [];
  for (const home of ctx.homeDirs ?? []) if (home) prefixes.push({ value: home, token: '[REDACTED_HOME]' });
  for (const root of ctx.projectRoots ?? []) if (root) prefixes.push({ value: root, token: '[REDACTED_PROJECT]' });
  prefixes.push({ value: '%USERPROFILE%', token: '[REDACTED_HOME]' });
  // Longest first so a project root nested under home is redacted before the home prefix.
  prefixes.sort((a, b) => b.value.length - a.value.length);
  for (const { value, token } of prefixes) {
    const re = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    out = out.replace(re, () => {
      counts.PATH_PREFIX = (counts.PATH_PREFIX ?? 0) + 1;
      return token;
    });
  }
  return out;
}

// Verification-only patterns (post-redaction). Broader than the forward rules so a secret the forward
// pass could not cleanly excise still fails the export closed — e.g. a malformed/lone PEM marker whose
// matching `-----END-----` is missing (so the block rule did not match) must still refuse.
const VERIFY_EXTRA: Array<{ category: string; regex: RegExp }> = [
  { category: 'PRIVATE_KEY_MARKER', regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
];

function scanHighConfidence(text: string): string[] {
  const found: string[] = [];
  for (const rule of RULES) {
    if (!rule.high) continue;
    rule.regex.lastIndex = 0;
    if (rule.regex.test(text)) found.push(rule.category);
    rule.regex.lastIndex = 0;
  }
  for (const extra of VERIFY_EXTRA) {
    extra.regex.lastIndex = 0;
    if (extra.regex.test(text)) found.push(extra.category);
    extra.regex.lastIndex = 0;
  }
  return [...new Set(found)];
}

const REPLACEMENT_CHAR = '�';

/**
 * Coarse input ceiling (defense-in-depth). The export path already caps native output at ≤100 MiB, but
 * the redactor runs its regex set synchronously with no time budget, and a few context rules
 * (DATABASE_URL) can backtrack on pathological input. Refuse anything above this outright so worst-case
 * redaction time is bounded regardless of caller. NOTE: this bounds `input.length` — UTF-16 CODE UNITS,
 * not bytes (Fable review 2026-07-08 #5); it is a backstop for direct callers and is UNREACHABLE via the
 * export path, where the ≤100 MiB byte cap already implies fewer code units. Normal transcripts are far below.
 */
const MAX_REDACTOR_INPUT_UNITS = 128 * 1024 * 1024;

export function redactTranscript(input: string, ctx: RedactionContext = {}): RedactionResult {
  const counts: Record<string, number> = {};
  try {
    if (typeof input !== 'string') return { ok: false, text: '', counts, residual: [], reason: 'input is not decodable text' };
    if (input.length > MAX_REDACTOR_INPUT_UNITS) {
      return { ok: false, text: '', counts, residual: [], reason: 'export exceeds the redactor input ceiling' };
    }
    // Reject material that did not decode as text (rule 13). A run of replacement chars or any NUL byte
    // indicates binary/undecodable content we cannot safely scan.
    const replacementRatio = input.length ? (input.split(REPLACEMENT_CHAR).length - 1) / input.length : 0;
    if (input.includes('\0') || replacementRatio > 0.02) {
      return { ok: false, text: '', counts, residual: [], reason: 'export is not decodable as text (binary/undecodable)' };
    }
    let text = input;
    for (const rule of RULES) {
      rule.regex.lastIndex = 0;
      text = applyRule(text, rule, counts);
    }
    text = redactPathPrefixes(text, ctx, counts);
    // Post-redaction verification (rule 13): re-scan for any surviving high-confidence secret.
    const residual = scanHighConfidence(text);
    if (residual.length) {
      return { ok: false, text: '', counts, residual, reason: `residual high-confidence secrets after redaction: ${residual.join(',')}` };
    }
    return { ok: true, text, counts, residual: [] };
  } catch (err) {
    return { ok: false, text: '', counts, residual: [], reason: `redactor crashed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
