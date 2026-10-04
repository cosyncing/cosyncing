/**
 * Read-only setup/doctor diagnosis for DeepSeek Harness.
 *
 * Diagnosis never starts a host and never issues an RPC. That is not caution for
 * its own sake: the diagnosis surface is deliberately GET-only and effect-free,
 * while every dsh RPC — `host.describe` included — is a POST. So this path
 * proves what a read-only observer honestly can:
 *
 *  - is a `dsh` binary installed, and is it new enough;
 *  - does the config root exist;
 *  - is something listening on the configured base URL;
 *  - and does that something answer the dsh downlink contract.
 *
 * The last one uses a fingerprint rather than a guess: a plain GET on the mux
 * route is answered `426 Upgrade Required` by a real host, because the route
 * exists but only over a WebSocket upgrade. A 404 there means some OTHER server
 * owns the port, which is exactly the confusion a bare TCP probe cannot resolve.
 */
import { join } from 'node:path';
import {
  diagnoseBinaryVersion,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { dshCredentialScope, type DshCookie, type DshCredentialStore } from './auth.ts';
import {
  probeDshContract,
  DSH_CURRENT_VERSION,
  DSH_QUALIFIED_VERSION_LIST,
  DSH_UPGRADE_REQUIRED_STATUS,
  type DshContractProbe,
} from './compatibility.ts';
import {
  DSH_BASE_URL_ENV,
  DSH_DEFAULT_BASE_URL,
  DSH_FIXTURE_VERSION,
  DSH_MUX_ROUTE,
  dshApiPath,
  resolveDshBaseUrl,
} from './server.ts';

export const DSH_AGENT_ID = 'dsh';
export const DSH_DISPLAY_NAME = 'DeepSeek Harness';

/**
 * Status a real 0.1 host answers to a plain GET on an upgrade-only stream route.
 * Re-exported from the contract module, which owns the number: doctor and the
 * adapter must not be able to disagree about what the fingerprint is.
 */
export { DSH_UPGRADE_REQUIRED_STATUS };

/**
 * Says CONFIGURED TO MANAGE rather than "owns this host": the posture is a fact
 * about this machine's cosyncing, not about whichever process answers, which may
 * be the operator's own and which cosyncing preserves untouched.
 */
const DSH_MANAGED_HOST_REMEDIATION = 'cosyncing is configured to manage the DeepSeek Harness host and '
  + 'will start or restart it. Wait for it to come back and rerun doctor; if it does not, check the '
  + 'cosyncing service and run `cosyncing repair`.';

/**
 * Is the address THIS diagnosis resolved a host cosyncing manages here?
 *
 * The comparison is the whole point. The broker manages the address its own
 * environment resolves — the default one, since the service environment carries
 * no `COSYNCING_DSH_BASE_URL` — while doctor runs in an operator's shell that
 * may name any address at all, including one on another machine.
 */
function managedHere(context: SetupDiagnosisContext, baseUrl: string): boolean {
  return context.managedExternalHostIdentities?.includes(baseUrl) === true;
}

/**
 * What to tell an operator whose dsh host is not listening. THREE postures, and
 * the middle one is the reason this is not a boolean.
 *
 * MANAGED HERE — no command. A `dsh web` would race the broker's own start and
 * recovery and end with two hosts on one address, the same hazard the Kimi
 * diagnosis answers the same way.
 *
 * NOT THIS MACHINE'S ADDRESS — no command either, and this is the case a
 * managed/unmanaged flag gets wrong. `dsh web` takes no address: it serves the
 * default one. Handing it to an operator pointed somewhere else starts a host
 * that is not the one they are diagnosing, and if cosyncing manages the default
 * address that started host collides with the managed one. The honest answer
 * names the address and leaves the action with the only person who can take it.
 *
 * OTHERWISE — the local default, unmanaged, where the direct command is both
 * correct and the entire value of the remediation.
 */
function hostRemediation(
  context: SetupDiagnosisContext,
  baseUrl: string,
): SetupCheck['remediation'] {
  if (managedHere(context, baseUrl)) {
    // No command, deliberately: this is the message whose whole purpose is to
    // NOT hand the operator a way to start a competing host.
    return { kind: 'manual', message: DSH_MANAGED_HOST_REMEDIATION };
  }
  if (baseUrl !== DSH_DEFAULT_BASE_URL) {
    // The address is safe to print: `resolveDshBaseUrl` has already stripped any
    // credentials, which is the same guarantee the evidence fields rely on.
    return {
      kind: 'manual',
      message: `Start the DeepSeek Harness host at ${baseUrl}, then rerun doctor. `
        + 'cosyncing starts a host only at its own default address.',
    };
  }
  return { kind: 'command', message: 'Start the DeepSeek Harness host, then rerun doctor.', command: 'dsh web' };
}

export const DSH_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: '0.1.0-rc.6',
  requiredFeature:
    'the `dsh web` host RPC surface (host.describe, session.list/history/prompt) plus the events.mux and events.host downlink streams',
  evidenceUrl: 'https://github.com/deepseek-ai/deepseek-harness',
  evidenceNote:
    'Conservative floor: this repository captured its dsh fixtures from a real 0.1.0-rc.6 host and verified the envelope, '
    + 'the history tail projections block, and the mux open frames against it. The product is a developer preview whose rc '
    + 'train may change the wire contract, so the floor is the exact tested version rather than an inferred earlier one.',
});

