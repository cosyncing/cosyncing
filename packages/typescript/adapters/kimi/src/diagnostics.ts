/**
 * Setup/doctor diagnosis for Kimi Code, itself EFFECT-FREE.
 *
 * Read-only describes this file, not the adapter: diagnosis probes paths and
 * answers questions, while the adapter can also drive the sessions it created
 * (see the write boundary in `implementation.ts`). What is stated here is only
 * what the diagnosis needs the installed Kimi to offer.
 *
 * Diagnosis never starts or stops a server, and never tells an operator to when
 * cosyncing is the one managing it. Starting one here would force-load sessions
 * a terminal may already own; instructing a manual start or restart where the
 * broker supervises the host races that supervision and leaves two servers on
 * one home. So every remediation that would start or restart the server follows
 * the posture the broker supplies — see {@link hostRemediation} — and only an
 * unmanaged install is handed a `kimi web` command.
 */
import { join } from 'node:path';
import {
  diagnoseBinaryVersion,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import {
  kimiServerTokenPath,
  resolveKimiHome,
  bindKimiServerIdentity,
  decodeKimiServerMeta,
  KIMI_DEFAULT_PORT,
  KIMI_INSTANCE_SCAN_MAX_FILES,
  type KimiIdentityBinding,
  type KimiInstanceScan,
} from './server.ts';

/**
 * What to tell an operator whose Kimi host is not running.
 *
 * The two answers are not stylistic variants; one of them is unsafe in the other
 * posture. Where cosyncing manages this host it starts one when none is running
 * and restarts a crashed one, so a manual `kimi web` races that recovery and
 * leaves two servers on one home — which cosyncing then refuses to guess
 * between (see the `ambiguous` refusal in `implementation.ts`). Where cosyncing
 * does NOT manage it, nothing else will start it and the command is the whole
 * answer.
 *
 * The posture comes from the broker through the context, because only the broker
 * can see the durable service configuration and the ownership record it is
 * derived from.
 */
/**
 * Says CONFIGURED TO MANAGE rather than "owns this server", deliberately.
 *
 * The posture is a fact about this machine's cosyncing, not about whichever
 * process happens to be answering right now — that one may well be the
 * operator's own, which cosyncing will preserve and never touch. A message
 * claiming ownership of it would be false exactly when a user is trying to work
 * out whose server they are looking at.
 */
const KIMI_MANAGED_HOST_REMEDIATION = 'cosyncing is configured to manage the Kimi host and will start or '
  + 'restart it. Wait for it to come back and rerun doctor; if it does not, check the cosyncing service '
  + 'and run `cosyncing repair`.';

/**
 * Is the home THIS diagnosis resolved one cosyncing manages here?
 *
 * The comparison is the whole point. The broker manages the home its own
 * environment resolves; doctor runs in an operator's shell, which may name a
 * different one through `KIMI_CODE_HOME`. Answering agent-wide would tell that
 * operator their private home is supervised when nothing is watching it — and
 * "nothing is watching it" is precisely when they need the manual instruction.
 */
function managedHere(context: SetupDiagnosisContext, home: string): boolean {
  return context.managedExternalHostIdentities?.includes(home) === true;
}

function hostRemediation(context: SetupDiagnosisContext, home: string): SetupCheck['remediation'] {
  // No command in the managed branch, and deliberately none: this is the message
  // whose whole purpose is to NOT hand the operator a way to start a competing
  // host.
  if (managedHere(context, home)) return { kind: 'manual', message: KIMI_MANAGED_HOST_REMEDIATION };
  return {
    kind: 'command',
    message: 'Start the Kimi local server, then rerun doctor.',
    command: 'kimi web --no-open',
  };
}

/**
 * The same choice for every check whose fix is "restart the server yourself".
 *
 * A manual restart is not the safer half of a manual start. Stopping the server
 * is what opens the window: the supervisor sees its host gone and starts a
 * replacement, and the operator — following the instruction to completion —
 * starts another. Two servers on one home, arrived at by doing exactly what
 * doctor said.
 *
 * The unmanaged wording is kept per check, because where nothing else will act
 * the specific instruction is the whole value of the remediation.
 */
function restartRemediation(
  context: SetupDiagnosisContext,
  home: string,
  unmanaged: string,
): SetupCheck['remediation'] {
  return { kind: 'manual', message: managedHere(context, home) ? KIMI_MANAGED_HOST_REMEDIATION : unmanaged };
}

export const KIMI_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: '0.35.0',
  requiredFeature: 'the `kimi web` local server REST `/api/v2/sessions` list and the `{seq, epoch}` WebSocket cursor protocol used for observe, plus the `/api/v1` session-create, prompt, approval, and question endpoints Drive writes through for sessions cosyncing created',
  evidenceUrl: 'https://moonshotai.github.io/kimi-code/en/guides/server.html',
  evidenceNote: 'Conservative floor: this repository captured its Kimi fixtures from a real 0.35.0 server (meta, session list, paged messages, snapshot, WS handshake). The server API is marked experimental upstream, so the floor is the exact tested version rather than an inferred earlier one.',
});

