/**
 * Best-effort provisioning of a local Tokdash, so the quota consent can mean something on a host that has
 * never heard of Tokdash.
 *
 * Round 8 shipped copy saying "cosyncing never installs or starts Tokdash", which was true and useless: the
 * operator said yes to quota warnings and got none, forever, with no indication that anything else was
 * required. Round 10 reverses that decision. Consent now means "poll a Tokdash, and set one up if there is
 * none", and this module owns the second half.
 *
 * ## Why this runs AFTER the transaction commits, not inside it
 *
 * The setup transaction is all-or-nothing: any action that fails rolls the whole plan back to its journaled
 * pre-state. Tokdash is optional, so a failure to install it must never undo a broker install that is
 * otherwise complete and verified — the operator would lose a working setup over a quota dashboard. Nor can
 * this be an action that "fails softly": the transaction's rollback machinery snapshots FILES, and what is
 * mutated here belongs to pipx and to Tokdash's own service manager, which cosyncing cannot snapshot or
 * restore without owning their internals. So provisioning runs once the receipts are committed, reports its
 * own outcome explicitly rather than throwing, and records ownership so uninstall can reverse exactly what
 * it did.
 *
 * ## What ownership means here
 *
 * Two independent facts, because they reverse differently: whether cosyncing ran `pipx install tokdash`, and
 * whether cosyncing ran `tokdash setup` to create the managed background service. A pre-existing Tokdash —
 * reachable at the configured URL, or already installed on PATH — is reused and never touched, and uninstall
 * then has nothing to reverse. This is the same shape as the managed Codex daemon: prove ownership or leave
 * it alone.
 *
 * ## What a rerun decides from, and why it is not a stage list
 *
 * Round 13 answered "what may this rerun skip" from a `tokdashProgress` note listing stages already done.
 * The note was written best-effort, and a lost one did not cost "one repeated stage" as its comment claimed:
 * the retry gate read owned-resources-with-no-note as COMPLETE, so a failed note after a successful
 * `tokdash setup` disabled every future retry and left quota consent off permanently. A note that was
 * malformed or partial was worse than lost — a record naming only `consent` suppressed the consent step with
 * no evidence that it had ever run.
 *
 * So there is no stage list. Each decision reads evidence that cannot silently go missing:
 *
 * - install — skipped when `tokdash` resolves on PATH (a live host fact) or when OWNERSHIP records that
 *   cosyncing installed it. Ownership writes are fatal-and-compensating: a mutation whose record will not
 *   persist is reversed, so ownership can be trusted in a way a best-effort note never could.
 * - service — skipped when ownership records that cosyncing created one.
 * - consent — never skipped on stored evidence, because no host fact distinguishes a consented instance from
 *   an unconsented one. Instead a positive {@link TokdashCompletion} marker is written at the very end, once
 *   consent AND the health probe have both succeeded, and its ABSENCE is what makes a rerun evaluate Tokdash
 *   at all. A marker write that fails costs one repeated `tokdash quota consent`, which is idempotent.
 *
 * Every one of those failure directions points at "do the work again", which is the direction that converges.
 *
 * ## Upstream facts this depends on (tokdash 1.5.7)
 *
 * - Published to PyPI as `tokdash`; `pipx install tokdash` is its own documented install path.
 * - `tokdash setup --auto --yes` is the non-interactive onboarding wizard. It creates a reversible user-level
 *   background service (systemd user unit on Linux, launchd on macOS) and starts it. That is the tool's own
 *   intended way to run in the background, so it is what cosyncing invokes rather than spawning a child the
 *   broker would then have to supervise.
 * - `--auto` deliberately SKIPS Tokdash's quota prompt — a scripted setup must never silently enable a
 *   network-calling feature. Quota tracking is therefore enabled as a separate, explicit step:
 *   `tokdash quota consent --enabled on --credential-scan on ...`, which is exactly the consent the cosyncing
 *   wizard just collected and is the only thing that makes `GET /api/quota` return anything to warn about.
 * - `GET /health` answers `{"status":"ok","service":"tokdash",...}`. The `service` field is documented as a
 *   fingerprint so a port probe can tell Tokdash from anything else that happens to hold 55423.
 * - `setup` accepts `--bind` and `--port` and honours them: `cli.py` exposes both to the lifecycle verbs,
 *   `onboard/plan.py` resolves `opts.port or DEFAULT_PORT`, and the address it lands on is written straight
 *   into the service it creates (`serve --bind <bind> --port <port> --no-open`). So a `COSYNCING_TOKDASH_URL`
 *   that only moves the loopback port is provisionable at that port rather than at the default. What Tokdash
 *   does NOT do is terminate TLS — `serve` speaks plain HTTP — so an `https://` override names an endpoint it
 *   will never answer as, and that is reported instead of quietly provisioned somewhere else.
 */