/** `$DSH_HOME` overrides the config root; otherwise it is `~/.dsh`. */
export function resolveDshHome(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  const configured = env.DSH_HOME?.trim();
  return configured || join(homeDir, '.dsh');
}

/**
 * Where `npx` caches an ephemeral install.
 *
 * dsh is commonly run as `npx @deepseek-ai/dsh web`, which leaves NO binary on
 * PATH and no stable path to version-probe — the cache directory name is a hash
 * of the request. So the presence of the cache root is reported as an advisory
 * fact ("it may be running from an ephemeral install"), never as an installed
 * version, because claiming a version this path cannot read would be a guess.
 */
export function npxCacheRoot(homeDir: string): string {
  return join(homeDir, '.npm', '_npx');
}

function homeCheck(context: SetupDiagnosisContext, home: string, binaryPresent: boolean): SetupCheck {
  const inspected = context.inspectPath(home);
  if (inspected.status === 'directory' && inspected.readable) {
    return {
      id: 'dsh.home',
      status: 'pass',
      detailCode: 'home-readable',
      summary: 'The DeepSeek Harness config root is readable.',
      evidence: { path: inspected.displayPath },
    };
  }
  if (inspected.status === 'missing') {
    return {
      id: 'dsh.home',
      status: binaryPresent ? 'warn' : 'skip',
      detailCode: 'home-missing',
      summary: 'The DeepSeek Harness config root does not exist yet.',
      evidence: { path: inspected.displayPath },
      ...(binaryPresent
        ? { remediation: { kind: 'manual' as const, message: 'Run DeepSeek Harness once so it creates its config root.' } }
        : {}),
    };
  }
  return {
    id: 'dsh.home',
    status: 'fail',
    detailCode: inspected.status === 'unreadable' ? 'home-unreadable' : 'home-unsafe-type',
    summary: 'The DeepSeek Harness config root is unreadable or has an unexpected type.',
    evidence: { path: inspected.displayPath },
    remediation: { kind: 'manual', message: 'Fix the permissions on the DeepSeek Harness config root.' },
  };
}

function hostPort(baseUrl: string): { host: string; port: number } | undefined {
  try {
    const url = new URL(baseUrl);
    // Scheme-gated, not merely parseable: `ftp://host` parses cleanly and would
    // otherwise be probed on port 80, reporting "no host is listening" for what
    // is really an unusable base URL.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!Number.isSafeInteger(port)) return undefined;
    return { host: url.hostname, port };
  } catch {
    return undefined;
  }
}


/** The command that enrolls an external host, as the operator types it. */
export const DSH_ENROLL_COMMAND = 'cosy dsh connect';

/**
 * The contract probe's verdict, turned into what an operator should do.
 *
 * THIS TABLE IS THE WHOLE CHECK, and it is a table over the adapter's own
 * verdict union rather than a second fingerprint. What a 0.2 host answers to an
 * anonymous request (401 unauthorized on its carrier, 404 on the legacy route)
 * is not what a 0.1 host answers, so a doctor that looked only for the 0.1
 * upgrade-required fingerprint reported a healthy, correctly installed 0.2 host
 * as "an unexpected status" and sent the operator off to work out which program
 * owns their own port. Exhaustive over the union: a new verdict fails the build
 * here rather than reading as an unknown server.
 */
