#!/usr/bin/env bun
/**
 * Lint which broker sub-suites look safe to run concurrently, and enforce that
 * the inventory never claims more than the lint allows.
 *
 * Running the deterministic lane in parallel is only sound for suites that own
 * everything they touch. The lane's helpers make that possible — fixture
 * environments are per-suite temp roots and ports can be leased from the OS —
 * but adoption is partial, and a suite that hard-codes a port or writes a fixed
 * path is a race waiting for a second suite to start.
 *
 * This is a conservative lint, not a proof. It resolves each sub-suite's entry
 * point through package.json, walks its local import closure, and scans the
 * harness for ways a suite reaches outside itself. Known blind spots: the
 * import walker follows relative `import`/`import()` only, so re-exports
 * through packages, `require`, and computed specifiers are invisible to it;
 * and the port rule is satisfied per suite, so one `listen(0)` clears a harness
 * that also starts a second, unsafe server. Treat a clean result as "nothing
 * disqualifying was found", and rely on `--repeat` runs for the rest.
 *
 *   bun run verification:isolation-audit      # report, write JSON
 *   bun run verification:isolation-check      # enforce against the inventory
 *
 * Reporting exits non-zero only if the audit cannot run: a suite being
 * ineligible is a finding, and the lane simply keeps running it serially.
 * `--check` is the gate — it fails when the graph's parallel group claims a
 * suite this lint did not clear.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadVerificationGraph } from './verification-graph.ts';

const ROOT = resolve(import.meta.dir, '../..');

interface Hazard {
  rule: string;
  file: string;
  line: number;
  text: string;
}

export interface SuiteAudit {
  id: string;
  entryPoints: string[];
  closureSize: number;
  eligible: boolean;
  hazards: Hazard[];
}

/**
 * What disqualifies a suite from sharing the host with another suite.
 *
 * Each rule matches a way to name a resource that is not uniquely this suite's:
 * a port number the kernel did not choose, a path that does not come from
 * `mkdtemp`, or the host environment handed to a child wholesale.
 */