import { spawn } from 'node:child_process';
import type { SetupDiagnosisContext } from '@cosyncing/adapter-api';
import type { TokdashEndpoint } from './tokdash-quota.ts';

/** The PyPI distribution and the console script it installs. Both are `tokdash`. */
export const TOKDASH_PACKAGE = 'tokdash';

/**
 * Providers cosyncing turns on. These are the two agents cosyncing itself tracks quota for
 * ({@link ./tokdash-quota.ts} only evaluates `codex` and `claude` buckets), so enabling more would be
 * consenting on the operator's behalf to network calls nothing here would ever read.
 */
const TOKDASH_QUOTA_PROVIDERS = ['--codex-api', '--claude-api'] as const;

/** Tokdash's own default; kept explicit so a change upstream cannot silently alter what cosyncing asks for. */
const TOKDASH_POLL_INTERVAL_MINUTES = '30';

const INSTALL_TIMEOUT_MS = 180_000;
const SETUP_TIMEOUT_MS = 120_000;
const CONSENT_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 3_000;

/**
 * Per-stream retention cap. `pipx install` gets three minutes, and a resolver stuck in a retry loop can emit
 * megabytes of it; none of that is read except the last non-blank line ({@link failureDetail}). Keeping a
 * tail bounds what an unattended setup can be made to hold while still carrying a whole traceback.
 */
export const TOKDASH_OUTPUT_TAIL_CHARS = 64 * 1024;
/** How long a timed-out child gets to handle SIGTERM before the hard kill. */
const TERM_GRACE_MS = 2_000;
/**
 * Backstop after SIGKILL. Waiting for the real exit is the point — a resolved promise must never mean a
 * child still alive and still holding the port — but a process the kernel will not reap (uninterruptible
 * I/O) must not hang setup forever, so reporting the failure eventually beats never returning.
 */
const KILL_GRACE_MS = 10_000;

/**
 * What cosyncing did, recorded so uninstall reverses that and nothing else.
 *
 * Both flags are false for a reused instance, which is the case that must leave no trace at all.
 *
 * Each fact is persisted the instant its mutation succeeds, not once at the end. The end is too late: a
 * process killed between `pipx install` and the final write leaves an install nothing proves cosyncing made,
 * which uninstall must then preserve forever.
 */
export interface TokdashOwnership {
  /** cosyncing ran `pipx install tokdash`; uninstall may run `pipx uninstall tokdash`. */
  installedByBroker: boolean;
  /** cosyncing ran `tokdash setup`; uninstall may run `tokdash uninstall` to remove the service it created. */
  serviceStartedByBroker: boolean;
  /** When this record was last written — it is rewritten as each fact lands, not stamped once. */
  recordedAt: string;
}

/**
 * Provisioning finished at this endpoint: consent issued, and the instance answered.
 *
 * Written once, at the end, and never consulted to skip a mutation — the mutations decide for themselves
 * from ownership and from what is on the host. All this marker gates is whether a rerun evaluates Tokdash
 * at all, and its absence is what makes it evaluate.
 */
export interface TokdashCompletion {
  baseUrl: string;
  completedAt: string;
}

/**
 * The endpoint this outcome is about, carried so every surface that reports it names the URL that was
 * actually probed and provisioned rather than re-deriving one and risking a different answer.
 */
interface TokdashProvisionEndpoint {
  baseUrl: string;
}

export type TokdashProvisionOutcome = TokdashProvisionEndpoint & (
  /** An instance was already answering; nothing was installed, started, or configured. */
  | { status: 'reused' }
  /** cosyncing installed and/or started one, and it answers now. */
  | { status: 'provisioned'; ownership: TokdashOwnership }
  /** Consent was off, so nothing was attempted. */
  | { status: 'skipped' }
  /** Nothing usable happened. `ownership` is present when a partial install still needs reversing. */
  | { status: 'unavailable'; reason: TokdashProvisionFailure; detail: string; ownership?: TokdashOwnership }
);