function contractCheck(probe: DshContractProbe, baseUrl: string): SetupCheck {
  if (probe.family === 'legacy-0.1') {
    return {
      id: 'dsh.contract',
      status: 'pass',
      detailCode: 'downlink-upgrade-required',
      summary: 'The host answers the DeepSeek Harness downlink contract.',
      evidence: { baseUrl, verifiedAgainst: DSH_FIXTURE_VERSION },
    };
  }
  if (probe.family === 'remote-0.2') {
    if (probe.reason === 'host-or-origin-refused') {
      return {
        id: 'dsh.contract',
        status: 'fail',
        detailCode: 'remote-carrier-refused',
        summary: 'The DeepSeek Harness host refused this request before routing it.',
        evidence: { baseUrl, verifiedAgainst: DSH_CURRENT_VERSION },
        remediation: {
          kind: 'manual',
          message: 'The host fences on the address a request claims. Confirm '
            + DSH_BASE_URL_ENV + ' names the address the host itself serves, and that any proxy '
            + 'in front of it forwards it.',
        },
      };
    }
    return {
      id: 'dsh.contract',
      status: 'pass',
      detailCode: probe.authenticated ? 'remote-carrier-answered' : 'remote-carrier-requires-credential',
      summary: probe.authenticated
        ? 'The host answers the 0.2 DeepSeek Harness carrier contract.'
        : 'The host answers the 0.2 DeepSeek Harness carrier and authenticates every request.',
      evidence: { baseUrl, verifiedAgainst: DSH_CURRENT_VERSION },
    };
  }
  const unreachable = probe.reason === 'no-listener' || probe.reason === 'probe-failed';
  return {
    id: 'dsh.contract',
    status: 'fail',
    detailCode: unreachable ? 'downlink-unreachable' : 'downlink-unexpected-status',
    summary: unreachable
      ? 'The server on this address did not answer the DeepSeek Harness routes.'
      : 'The server on this address answered the DeepSeek Harness routes with an unexpected status.',
    evidence: { baseUrl, verifiedAgainst: DSH_QUALIFIED_VERSION_LIST },
    remediation: {
      kind: 'manual',
      message: 'Confirm a DeepSeek Harness host (verified against ' + DSH_QUALIFIED_VERSION_LIST
        + ') owns this address, or set ' + DSH_BASE_URL_ENV + ' if it listens elsewhere.',
    },
  };
}

export interface DshDiagnosisOptions {
  /** Explicit base URL, when the adapter was configured with one. */
  baseUrl?: string;
  /**
   * The broker's own credential store, read and never written.
   *
   * Doctor and the running adapter must look in the same place for the same
   * scope, which is what makes an answer like "cosyncing holds a credential and
   * the host refused it" a fact rather than a guess about a file someone else
   * owns. Without a store there is nothing to report about enrollment, and this
   * module says so instead of implying the operator is logged out.
   */
  credentialStore?: DshCredentialStore;
  /** The DSH_HOME the credential scope is derived from. Defaults to the resolved home. */
  dshHome?: string;
  now?: () => number;
}

/**
 * What cosyncing itself holds for this endpoint, as an operator can act on it.
 *
 * Deliberately NOT a network test. The probe above is anonymous on purpose (a
 * 0.2 host answers a credential-free request with 401, and that anonymous
 * refusal is the fingerprint), and re-running it with the stored cookie proves
 * nothing: past that fence the carrier route is not a GET-able route at all, so
 * a request that IS accepted answers 404. The store is the only place the
 * enrollment question has a real answer, and even then the honest claim is
 * "cosyncing holds a credential that has not expired" — whether the host still
 * agrees is settled by the first real request, whose failure the adapter
 * already classifies.
 */