/** Fallback install location used by the official installer when the binary is not on PATH. */
function fallbackExecutable(homeDir: string): string {
  return join(homeDir, '.kimi-code', 'bin', 'kimi');
}

function storeCheck(context: SetupDiagnosisContext, home: string, binaryPresent: boolean): SetupCheck {
  const inspected = context.inspectPath(join(home, 'sessions'));
  if (inspected.status === 'directory' && inspected.readable) {
    return {
      id: 'kimi.store',
      status: 'pass',
      detailCode: 'store-readable',
      summary: 'Kimi Code session storage is readable.',
      evidence: { path: inspected.displayPath },
    };
  }
  if (inspected.status === 'missing') {
    return {
      id: 'kimi.store',
      status: binaryPresent ? 'warn' : 'skip',
      detailCode: 'store-missing',
      summary: 'Kimi Code session storage is not present yet.',
      evidence: { path: inspected.displayPath },
      ...(binaryPresent
        ? { remediation: { kind: 'manual' as const, message: 'Start Kimi Code once so it creates its session store.' } }
        : {}),
    };
  }
  return {
    id: 'kimi.store',
    status: 'fail',
    detailCode: inspected.status === 'unreadable' ? 'store-unreadable' : 'store-unsafe-type',
    summary: 'Kimi Code session storage is unreadable or has an unexpected type.',
    evidence: { path: inspected.displayPath },
    remediation: { kind: 'command', message: 'Repair the Kimi Code integration paths.', command: 'cosyncing repair' },
  };
}

function tokenCheck(context: SetupDiagnosisContext, home: string, serverPresent: boolean): SetupCheck {
  // The file's CONTENT is a secret and is never read here; only its presence and
  // type are diagnosed, so no diagnosis output can carry the bearer token.
  const inspected = context.inspectPath(kimiServerTokenPath(home));
  if (inspected.status === 'file' && inspected.readable) {
    return {
      id: 'kimi.server-token',
      status: 'pass',
      detailCode: 'server-token-present',
      summary: 'The Kimi server token file is present and readable.',
      evidence: { path: inspected.displayPath },
    };
  }
  return {
    id: 'kimi.server-token',
    status: serverPresent ? 'fail' : 'skip',
    detailCode: inspected.status === 'missing' ? 'server-token-missing' : 'server-token-unreadable',
    summary: inspected.status === 'missing'
      ? 'No Kimi server token file exists yet.'
      : 'The Kimi server token file is unreadable.',
    evidence: { path: inspected.displayPath },
    ...(serverPresent
      ? { remediation: restartRemediation(context, home, 'Restart `kimi web --no-open` so it writes a server token.') }
      : {}),
  };
}

export interface KimiDiagnosisOptions {
  /** Registry scan result; injected so diagnosis stays effect-free and deterministic. */
  instances?: KimiInstanceScan;
  /** Bearer token for the authenticated `/meta` probe. Never echoed into a check. */
  token?: string;
}

