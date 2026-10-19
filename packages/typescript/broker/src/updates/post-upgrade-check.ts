import type { CliPaint } from '../cli/cli-i18n.ts';

/**
 * What `cosy update` confirms once the upgrade itself is over: that the broker service is running and
 * answering, and whether anything setup installed is now behind the build that is installed.
 *
 * Every question goes to the INSTALLED binary, never to the process running the update. After a switch that
 * process is the previous release, so its idea of the expected service definition and of the packaged skill
 * and bridge bytes is the previous release's; only the new binary can say whether they still match. The
 * children are the same `doctor`, `start` and `status --readiness` an operator would type, run with the
 * operator's own environment, so whatever they refuse here they would refuse at the prompt.
 *
 * Nothing here re-runs setup. Setup asks for consent (managed runtimes, the Claude mod, the opencode route,
 * Tokdash), and an update that replayed those answers or asked them again would be a different command.
 * Starting the service the operator already installed needs no new answer, so that much an update does.
 */

export type UpgradeProgressStep =
  | 'downloading'
  | 'restarting'
  | 'verifying'
  | 'refreshing-claude-mod'
  | 'checking-service'
  | 'starting-service'
  | 'waiting-for-broker'
  | 'checking-setup';

export interface UpgradeProgressEvent {
  step: UpgradeProgressStep;
  /** The release the step is about, where it is about one. */
  version?: string;
}

export interface BrokerCheckOutcome {
  /**
   * `ready`: running and answering. `started`: it was stopped and this run started it. `not-ready` and
   * `start-failed`: running, or just started, but not answering. `start-refused`: `start` refused, as it
   * does for a drifted definition. `disabled`: the operator disabled the service, so it was left alone.
   * `unknown`: the service state could not be read.
   */
  status: 'ready' | 'started' | 'not-ready' | 'start-refused' | 'start-failed' | 'disabled' | 'unknown';
  detailCode: string;
  summary: string;
}

export interface SetupCheckItem {
  id: string;
  detailCode: string;
  summary: string;
  command?: string;
}

export interface SetupCheckOutcome {
  status: 'current' | 'recommended' | 'unavailable';
  detailCode: string;
  items: SetupCheckItem[];
}

type RunBinary = (
  executable: string,
  args: readonly string[],
  timeoutMs?: number,
  env?: Readonly<Record<string, string>>,
) => Promise<{ status: 'ok' | 'error' | 'timeout' | 'unavailable'; exitCode?: number; stdout: string; stderr: string }>;

/**
 * Doctor findings an update can leave behind that only setup or repair puts right: packaged copies an
 * earlier setup wrote and this build now ships newer, and service files that no longer match what this
 * build would write. Everything else doctor reports -- an agent that is not installed, a managed host still
 * starting -- has nothing to do with the update and stays in `cosy doctor`.
 */
const SETUP_REFRESH_DETAIL_CODES: ReadonlySet<string> = new Set([
  'agent-skill-stale',
  'bridge-owned-stale',
  'runtime-path-drifted',
  'service-agent-path-stale',
  'broker-service-definition-invalid',
]);

const DOCTOR_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 60_000;
/** `status --readiness` waits up to 30s for the broker's own identity; this bounds the child around it. */
const READINESS_TIMEOUT_MS = 45_000;

interface CheckOptions {
  /** The installed binary, behind the runtime that executes it when it is a JavaScript bundle. */
  launch: readonly string[];
  runBinary: RunBinary;
  env: Readonly<Record<string, string | undefined>>;
  /** Absent in foreground mode, where the operator runs the broker and there is no service to check. */
  service?: { inspect(): Promise<{ active: boolean; enabled?: boolean }> };
  /** True when this run restarted the service itself and saw the expected version answer. */
  healthVerified: boolean;
  version: string;
  url?: string;
  progress?: (event: UpgradeProgressEvent) => void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function runJson(options: CheckOptions, args: readonly string[], timeoutMs: number): Promise<{ ok: boolean; json: unknown }> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.env)) if (typeof value === 'string') env[name] = value;
  try {
    const ran = await options.runBinary(options.launch[0] as string, [...options.launch.slice(1), ...args], timeoutMs, env);
    let json: unknown;
    try { json = JSON.parse(ran.stdout); } catch { /* a child that printed nothing parseable answered nothing */ }
    return { ok: ran.status === 'ok', json };
  } catch {
    return { ok: false, json: undefined };
  }
}

async function answering(options: CheckOptions): Promise<boolean> {
  options.progress?.({ step: 'waiting-for-broker', version: options.version });
  const readiness = await runJson(options, ['status', '--readiness', '--json'], READINESS_TIMEOUT_MS);
  return readiness.ok && record(readiness.json)?.ok === true;
}