async function enrollmentCheck(
  options: DshDiagnosisOptions,
  context: SetupDiagnosisContext,
  baseUrl: string,
  home: string,
  now: number,
): Promise<SetupCheck> {
  // The same posture rule as every other remediation here. When cosyncing starts
  // this host IT reads the launch announcement itself, so an operator handed
  // `cosy dsh connect` would have to start a SECOND host to obtain a URL — and
  // the manual enrollment would then be pointed at whichever of the two answers
  // the address first.
  const managed = managedHere(context, baseUrl);
  const evidence = { baseUrl };
  if (!options.credentialStore) {
    return {
      id: 'dsh.enrollment',
      status: 'fail',
      detailCode: 'credential-store-missing',
      summary: 'cosyncing has no credential store for DeepSeek Harness, so it cannot hold a session with this host.',
      evidence,
      remediation: {
        kind: 'manual',
        message: 'Repair this cosyncing installation so its credential store is available, then rerun doctor.',
      },
    };
  }

  let cookie: DshCookie | null;
  try {
    cookie = await options.credentialStore.load(dshCredentialScope(baseUrl, home));
  } catch {
    // A store that will not answer is a storage problem. Reporting it as "not
    // enrolled" invites the operator to re-enroll, and enrolling writes to the
    // file whose safety the store just refused — the exact sequence a
    // group-writable or symlinked credential file must never see.
    return {
      id: 'dsh.enrollment',
      status: 'fail',
      detailCode: 'credential-store-unusable',
      summary: 'cosyncing could not read its DeepSeek Harness credential store, so the enrollment state is unknown.',
      evidence,
      remediation: {
        kind: 'manual',
        message: 'Check the permissions and file type of the cosyncing session store; do not re-enroll until it reads cleanly.',
      },
    };
  }

  const expiresAt = cookie?.expiresAt;
  // Typed as a number map so an unknown expiry cannot widen the evidence value
  // union with `undefined`.
  const expiry: Record<string, number> = expiresAt !== undefined ? { expiresAt } : {};
  if (cookie === null) {
    if (managed) {
      return {
        id: 'dsh.enrollment',
        status: 'fail',
        detailCode: 'enrollment-required-by-managed-host',
        summary: 'The DeepSeek Harness host cosyncing starts has not given cosyncing a session credential.',
        evidence,
        remediation: {
          kind: 'manual',
          message: 'Restart the cosyncing service so it starts the host again and reads its own launch '
            + 'announcement. Do not start a second host by hand: its credential would belong to a host '
            + 'nothing here is addressing.',
        },
      };
    }
    return {
      id: 'dsh.enrollment',
      status: 'fail',
      detailCode: 'enrollment-required',
      summary: 'This DeepSeek Harness host requires a session credential that cosyncing does not have.',
      evidence,
      remediation: {
        kind: 'command',
        message: 'Enroll this host with its one-time launch URL; cosyncing needs no restart afterwards.',
        command: DSH_ENROLL_COMMAND,
      },
    };
  }
  if (expiresAt !== undefined && expiresAt <= now) {
    return {
      id: 'dsh.enrollment',
      status: 'fail',
      detailCode: 'credential-expired',
      summary: 'The stored DeepSeek Harness session credential is past the expiry the host gave it.',
      evidence: { ...evidence, ...expiry },
      remediation: {
        kind: 'command',
        message: 'Re-enroll this host with a fresh launch URL; cosyncing needs no restart afterwards.',
        command: DSH_ENROLL_COMMAND,
      },
    };
  }
  return {
    id: 'dsh.enrollment',
    status: 'pass',
    detailCode: 'credential-held',
    summary: 'cosyncing holds a session credential for this host that has not expired.',
    evidence: { ...evidence, ...expiry },
  };
}