export type TokdashProvisionFailure =
  | 'pipx-missing'
  | 'install-failed'
  | 'service-failed'
  | 'consent-failed'
  /** A mutation succeeded but its ownership record could not be written, so the mutation was reversed. */
  | 'record-failed'
  /** The requested endpoint is not one Tokdash can be set up on; nothing was attempted. */
  | 'endpoint-unsupported'
  | 'not-answering';

export interface TokdashCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Mutating command seam. {@link SetupDiagnosisContext} is `effects: 'forbidden'` and cannot carry these. */
export type TokdashCommandRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<TokdashCommandResult>;

/** Retains only the last {@link TOKDASH_OUTPUT_TAIL_CHARS} characters of a stream, draining the rest. */
function boundedTail(): { push: (chunk: Buffer) => void; readonly value: string } {
  let text = '';
  return {
    push(chunk: Buffer): void {
      text += chunk.toString('utf8');
      if (text.length > TOKDASH_OUTPUT_TAIL_CHARS) text = text.slice(-TOKDASH_OUTPUT_TAIL_CHARS);
    },
    get value(): string { return text; },
  };
}

/** Spawn without a shell; the arguments here are all constants, and none is ever operator-supplied. */
export const runTokdashCommand: TokdashCommandRunner = (executable, args, timeoutMs) =>
  new Promise((resolveResult) => {
    const stdout = boundedTail();
    const stderr = boundedTail();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let settled = false;
    let timedOut = false;
    const child = spawn(executable, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolveResult({ ok, stdout: stdout.value, stderr: stderr.value });
    };
    const after = (ms: number, action: () => void): void => { timers.push(setTimeout(action, ms)); };
    after(timeoutMs, () => {
      timedOut = true;
      // Escalate rather than SIGKILL outright: a child that can shut down cleanly gets the chance, and the
      // hard kill follows close enough behind that one that cannot still dies.
      child.kill('SIGTERM');
      after(TERM_GRACE_MS, () => {
        child.kill('SIGKILL');
        after(KILL_GRACE_MS, () => finish(false));
      });
    });
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', () => finish(false));
    // `close`, not `exit`: it fires once the child is gone AND both pipes have drained, so the tails
    // reported here are complete and a killed child never outlives the promise that reported it. The
    // timeout path deliberately does NOT resolve here — it waits for this.
    child.on('close', (code) => finish(!timedOut && code === 0));
  });

/**
 * Is a Tokdash answering at `baseUrl`?
 *
 * `/health` rather than `/api/quota`: the health route carries `service: "tokdash"`, which distinguishes it
 * from any other process that happens to hold the port. A generic `{"status":"ok"}` would not.
 */
export async function probeTokdash(
  context: SetupDiagnosisContext,
  baseUrl: string,
): Promise<boolean> {
  const probe = await context.fetchJson(`${baseUrl}/health`, undefined, HEALTH_TIMEOUT_MS);
  if (probe.status !== 'ok') return false;
  const body = probe.json as { service?: unknown } | undefined;
  return !!body && typeof body === 'object' && body.service === 'tokdash';
}

/**
 * The `tokdash setup` invocation that lands an instance on `endpoint`, or nothing when no invocation can.
 *
 * The default endpoint keeps the bare `setup --auto --yes` — Tokdash's own defaults are already that address,
 * and naming them adds a way for the two to drift. Anything else is stated explicitly, because provisioning
 * the default port while probing an overridden one is precisely the bug this replaces.
 */
export function tokdashSetupArgs(endpoint: TokdashEndpoint): readonly string[] | undefined {
  const base = ['setup', '--auto', '--yes'] as const;
  if (endpoint.isDefault) return base;
  let url: URL;
  try {
    url = new URL(endpoint.baseUrl);
  } catch {
    return undefined;
  }
  // `tokdash serve` speaks plain HTTP; it has no TLS to hand a certificate to, so https names something it
  // can never answer as. A path prefix is equally unservable — Tokdash mounts its API at the root.
  if (url.protocol !== 'http:' || (url.pathname !== '' && url.pathname !== '/')) return undefined;
  // Brackets are URL syntax for an IPv6 host, not part of the address a listener binds.
  const bind = url.hostname.replace(/^\[|\]$/g, '');
  return [...base, '--bind', bind, '--port', url.port || '80'];
}