export async function diagnoseKimiSetup(
  context: SetupDiagnosisContext,
  options: KimiDiagnosisOptions = {},
): Promise<AgentSetupDiagnosis> {
  const home = resolveKimiHome(context.env, context.homeDir);
  // The official installer puts the binary in `~/.kimi-code/bin`, which is not
  // on a service PATH by default. An install that is present but off PATH is
  // INSTALLED, so the version probe runs against the absolute fallback path and
  // `kimi.binary` can genuinely pass. Reporting it as missing while
  // `kimi.server` passed was self-contradictory, and setup derives its agent
  // state from `kimi.binary`, so that contradiction became a `missing` summary
  // for a working install — backwards for K1, which needs only the user's
  // already-running server. `resolveExecutable` accepts an absolute path, so the
  // shared version logic (including the floor) is reused, not reimplemented.
  const fallbackPath = fallbackExecutable(context.homeDir);
  const onPath = context.resolveExecutable('kimi');
  const fallback = onPath ? undefined : context.inspectPath(fallbackPath);
  const usingFallback = !onPath && fallback?.status === 'file';
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'kimi',
    displayName: 'Kimi Code',
    command: usingFallback ? fallbackPath : 'kimi',
    versionArgs: ['--version'],
    minimum: KIMI_MINIMUM_VERSION,
    installMessage: 'Install Kimi Code, then rerun doctor.',
    upgradeCommand: 'kimi update',
  });
  const checks: SetupCheck[] = [...binary.checks];
  if (usingFallback && binary.executable) {
    // Advisory, not a contradiction: the install is usable now. This records the
    // PATH gap a broker-managed runtime would later have to propagate (K3).
    checks.push({
      id: 'kimi.binary-off-path',
      status: 'warn',
      detailCode: 'binary-off-path',
      summary: 'Kimi Code is installed at its default location, which is not on PATH.',
      evidence: { path: context.displayPath(fallbackPath) },
      remediation: { kind: 'manual', message: 'Add the Kimi Code bin directory to PATH so other tools can find it.' },
    });
  }
  checks.push(storeCheck(context, home, !!binary.executable));

  const scan = options.instances ?? { live: [], stale: 0, invalid: 0, truncated: false };
  // Fail closed on several live servers: they are not interchangeable (each owns
  // whichever sessions it has loaded), so naming one would be a guess presented
  // as a fact. The adapter refuses the same way — see resolveVerifiedInstance.
  const ambiguous = scan.live.length > 1;
  const instance = ambiguous || scan.truncated ? undefined : scan.live[0];
  checks.push(tokenCheck(context, home, !!instance || ambiguous || scan.truncated));

  if (scan.truncated) {
    // A truncated registry scan cannot prove which server exists, so naming
    // one — even a diagnosed-healthy one — would present a guess as a fact.
    // Same rule the adapter applies: see resolveVerifiedInstance.
    checks.push({
      id: 'kimi.server',
      status: 'fail',
      detailCode: 'server-registry-overflow',
      summary: 'The Kimi instance registry holds more records than diagnosis will examine, so no server can be identified safely.',
      evidence: { examinedCap: KIMI_INSTANCE_SCAN_MAX_FILES },
      remediation: {
        kind: 'manual',
        message: 'Remove stale records from the Kimi instance registry, then rerun doctor.',
      },
    });
    return { agent: 'kimi', displayName: 'Kimi Code', minimumVersion: KIMI_MINIMUM_VERSION, checks };
  }

  if (ambiguous) {
    checks.push({
      id: 'kimi.server',
      status: 'fail',
      detailCode: 'server-ambiguous',
      summary: 'Several Kimi servers are running on this home, so cosyncing cannot tell which one owns a session.',
      evidence: { liveInstances: scan.live.length },
      // Not a start or a restart, so it does not go through `restartRemediation`
      // — but it still cannot be posture-blind. Under management, "stop all but
      // one" could have an operator stop cosyncing's own server, which the
      // supervisor then restarts, leaving the ambiguity exactly where it was.
      // The one they can act on is the one they started.
      remediation: {
        kind: 'manual',
        message: managedHere(context, home)
          ? 'cosyncing is configured to manage the Kimi host and keeps one of its own. '
            + 'Stop the Kimi servers you started yourself, then rerun doctor.'
          : 'Stop all but one `kimi web` server for this Kimi home, then rerun doctor.',
      },
    });
    return { agent: 'kimi', displayName: 'Kimi Code', minimumVersion: KIMI_MINIMUM_VERSION, checks };
  }

  if (!instance) {
    checks.push({
      id: 'kimi.server',
      status: binary.executable || fallback?.status === 'file' ? 'warn' : 'skip',
      detailCode: scan.stale > 0 ? 'server-registry-stale' : 'server-not-running',
      summary: scan.stale > 0
        ? 'Only stale Kimi server records remain; no server is running.'
        : 'No local Kimi server is running.',
      evidence: { staleRecords: scan.stale, invalidRecords: scan.invalid, defaultPort: KIMI_DEFAULT_PORT },
      remediation: hostRemediation(context, home),
    });
    return { agent: 'kimi', displayName: 'Kimi Code', minimumVersion: KIMI_MINIMUM_VERSION, checks };
  }

  const health = await context.fetchJson(`${instance.baseUrl}/api/v1/healthz`);
  const healthy = health.status === 'ok'
    && (health.json as { data?: { ok?: unknown } } | undefined)?.data?.ok === true;
  if (!healthy) {
    checks.push({
      id: 'kimi.server',
      status: 'fail',
      detailCode: health.status === 'unreachable' ? 'server-unreachable' : 'server-health-unexpected',
      summary: 'A Kimi server is registered but does not answer its health contract.',
      evidence: { url: instance.baseUrl },
      remediation: restartRemediation(context, home, 'Restart `kimi web --no-open` and rerun doctor.'),
    });
    return { agent: 'kimi', displayName: 'Kimi Code', minimumVersion: KIMI_MINIMUM_VERSION, checks };
  }

  const meta = await context.fetchJson(
    `${instance.baseUrl}/api/v1/meta`,
    options.token ? { authorization: `Bearer ${options.token}` } : undefined,
  );
  const payload = (meta.json as { data?: unknown } | undefined)?.data;
  if (meta.status !== 'ok') {
    checks.push({
      id: 'kimi.server',
      status: 'fail',
      detailCode: 'server-unauthorized',
      summary: 'The Kimi server rejected the authenticated capability probe.',
      evidence: { url: instance.baseUrl },
      remediation: restartRemediation(
        context,
        home,
        'Restart `kimi web --no-open` so a current server token is written, then rerun doctor.',
      ),
    });
    return { agent: 'kimi', displayName: 'Kimi Code', minimumVersion: KIMI_MINIMUM_VERSION, checks };
  }
  // Doctor must apply the SAME identity binding the adapter does, through the
  // same function — a doctor with its own copy of the rule would report a
  // healthy, supported Kimi for a server the adapter then refuses to read, or
  // the reverse. (Same residuals as the adapter: the token is already spent by
  // this point, and the binding is not atomic with any later use.)
  const bound = bindKimiServerIdentity(instance, payload);
  if (!bound.ok) {
    checks.push({
      id: 'kimi.server',
      status: 'fail',
      ...IDENTITY_FAILURE[bound.reason],
      // The table holds the UNMANAGED wording; the posture decides whether the
      // operator is the one who should be restarting anything.
      remediation: restartRemediation(context, home, IDENTITY_FAILURE[bound.reason].remediation!.message),
      evidence: { url: instance.baseUrl },
    });
    return { agent: 'kimi', displayName: 'Kimi Code', minimumVersion: KIMI_MINIMUM_VERSION, checks };
  }
  const decoded = decodeKimiServerMeta(payload);
  if (!decoded?.websocket) {
    checks.push({
      id: 'kimi.server',
      status: 'fail',
      detailCode: 'server-capabilities-missing',
      summary: 'The Kimi server did not advertise the capabilities this integration requires.',
      evidence: { url: instance.baseUrl },
      remediation: restartRemediation(
        context,
        home,
        'Restart `kimi web --no-open` so a current server token is written, then rerun doctor.',
      ),
    });
    return { agent: 'kimi', displayName: 'Kimi Code', minimumVersion: KIMI_MINIMUM_VERSION, checks };
  }
  checks.push({
    id: 'kimi.server',
    status: 'pass',
    detailCode: 'server-reachable',
    summary: 'The Kimi local server is reachable and advertises the WebSocket surface.',
    evidence: { url: instance.baseUrl, serverVersion: bound.identity.serverVersion },
  });
  return { agent: 'kimi', displayName: 'Kimi Code', minimumVersion: KIMI_MINIMUM_VERSION, checks };
}