export async function diagnoseDshSetup(
  context: SetupDiagnosisContext,
  options: DshDiagnosisOptions = {},
): Promise<AgentSetupDiagnosis> {
  // The resolver sanitizes centrally (http(s) only, userinfo redacted, no
  // query/fragment) and THROWS on a value it refuses. Its message is written to
  // be evidence-safe: the raw configured URL, which may carry credentials, is
  // never quoted back.
  let baseUrl: string | undefined;
  let baseUrlError: string | undefined;
  try {
    baseUrl = resolveDshBaseUrl(context.env, options.baseUrl);
  } catch (error) {
    baseUrlError = error instanceof Error ? error.message : String(error);
  }
  const home = resolveDshHome(context.env, context.homeDir);

  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'dsh',
    displayName: DSH_DISPLAY_NAME,
    command: 'dsh',
    versionArgs: ['--version'],
    packageNames: ['@deepseek-ai/dsh'],
    minimum: DSH_MINIMUM_VERSION,
    installMessage: 'Install DeepSeek Harness (npm i -g @deepseek-ai/dsh), or run it with npx, then rerun doctor.',
    upgradeCommand: 'npm i -g @deepseek-ai/dsh@latest',
  });
  const checks: SetupCheck[] = [...binary.checks];

  if (!binary.executable) {
    const cache = context.inspectPath(npxCacheRoot(context.homeDir));
    if (cache.status === 'directory') {
      checks.push({
        id: 'dsh.npx-cache',
        status: 'warn',
        detailCode: 'binary-npx-only',
        summary: 'No dsh binary is on PATH; an npx cache exists, so the host may be running from an ephemeral install.',
        evidence: { path: cache.displayPath },
        remediation: {
          kind: 'manual',
          message: 'Install DeepSeek Harness globally so its version can be verified, or keep starting it with npx.',
        },
      });
    }
  }

  checks.push(homeCheck(context, home, !!binary.executable));

  if (baseUrlError !== undefined || baseUrl === undefined) {
    checks.push({
      id: 'dsh.server',
      status: 'fail',
      detailCode: 'base-url-invalid',
      summary: 'The configured DeepSeek Harness base URL is not a usable http(s) address.',
      evidence: { variable: DSH_BASE_URL_ENV, ...(baseUrlError ? { detail: baseUrlError } : {}) },
      remediation: { kind: 'manual', message: `Set ${DSH_BASE_URL_ENV} to the host's http address, then rerun doctor.` },
    });
    return { agent: DSH_AGENT_ID, displayName: DSH_DISPLAY_NAME, minimumVersion: DSH_MINIMUM_VERSION, checks };
  }

  const address = hostPort(baseUrl);
  if (!address) {
    checks.push({
      id: 'dsh.server',
      status: 'fail',
      detailCode: 'base-url-invalid',
      summary: 'The configured DeepSeek Harness base URL is not a usable http(s) address.',
      evidence: { baseUrl, variable: DSH_BASE_URL_ENV },
      remediation: { kind: 'manual', message: `Set ${DSH_BASE_URL_ENV} to the host's http address, then rerun doctor.` },
    });
    return { agent: DSH_AGENT_ID, displayName: DSH_DISPLAY_NAME, minimumVersion: DSH_MINIMUM_VERSION, checks };
  }

  const reachable = await context.probeTcp(address.host, address.port);
  if (reachable !== 'open') {
    checks.push({
      id: 'dsh.server',
      status: binary.executable ? 'warn' : 'skip',
      detailCode: reachable === 'closed' ? 'server-not-running' : 'server-unknown',
      summary: 'No DeepSeek Harness host is listening on the configured address.',
      evidence: { baseUrl },
      remediation: hostRemediation(context, baseUrl),
    });
    return { agent: DSH_AGENT_ID, displayName: DSH_DISPLAY_NAME, minimumVersion: DSH_MINIMUM_VERSION, checks };
  }

  checks.push({
    id: 'dsh.server',
    status: 'pass',
    detailCode: 'server-listening',
    summary: 'A server is listening on the configured DeepSeek Harness address.',
    evidence: { baseUrl },
  });

  // The adapter's OWN contract probe, so doctor can never report a host the
  // broker is able to drive as an unrecognised server. Two anonymous GETs at
  // most, and no POST anywhere in sight: the probe refuses to carry a credential
  // on purpose, because past a 0.2 host's auth fence the carrier route is not a
  // GET-able route at all, and an authenticated probe would read a healthy 0.2
  // host as a 404.
  const probe = await probeDshContract(baseUrl, async (url) => {
    const answer = await context.fetchJson(url);
    if (answer.status === 'unreachable') throw new Error('dsh diagnosis: route unreachable');
    return { status: answer.statusCode ?? 0 };
  });
  checks.push(contractCheck(probe, baseUrl));
  // Enrollment is a 0.2 question only. A 0.1 host has no credential to hold, and
  // an address that refused the request on its Host/Origin fence was refused for
  // a reason a credential does not answer.
  if (probe.family === 'remote-0.2' && probe.reason !== 'host-or-origin-refused') {
    checks.push(await enrollmentCheck(
      options,
      context,
      baseUrl,
      options.dshHome ?? resolveDshHome(context.env, context.homeDir),
      (options.now ?? Date.now)(),
    ));
  }

  return { agent: DSH_AGENT_ID, displayName: DSH_DISPLAY_NAME, minimumVersion: DSH_MINIMUM_VERSION, checks };
}