export interface TokdashProvisionOptions {
  context: SetupDiagnosisContext;
  /** The one resolution of `COSYNCING_TOKDASH_URL`; probed, provisioned, and named in the outcome. */
  endpoint: TokdashEndpoint;
  /** The wizard's quota consent. False means nothing is attempted at all. */
  consented: boolean;
  /**
   * Persist the ownership record, called the moment each fact becomes true and before anything else runs.
   * Throwing means the fact is NOT durable, which is the whole reason this is a seam: the mutation it
   * describes is then reversed immediately rather than left behind with nothing to prove uninstall may
   * remove it. Setup must never report completion over external state no record covers.
   */
  recordOwnership: (ownership: TokdashOwnership) => void;
  /**
   * What is already recorded as owned. A resumed run adds to it rather than replacing it — recording the
   * service step alone would otherwise overwrite an earlier `pipx install` fact with `false` and strip
   * uninstall of its right to remove that install.
   */
  owned?: TokdashOwnership;
  /**
   * Persist the completion marker, called only once consent has been issued and the instance has answered.
   * Unlike {@link TokdashProvisionOptions.recordOwnership} a failure here is swallowed, and safely so: the
   * marker is positive evidence, so losing it means the next run repeats `tokdash quota consent` — the same
   * consent, with the same arguments, on an instance that already has it — and writes the marker again.
   */
  recordCompletion?: (completion: TokdashCompletion) => void;
  run?: TokdashCommandRunner;
  now?: () => Date;
}

/**
 * Reuse, or set one up. Never throws: every failure is a returned outcome, because the caller has already
 * committed a broker install that must survive this.
 */