const RULES: Array<{
  id: string;
  pattern: RegExp;
  /** The match must also match this, or the hit is not a resource the suite owns. */
  require?: RegExp;
  allow?: RegExp;
}> = [
  {
    id: 'fixed-listen-port',
    // A literal 4-5 digit port in a bind, connect, or env assignment.
    pattern:
      /(?:PORT\s*[:=]\s*['"`]?\d{4,5}|listen\(\s*\d{4,5}|127\.0\.0\.1:\d{4,5}|localhost:\d{4,5}|--port[= ]\d{4,5})/,
  },
  {
    id: 'fixed-temp-path',
    // A hard-coded /tmp path instead of a per-run mkdtemp root.
    pattern: /['"`]\/tmp\/[A-Za-z0-9._-]+/,
    // Only when the suite actually *uses* the path as a path.
    //
    // These harnesses are full of `/tmp` strings that are payload data — a
    // recorded `cwd: '/tmp/x'` inside a fixture transcript, an expected
    // `filePath` in an assertion. Nothing opens them, so they cannot collide,
    // and flagging them held five suites out of the parallel group for text
    // that never touches a filesystem. A socket path assigned into the
    // environment, by contrast, is exactly the kind of shared name that does
    // collide, so the filter keeps those.
    require:
      /writeFile|readFile|mkdir|rmSync|rm\(|existsSync|createWriteStream|createReadStream|symlink|copyFile|appendFile|process\.env|SOCK|socket|cwd:\s*[^'"`]*(?:join|resolve)/,
    // `mkdtemp` takes a *prefix* and returns a unique directory, and a path
    // interpolated with the pid or a random suffix is already unique per run.
    // Neither can collide, so neither forces a suite to run alone.
    allow: /mkdtemp|\$\{[^}]*(?:process\.pid|Math\.random|Date\.now|randomUUID)/,
  },
  {
    id: 'host-environment-passthrough',
    // Any wholesale copy of the host environment, however it is spelled.
    //
    // This began as `env:\s*\{\s*\.\.\.process\.env`, which was wrong twice
    // over. The spread is almost never on the same line as the `env:` that
    // carries it, and rules ran a line at a time, so the rule matched nothing
    // at all. Anchoring it to `env:` then still missed
    // `const brokerEnv = { ...process.env }` two hundred lines above the spawn
    // that used it. What makes a suite unsafe is copying the host environment,
    // not where the copy is written, so the spread itself is the rule.
    //
    // `process.env.PATH` and friends are reads of one variable, not a copy of
    // all of them, and do not match.
    pattern: /\.\.\.process\.env\b/,
  },
  {
    id: 'shared-repo-output',
    // Writing a fixed path under output/ collides with a concurrent writer.
    pattern: /['"`]output\/[A-Za-z0-9._\/-]+/,
  },
];

/**
 * Suites the source audit clears but observation does not.
 *
 * Static rules can prove a suite owns its ports and paths. They cannot prove it
 * tolerates a loaded host, and a suite that waits a fixed number of seconds for
 * a broker to become healthy will fail when several brokers boot at once. These
 * were each demonstrated flaky by `--repeat 3` against the parallel group, so
 * they stay serial until their readiness waits stop being wall-clock bets.
 */
const EMPIRICALLY_SERIAL: Record<string, string> = {
  // `history-paging-wire` was demoted here for a fixed 15s broker-health
  // deadline. It now waits through `waitForBrokerHealth`, which returns as soon
  // as the broker answers and fails as soon as it dies, so that demotion is
  // gone rather than merely raised.
  'real-evidence-schema':
    'wedged before printing anything and hit the 180s suite timeout in 1 of 3 '
    + 'concurrent runs; the suite only reads three workflow files and writes a '
    + 'temp dir, so nothing in it can block that long — cause not identified, '
    + 'and it costs ~50ms to run serially',
};

/**
 * Sub-suites that run an external tool rather than a harness in this repo.
 *
 * There is no closure to walk for these, so the lint has nothing to say about
 * them and they can never be eligible. That is a permanent, correct state
 * rather than a gap to fix, so it must not read as an unresolved entry point.
 */
const EXTERNAL_TOOL_SUITES: Record<string, string> = {
  typecheck: 'runs `tsc --build`, which is not a repo harness',
};

/** Local (in-repo) import specifiers only; packages are read-only. */
function localImports(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:from|import)\s+['"](\.[^'"]+)['"]/g,
    /import\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveImport(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) return candidate;
  }
  return undefined;
}

/** Every in-repo file a suite can execute, starting from its entry points. */
function importClosure(entryPoints: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entryPoints];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of localImports(source)) {
      const resolved = resolveImport(file, specifier);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

const packageScripts: Record<string, string> =
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};

/**
 * Turn a sub-suite command into the repo files it runs.
 *
 * Commands are either `bun run <path>` or `bun run <package-script>`, and a
 * package script can chain several entry points with `&&`.
 */
function entryPointsFor(command: string[]): string[] {
  const expand = (text: string, depth: number): string[] => {
    if (depth > 4) return [];
    const paths = [...text.matchAll(/(scripts\/[A-Za-z0-9._\/-]+\.(?:ts|mjs))/g)]
      .map((match) => join(ROOT, match[1]));
    if (paths.length > 0) return paths;
    return [...text.matchAll(/(?:bun|npm)\s+run\s+([A-Za-z0-9:_-]+)/g)]
      .flatMap((match) =>
        packageScripts[match[1]] ? expand(packageScripts[match[1]], depth + 1) : []
      );
  };
  return [...new Set(expand(command.join(' '), 0))];
}

/**
 * Apply every rule to a whole file, rather than to one line at a time.
 *
 * Line-at-a-time scanning cannot see a hazard that is spelled across two
 * lines, and the most common one in this harness — an object literal opened on
 * one line and spread on the next — is exactly that shape. Matching the full
 * source makes a rule's own pattern decide how far it reaches; the line number
 * is recovered from the match offset so findings still point somewhere.
 *
 * Exported for the audit's own tests: a rule that silently matches nothing is
 * the failure this function exists to prevent, so it has to be callable
 * against known-hazardous text.
 */
export function scanSource(source: string, displayPath: string): Hazard[] {
  const found: Hazard[] = [];
  // Prefix lengths, so an offset becomes a line number without rescanning.
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') lineStarts.push(index + 1);
  }
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const lines = source.split('\n');

  for (const rule of RULES) {
    const pattern = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`,
    );
    for (const match of source.matchAll(pattern)) {
      const text = match[0];
      const index = lineAt(match.index ?? 0);
      // A hazard written inside a comment is prose about a hazard. The test is
      // the line the match *starts* on, which is where a `//` or a jsdoc `*`
      // would be; a multiline match that begins in code is real regardless of
      // what it crosses.
      const startLine = (lines[index] ?? '').trim();
      if (startLine.startsWith('*') || startLine.startsWith('//')) continue;
      // `require` and `allow` ask about the *surrounding* code, not the match:
      // `fixed-temp-path` matches a bare path literal and then asks whether
      // anything opens it. So they see every line the match touches.
      const context = lines
        .slice(index, lineAt((match.index ?? 0) + Math.max(text.length - 1, 0)) + 1)
        .join('\n');
      if (rule.require && !rule.require.test(context)) continue;
      if (rule.allow?.test(context)) continue;
      found.push({
        rule: rule.id,
        file: displayPath,
        line: index + 1,
        text: text.replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
  }
  return found.sort((left, right) => left.line - right.line);
}

export function auditSubSuites(): SuiteAudit[] {
  const graph = loadVerificationGraph(ROOT);
  const gate = graph.gates.find((item) => item.id === 'broker-deterministic');
  if (!gate?.subSuites) throw new Error('broker-deterministic declares no sub-suites');
  return gate.subSuites.map((suite) => {
    const entryPoints = entryPointsFor(suite.command);
    const closure = importClosure(entryPoints);
    // Only the harness is audited, not the product it drives.
    //
    // Production source is full of literals like `http://127.0.0.1:7734` and
    // `http://127.0.0.1:4096`. Those are *defaults*, chosen only when nothing
    // supplies a port — and the fixture environment always does. Scanning them
    // marked almost every suite unsafe for code no suite actually binds. What
    // decides whether two suites collide is what the harness itself picks.
    const harness = closure.filter((file) =>
      file.slice(ROOT.length + 1).startsWith('scripts/')
    );
    const hazards: Hazard[] = [];
    if (EMPIRICALLY_SERIAL[suite.id]) {
      hazards.push({
        rule: 'observed-flaky-under-load',
        file: entryPoints[0]?.slice(ROOT.length + 1) ?? '<unresolved>',
        line: 0,
        text: EMPIRICALLY_SERIAL[suite.id],
      });
    }
    const harnessSource = harness
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    // A harness that starts a *listener* but never leases a port from the OS is
    // relying on a default, and two of those cannot coexist.
    //
    // Spawning alone does not qualify. Plenty of these harnesses shell out to a
    // one-shot CLI that binds nothing, and treating every `spawnSync` as a
    // server kept suites serial for processes that never opened a socket. What
    // matters is starting the broker, or a server of our own.
    const startsListener =
      /broker\/src\/(?:main|cli)\.ts|createServer|Bun\.serve|\bserve\(/
        .test(harnessSource);
    // A Unix socket is not a port. A harness that only ever listens on a path
    // it built under its own temp directory cannot collide with a second run,
    // and demanding a port lease from it was asking for the wrong resource.
    const listensOnPathOnly =
      /listen\((?:[^)]*\b(?:SOCK|sock|socketPath)\b)/.test(harnessSource)
      && !/listen\(\s*(?:\d|port|PORT)/.test(harnessSource);
    if (startsListener && !listensOnPathOnly
        && !/reserveLoopbackFixturePort|listen\(\s*0\b|port:\s*0\b/.test(harnessSource)) {
      hazards.push({
        rule: 'unleased-port',
        file: harness[0]?.slice(ROOT.length + 1) ?? '<unresolved>',
        line: 0,
        text: 'harness starts a process or server without leasing a port',
      });
    }
    for (const file of harness) {
      const source = readFileSync(file, 'utf8');
      for (const hazard of scanSource(source, file.slice(ROOT.length + 1))) {
        hazards.push(hazard);
      }
    }
    return {
      id: suite.id,
      entryPoints: entryPoints.map((path) => path.slice(ROOT.length + 1)),
      closureSize: harness.length,
      // A suite whose entry point could not be resolved has not been audited,
      // so it is not eligible either.
      eligible: hazards.length === 0 && entryPoints.length > 0,
      hazards,
    };
  });
}

/**
 * Fail if the inventory's parallel group claims more than the lint cleared.
 *
 * Without this the audit was advisory: the lane read a hand-written list in the
 * graph, and nothing compared the two. They agreed only because the same person
 * had just edited both.
 */
export function membershipErrors(audits: SuiteAudit[]): string[] {
  const graph = loadVerificationGraph(ROOT);
  const gate = graph.gates.find((item) => item.id === 'broker-deterministic');
  const parallel = new Set(
    (gate?.subSuiteGroups ?? [])
      .filter((group) => group.mode === 'parallel')
      .flatMap((group) => group.subSuites),
  );
  const byId = new Map(audits.map((audit) => [audit.id, audit]));
  const errors: string[] = [];
  for (const id of [...parallel].sort()) {
    const audit = byId.get(id);
    if (!audit) {
      errors.push(`parallel group claims unknown sub-suite ${id}`);
      continue;
    }
    if (EMPIRICALLY_SERIAL[id]) {
      errors.push(
        `parallel group claims ${id}, demoted by observation: ${EMPIRICALLY_SERIAL[id]}`,
      );
      continue;
    }
    if (!audit.eligible) {
      const reasons = [...new Set(audit.hazards.map((hazard) => hazard.rule))];
      errors.push(`parallel group claims ineligible ${id}: ${reasons.join(', ')}`);
    }
  }
  // An unresolved entry point means the lint never read that suite at all, so
  // its verdict — for any group — is not evidence of anything. Suites that run
  // an external tool have no harness to resolve and are exempt by name.
  for (const audit of audits) {
    if (audit.entryPoints.length === 0 && !EXTERNAL_TOOL_SUITES[audit.id]) {
      errors.push(`sub-suite ${audit.id} has no resolvable entry point to audit`);
    }
  }
  return errors.sort();
}

if (import.meta.main) {
  const jsonIndex = process.argv.indexOf('--json');
  const audits = auditSubSuites();
  if (process.argv.includes('--check')) {
    const errors = membershipErrors(audits);
    for (const error of errors) console.error(`FAIL: ${error}`);
    if (errors.length > 0) {
      console.error(
        `FAIL suite-isolation: ${errors.length} inventory/audit disagreement(s)`,
      );
      process.exit(1);
    }
    const parallel = audits.filter((audit) => audit.eligible).length;
    console.log(
      `PASS suite-isolation: every parallel sub-suite is audit-eligible `
        + `(${parallel}/${audits.length} eligible)`,
    );
    process.exit(0);
  }
  const eligible = audits.filter((audit) => audit.eligible);
  for (const audit of audits) {
    const reasons = [...new Set(audit.hazards.map((hazard) => hazard.rule))];
    console.log(
      `${audit.eligible ? 'PARALLEL' : 'SERIAL  '}  ${audit.id}`
        + (reasons.length > 0 ? ` — ${reasons.join(', ')}` : '')
        + (audit.entryPoints.length === 0 ? ' — entry point unresolved' : ''),
    );
  }
  console.log(
    `\n${eligible.length}/${audits.length} sub-suites are isolation-eligible`,
  );
  if (jsonIndex !== -1 && process.argv[jsonIndex + 1]) {
    const path = resolve(process.argv[jsonIndex + 1]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ audits }, null, 2)}\n`);
    console.log(`JSON: ${path}`);
  }
}