async function checkService(options: CheckOptions): Promise<BrokerCheckOutcome | undefined> {
  if (!options.service) return undefined;
  const at = options.url ? ` at ${options.url}` : '';
  const ready: BrokerCheckOutcome = {
    status: 'ready',
    detailCode: 'broker-check-ready',
    summary: `cosyncing ${options.version} is running and answering${at}.`,
  };
  // The transaction already stopped, switched, started and polled this exact version; asking again would
  // only repeat the answer it just got.
  if (options.healthVerified) return ready;
  options.progress?.({ step: 'checking-service' });
  let state: { active: boolean; enabled?: boolean };
  try { state = await options.service.inspect(); }
  catch {
    return { status: 'unknown', detailCode: 'broker-check-service-unreadable',
      summary: 'The broker service state could not be read; run cosyncing status.' };
  }
  if (state.active) {
    return await answering(options) ? ready : {
      status: 'not-ready',
      detailCode: 'broker-check-not-answering',
      summary: `The broker service is running, but cosyncing ${options.version} did not answer${at}; run cosyncing logs.`,
    };
  }
  if (state.enabled === false) {
    return { status: 'disabled', detailCode: 'broker-check-service-disabled',
      summary: 'The broker service is disabled, so it was left stopped; run cosyncing start to start it.' };
  }
  // Stopped but installed and enabled: something stopped it, and the operator who just asked for an update
  // expects a working broker at the end of it. `start` keeps its own refusal of a drifted definition.
  options.progress?.({ step: 'starting-service' });
  const started = await runJson(options, ['start', '--json'], START_TIMEOUT_MS);
  const startReport = record(started.json);
  if (!started.ok || startReport?.status !== 'complete') {
    const reason = text(startReport?.summary);
    return startReport?.status === 'blocked'
      ? { status: 'start-refused', detailCode: text(startReport.detailCode) ?? 'broker-check-start-refused',
        summary: `The broker service is stopped and was not started.${reason ? ` ${reason}` : ''}` }
      : { status: 'start-failed', detailCode: text(startReport?.detailCode) ?? 'broker-check-start-failed',
        summary: 'The broker service is stopped and could not be started; run cosyncing logs.' };
  }
  return await answering(options)
    ? { status: 'started', detailCode: 'broker-check-started',
      summary: `The broker service was stopped, so it was started: cosyncing ${options.version} is answering${at}.` }
    : { status: 'start-failed', detailCode: 'broker-check-not-answering',
      summary: `The broker service was started, but cosyncing ${options.version} did not answer${at}; run cosyncing logs.` };
}

async function checkSetup(options: CheckOptions): Promise<SetupCheckOutcome> {
  options.progress?.({ step: 'checking-setup' });
  // Doctor exits 1 whenever any check fails, which on a real host is most of the time, so the exit status
  // says nothing here; the report is the answer.
  const doctor = await runJson(options, ['doctor', '--json'], DOCTOR_TIMEOUT_MS);
  const sections = record(doctor.json)?.sections;
  if (!Array.isArray(sections)) return { status: 'unavailable', detailCode: 'setup-check-unavailable', items: [] };
  const items = sections
    .flatMap((section) => Array.isArray(record(section)?.checks) ? record(section)!.checks as unknown[] : [])
    .flatMap((candidate): SetupCheckItem[] => {
      const check = record(candidate);
      const id = text(check?.id);
      const detailCode = text(check?.detailCode);
      const summary = text(check?.summary);
      if (!id || !detailCode || !summary || !SETUP_REFRESH_DETAIL_CODES.has(detailCode)) return [];
      if (check?.status !== 'warn' && check?.status !== 'fail') return [];
      const command = text(record(check.remediation)?.command);
      return [{ id, detailCode, summary, ...(command ? { command } : {}) }];
    });
  return items.length > 0
    ? { status: 'recommended', detailCode: 'setup-refresh-recommended', items }
    : { status: 'current', detailCode: 'setup-current', items: [] };
}

/** Ask the installed binary whether its broker is running and whether setup has anything to refresh. */
export async function checkInstalledBroker(options: CheckOptions): Promise<{
  brokerCheck?: BrokerCheckOutcome;
  setupCheck: SetupCheckOutcome;
}> {
  const brokerCheck = await checkService(options);
  const setupCheck = await checkSetup(options);
  return { ...(brokerCheck ? { brokerCheck } : {}), setupCheck };
}

/** The line a human sees as each step starts, so a long update never sits silent. */
export function upgradeProgressText(event: UpgradeProgressEvent): string {
  const version = event.version ? ` ${event.version}` : '';
  switch (event.step) {
    case 'downloading': return `Downloading and verifying cosyncing${version}…`;
    case 'restarting': return `Switching the broker service to${version}…`;
    case 'verifying': return `Waiting for cosyncing${version} to answer…`;
    case 'refreshing-claude-mod': return 'Refreshing the cosyncing Claude mod…';
    case 'checking-service': return 'Checking the broker service…';
    case 'starting-service': return 'The broker service is stopped; starting it…';
    case 'waiting-for-broker': return `Waiting for cosyncing${version} to answer…`;
    case 'checking-setup': return 'Checking whether setup has anything to refresh…';
  }
}

/** What `cosy update` prints after its summary: the broker's state in green or red, then any setup notice. */
export function renderPostUpgradeChecks(
  result: { brokerCheck?: BrokerCheckOutcome; setupCheck?: SetupCheckOutcome },
  paint: CliPaint,
): string[] {
  const lines: string[] = [];
  const broker = result.brokerCheck;
  if (broker) {
    const tone = broker.status === 'ready' || broker.status === 'started'
      ? 'pass'
      : broker.status === 'disabled' || broker.status === 'unknown' ? 'warn' : 'fail';
    lines.push(paint(tone, broker.summary));
  }
  if (result.setupCheck?.status === 'recommended') {
    lines.push(paint('warn', 'Setup recommended: this update left these out of date.'));
    for (const item of result.setupCheck.items) {
      lines.push(`  - ${item.summary}${item.command ? ` Run ${paint('warn', item.command)}.` : ''}`);
    }
  }
  return lines;
}