export async function provisionTokdash(
  options: TokdashProvisionOptions,
): Promise<TokdashProvisionOutcome> {
  const baseUrl = options.endpoint.baseUrl;
  if (!options.consented) return { baseUrl, status: 'skipped' };
  // An instance answering is reusable — but only when cosyncing owns nothing here. A run that started the
  // service and then failed at consent leaves an instance that answers `/health` and reports no quota at
  // all; calling that "reused" is how the retry silently stopped finishing the job. Ownership is the right
  // question to ask because it is the record with fatal-and-compensating writes behind it: a mutation whose
  // ownership would not persist is reversed, so "no ownership" really does mean "cosyncing changed nothing".
  const ownsSomething = options.owned?.installedByBroker === true || options.owned?.serviceStartedByBroker === true;
  if (!ownsSomething && await probeTokdash(options.context, baseUrl)) return { baseUrl, status: 'reused' };

  // Checked before any mutation, and after the probe: something already answering there is still reusable,
  // whatever cosyncing could or could not have installed to make it so.
  const setupArgs = tokdashSetupArgs(options.endpoint);
  if (!setupArgs) {
    return {
      baseUrl,
      status: 'unavailable',
      reason: 'endpoint-unsupported',
      detail: `cosyncing cannot set up a Tokdash at ${baseUrl}: Tokdash serves plain HTTP from the root of a loopback port.`,
    };
  }

  const run = options.run ?? runTokdashCommand;
  const stamp = (): string => (options.now?.() ?? new Date()).toISOString();
  // Already on PATH but not answering: cosyncing did not install it, so it must not uninstall it either.
  // Only the service step below is ours in that case.
  const existingBinary = options.context.resolveExecutable(TOKDASH_PACKAGE);
  // Seeded from what is already recorded, not from nothing: a resumed run must add its facts to the earlier
  // ones rather than write a record that denies them.
  const ownership: TokdashOwnership = {
    installedByBroker: options.owned?.installedByBroker === true,
    serviceStartedByBroker: options.owned?.serviceStartedByBroker === true,
    recordedAt: stamp(),
  };
  /** Set one fact and persist it now. Returns the write's failure, having rolled the flag back, or nothing. */
  const record = (fact: 'installedByBroker' | 'serviceStartedByBroker'): string | undefined => {
    ownership[fact] = true;
    ownership.recordedAt = stamp();
    try {
      options.recordOwnership(ownership);
      return undefined;
    } catch (error) {
      ownership[fact] = false;
      return error instanceof Error ? error.message : String(error);
    }
  };

  // Skip the install when the package is already there — either because something on this host put it on
  // PATH, or because an earlier cosyncing run installed it and said so durably. Both are evidence a rerun
  // can trust: the first is the live host, the second is the record whose failed write undoes its own
  // mutation. Neither can go missing in a way that makes this run install over an install it already owns.
  if (!existingBinary && !ownership.installedByBroker) {
    const pipx = options.context.resolveExecutable('pipx');
    if (!pipx) {
      return {
        baseUrl,
        status: 'unavailable',
        reason: 'pipx-missing',
        // The same fix the prompt named, so what the operator was told up front and what they are told
        // afterwards agree. Rerunning setup is what finishes the job once pipx is there.
        detail: 'pipx is not installed, so Tokdash could not be installed automatically. Install pipx '
          + '(it needs Python 3.9+) — `sudo apt install pipx` on Ubuntu, `brew install pipx` on macOS — '
          + 'then run setup again.',
      };
    }
    const install = await run(pipx, ['install', TOKDASH_PACKAGE], INSTALL_TIMEOUT_MS);
    if (!install.ok) {
      return {
        baseUrl,
        status: 'unavailable',
        reason: 'install-failed',
        detail: failureDetail(`pipx install ${TOKDASH_PACKAGE}`, install),
      };
    }
    const unrecorded = record('installedByBroker');
    if (unrecorded) {
      // An install nothing proves cosyncing made is worse than no install: uninstall would have to preserve
      // it forever. Undo it now, and if even that fails, say exactly what is left and how to remove it.
      const undo = await run(pipx, ['uninstall', TOKDASH_PACKAGE], INSTALL_TIMEOUT_MS);
      return {
        baseUrl,
        status: 'unavailable',
        reason: 'record-failed',
        detail: undo.ok
          ? `Tokdash was installed, but recording that cosyncing installed it failed (${unrecorded}), so the install was undone.`
          : `Tokdash was installed, recording that cosyncing installed it failed (${unrecorded}), and undoing the install also failed — remove it with \`pipx uninstall ${TOKDASH_PACKAGE}\`.`,
      };
    }
  }

  const tokdash = options.context.resolveExecutable(TOKDASH_PACKAGE) ?? existingBinary;
  if (!tokdash) {
    // The pipx-PATH lag: `pipx install` succeeded, but its bin directory is not on this shell's PATH yet.
    // The install is recorded as owned, so the rerun that finds the command continues from here rather than
    // installing over a package cosyncing already owns.
    return {
      baseUrl,
      status: 'unavailable',
      reason: 'install-failed',
      detail: 'The tokdash command is still not on PATH after installing it. It usually appears in a new '
        + 'shell (or after `pipx ensurepath`); run setup again then and it will finish without reinstalling.',
      ownership,
    };
  }

  // Skip the service step when the record says cosyncing already created one. An owned service that is no
  // longer answering is NOT re-created, and neither is one whose endpoint has since moved: `tokdash setup`
  // is onboarding, not a repair, and re-running it over an installation cosyncing already owns is a
  // mutation with no stated idempotence — at a new `--bind`/`--port` it would silently relocate the one
  // service the operator has. The probe below reports the unanswered endpoint instead, every rerun, which
  // is a state an operator can act on (`uninstall` reverses the service, and setup then builds it afresh).
  if (!ownership.serviceStartedByBroker) {
    // Tokdash's own onboarding: it creates and starts the reversible user service. Preferring this over a
    // broker-spawned child means the instance survives reboots and logouts the way Tokdash intends, and
    // that `tokdash uninstall` is the exact reversal. The address comes from the resolved endpoint, so
    // what gets started is what gets probed.
    const setupLabel = `tokdash ${setupArgs.join(' ')}`;
    const setup = await run(tokdash, setupArgs, SETUP_TIMEOUT_MS);
    if (!setup.ok) {
      return { baseUrl, status: 'unavailable', reason: 'service-failed', detail: failureDetail(setupLabel, setup), ownership };
    }
    const unrecordedService = record('serviceStartedByBroker');
    if (unrecordedService) {
      // Same rule one step later, and only for this step: the pipx fact above is already durable, so its
      // record stays and uninstall can still reverse it.
      const undo = await run(tokdash, ['uninstall', '--yes'], SETUP_TIMEOUT_MS);
      return {
        baseUrl,
        status: 'unavailable',
        reason: 'record-failed',
        detail: undo.ok
          ? `Tokdash's service was started, but recording that cosyncing started it failed (${unrecordedService}), so the service was removed again.`
          : `Tokdash's service was started, recording that cosyncing started it failed (${unrecordedService}), and removing it again also failed — remove it with \`tokdash uninstall --yes\`.`,
        ...(ownership.installedByBroker ? { ownership } : {}),
      };
    }
  }

  // Always re-issued, never skipped on stored evidence. Consent is the one stage no host fact can attest to
  // — an instance that answers `/health` looks identical whether or not quota tracking is on — so it is the
  // stage the completion marker exists for, and reaching here means that marker is absent. Re-running it is
  // harmless: `quota consent --enabled on …` writes the same settings it wrote last time.
  //
  // `--auto` skips Tokdash's quota prompt on purpose, so a scripted setup cannot silently enable network
  // polling. The cosyncing wizard just asked for exactly that consent, so it is passed on explicitly here —
  // without it the instance runs and `GET /api/quota` reports nothing to warn about.
  const consent = await run(tokdash, [
    'quota', 'consent',
    '--enabled', 'on',
    '--credential-scan', 'on',
    ...TOKDASH_QUOTA_PROVIDERS.flatMap((flag) => [flag, 'on']),
    '--poll-interval', TOKDASH_POLL_INTERVAL_MINUTES,
  ], CONSENT_TIMEOUT_MS);
  if (!consent.ok) {
    return { baseUrl, status: 'unavailable', reason: 'consent-failed', detail: failureDetail('tokdash quota consent', consent), ownership };
  }

  if (!(await probeTokdash(options.context, baseUrl))) {
    return {
      baseUrl,
      status: 'unavailable',
      reason: 'not-answering',
      detail: `Tokdash was installed and started but ${baseUrl} did not answer as Tokdash.`,
      ownership,
    };
  }
  // Consent has been issued AND the instance answers as Tokdash. Only now is the marker true, and only now
  // is it written — a marker written any earlier would be the same lie the stage list told.
  try {
    options.recordCompletion?.({ baseUrl, completedAt: stamp() });
  } catch { /* absence means retry, and the retry is one more idempotent consent */ }
  return { baseUrl, status: 'provisioned', ownership };
}