/**
 * One diagnosis per binding refusal. Total over the refusal union so a new
 * binding rule cannot ship with doctor still describing it as the old one.
 *
 * `auth-bypassed` used to be an ADVISORY check pushed alongside a passing
 * server. It is a failure now, and it replaces the pass rather than joining it:
 * a server with its token gate disabled answers any caller, so the authenticated
 * probe that "verified" it proved nothing at all.
 */
const IDENTITY_FAILURE: Record<
  Exclude<KimiIdentityBinding, { ok: true }>['reason'],
  { detailCode: string; summary: string; remediation: SetupCheck['remediation'] }
> = {
  'metadata-invalid': {
    detailCode: 'server-metadata-invalid',
    summary: 'The Kimi server answered its capability probe with metadata cosyncing cannot read.',
    remediation: { kind: 'manual', message: 'Restart `kimi web --no-open`, then rerun doctor. If it recurs, this Kimi version may have changed its server metadata.' },
  },
  'auth-bypassed': {
    detailCode: 'server-auth-bypassed',
    summary: 'The running Kimi server has its bearer-token gate disabled, so answering cosyncing proves nothing about which server it is.',
    remediation: { kind: 'manual', message: 'Restart the Kimi server without `--dangerous-bypass-auth`.' },
  },
  unbindable: {
    detailCode: 'server-identity-unbindable',
    summary: 'The Kimi instance registry record is missing the start time or version needed to tie it to the server answering on that port.',
    remediation: { kind: 'manual', message: 'Restart `kimi web --no-open` so a current registry record is written, then rerun doctor.' },
  },
  'startup-mismatch': {
    detailCode: 'server-identity-mismatch',
    summary: 'The Kimi server on this port did not start when its registry record says it did.',
    remediation: { kind: 'manual', message: 'Stop the process on that port, or restart `kimi web --no-open` so the registry matches the running server.' },
  },
  'version-mismatch': {
    detailCode: 'server-version-mismatch',
    summary: 'The Kimi server on this port reports a different version from the one its registry record records.',
    remediation: { kind: 'manual', message: 'Restart `kimi web --no-open` so the registry matches the running server, then rerun doctor.' },
  },
};
