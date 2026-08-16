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
import {
  DSH_BASE_URL_ENV,
  DSH_FIXTURE_VERSION,
  DSH_MUX_ROUTE,
  dshApiPath,
  resolveDshBaseUrl,
} from './server.ts';

export const DSH_AGENT_ID = 'dsh';
export const DSH_DISPLAY_NAME = 'DeepSeek Harness';

/** Status a real host answers to a plain GET on an upgrade-only stream route. */
export const DSH_UPGRADE_REQUIRED_STATUS = 426;

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

export interface DshDiagnosisOptions {
  /** Explicit base URL, when the adapter was configured with one. */
  baseUrl?: string;
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
      remediation: { kind: 'command', message: 'Start the DeepSeek Harness host, then rerun doctor.', command: 'dsh web' },
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

  // Contract fingerprint. A real host answers a plain GET on the mux route with
  // 426 (the route exists, but only over an upgrade). Anything else on that port
  // is either not dsh or is an rc whose stream routing changed — both are
  // reasons to fail closed rather than to attach and misread frames.
  const probe = await context.fetchJson(`${baseUrl}${dshApiPath(DSH_MUX_ROUTE)}`);
  if (probe.statusCode === DSH_UPGRADE_REQUIRED_STATUS) {
    checks.push({
      id: 'dsh.contract',
      status: 'pass',
      detailCode: 'downlink-upgrade-required',
      summary: 'The host answers the DeepSeek Harness downlink contract.',
      evidence: { baseUrl, verifiedAgainst: DSH_FIXTURE_VERSION },
    });
  } else {
    checks.push({
      id: 'dsh.contract',
      status: 'fail',
      detailCode: probe.statusCode === undefined ? 'downlink-unreachable' : 'downlink-unexpected-status',
      summary: probe.statusCode === undefined
        ? 'The server on this address did not answer the DeepSeek Harness downlink route.'
        : 'The server on this address answered the DeepSeek Harness downlink route with an unexpected status.',
      evidence: {
        baseUrl,
        verifiedAgainst: DSH_FIXTURE_VERSION,
        ...(probe.statusCode !== undefined ? { statusCode: probe.statusCode } : {}),
      },
      remediation: {
        kind: 'manual',
        message:
          `Confirm a DeepSeek Harness host (verified against ${DSH_FIXTURE_VERSION}) owns this address; `
          + `set ${DSH_BASE_URL_ENV} if it listens elsewhere.`,
      },
    });
  }

  return { agent: DSH_AGENT_ID, displayName: DSH_DISPLAY_NAME, minimumVersion: DSH_MINIMUM_VERSION, checks };
}