/** One line, bounded, with the command named — a failure nobody can quote is a failure nobody can fix. */
function failureDetail(command: string, result: TokdashCommandResult): string {
  const output = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? 'no output';
  return `\`${command}\` failed: ${output.slice(0, 200)}`;
}

/**
 * Reverse ONLY what cosyncing provisioned. Never throws, for the same reason provisioning does not: a
 * third-party tool refusing to uninstall must not turn a broker uninstall into a failure.
 *
 * Each fact is dropped as its own reversal succeeds. Dropping both at the end instead would make a partial
 * failure unresumable: `tokdash uninstall` succeeding and `pipx uninstall` failing left both flags set, so
 * the retry re-ran the service removal that had already happened and could fail there again, never reaching
 * the step that actually remained.
 */
export async function reverseTokdashProvisioning(options: {
  context: SetupDiagnosisContext;
  ownership: TokdashOwnership;
  run?: TokdashCommandRunner;
  /**
   * Persist what is still owned after a reversal succeeds; `undefined` means nothing is, so clear the
   * record. Omitted by a purge, where the state root is deleted and any write would resurrect it.
   */
  onReversed?: (remaining: TokdashOwnership | undefined) => void;
}): Promise<{ removed: boolean; detail?: string }> {
  const run = options.run ?? runTokdashCommand;
  const tokdash = options.context.resolveExecutable(TOKDASH_PACKAGE);
  const remaining: TokdashOwnership = { ...options.ownership };
  const drop = (fact: 'installedByBroker' | 'serviceStartedByBroker'): void => {
    remaining[fact] = false;
    // Swallowed on purpose, unlike the provisioning side: the resource is gone either way, so a flag that
    // fails to clear costs at most one repeated removal of something that is already removed.
    try {
      options.onReversed?.(remaining.installedByBroker || remaining.serviceStartedByBroker ? remaining : undefined);
    } catch { /* a stale flag is a no-op next time, not a resource left behind */ }
  };
  if (options.ownership.serviceStartedByBroker) {
    if (!tokdash) return { removed: false, detail: 'the tokdash command is no longer on PATH' };
    // Tokdash owns its own service files and data; its uninstall is the exact reversal of its setup.
    const removal = await run(tokdash, ['uninstall', '--yes'], SETUP_TIMEOUT_MS);
    if (!removal.ok) return { removed: false, detail: failureDetail('tokdash uninstall --yes', removal) };
    drop('serviceStartedByBroker');
  }
  if (options.ownership.installedByBroker) {
    const pipx = options.context.resolveExecutable('pipx');
    if (!pipx) return { removed: false, detail: 'pipx is no longer on PATH' };
    const removal = await run(pipx, ['uninstall', TOKDASH_PACKAGE], INSTALL_TIMEOUT_MS);
    if (!removal.ok) return { removed: false, detail: failureDetail(`pipx uninstall ${TOKDASH_PACKAGE}`, removal) };
    drop('installedByBroker');
  }
  return { removed: true };
}
