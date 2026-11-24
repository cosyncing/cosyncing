import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  compareSemanticVersions,
  isRegularSqliteStoreSync,
  diagnoseBinaryVersion,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { OPENCODE_V2_MINIMUM_VERSION, readRegistration, registrationAuthorization } from './v2/registration.ts';
import { isSession, object } from './v2/mapping.ts';

const V2_MINIMUM: AgentMinimumVersion = Object.freeze({
  version: OPENCODE_V2_MINIMUM_VERSION,
  requiredFeature: 'the shared OpenCode service HTTP and event contracts',
  evidenceUrl: 'https://github.com/anomalyco/opencode/releases/tag/v2.2.0',
  evidenceNote: 'Measured service identity, migration, history, live events and input contracts on 2.1.4, 2.2.0 and 2.3.2; 2.2.0 admits large image attachments; newer 2.x responses are validated structurally.',
});

async function diagnoseV2(
  context: SetupDiagnosisContext,
  binary: Awaited<ReturnType<typeof diagnoseBinaryVersion>>,
  options: { baseUrl?: string; dataDir?: string; serverExplicitlyConfigured?: boolean },
): Promise<AgentSetupDiagnosis | undefined> {
  const registration = readRegistration({ ...context.env }, context.platform as NodeJS.Platform, context.homeDir);
  const major = Number(binary.installedVersion?.split('.')[0]);
  const explicit = options.serverExplicitlyConfigured ?? !!context.env.OPENCODE_URL?.trim();
  if (!explicit && !(major >= 2) && (binary.executable || registration.kind === 'absent')) return undefined;
  let server = explicit ? normalizedServerUrl(options.baseUrl || context.env.OPENCODE_URL || '') : registration.kind === 'valid' ? new URL(registration.registration.url) : undefined;
  let auth: string | undefined;
  if (registration.kind === 'valid' && registration.registration.url === server?.origin) auth = registrationAuthorization(registration.registration);
  const headers = auth ? { authorization: auth } : undefined;
  const probe = server ? await context.fetchJson(new URL('/api/info', server).toString(), headers, 1500, 64 * 1024) : undefined;
  const info = probe?.json as any;
  const validInfo = typeof info?.version === 'string' && Number.isSafeInteger(info.pid) && info.pid > 0 && compareSemanticVersions(info.version, info.version) !== undefined;
  if (explicit && !validInfo && major < 2 && probe?.statusCode !== 401 && probe?.statusCode !== 403 && !(probe?.statusCode === 503 && info?.code === 'service_starting')) return undefined;
  if (!explicit && !binary.executable && registration.kind === 'absent') return undefined;
  const checks: SetupCheck[] = binary.checks;
  const version = checks.find((check) => check.id === 'opencode.version');
  const effectiveVersion = validInfo ? info.version : binary.installedVersion;
  const effectiveMajor = Number(effectiveVersion?.split('.')[0]);
  if (version && effectiveVersion) {
    const below = (compareSemanticVersions(effectiveVersion, OPENCODE_V2_MINIMUM_VERSION) ?? -1) < 0;
    version.status = effectiveMajor > 2 || below ? 'warn' : 'pass';
    version.detailCode = effectiveMajor > 2 ? 'generation-unknown' : below ? 'version-below-minimum' : 'version-supported';
    version.summary = effectiveMajor > 2 ? 'This OpenCode service generation is not supported.' : below ? 'The OpenCode service is below the supported minimum.' : 'OpenCode service version is supported.';
    if (version.status === 'pass' || effectiveMajor > 2) delete version.remediation;
  }
  checks.push({ id: 'opencode.storage', status: 'skip', detailCode: 'storage-not-checked', summary: 'V2 session history is read from the service.' });
  let reason = 'v2-service-not-running';
  let detail = 'No usable OpenCode service registration was found. Start OpenCode on its host.';
  if (registration.kind === 'invalid' && !explicit) { reason = 'registration-invalid'; detail = registration.detail; }
  else if (explicit && !server) { reason = 'registration-invalid'; detail = 'The configured OpenCode URL is not a valid origin.'; }
  else if (probe?.statusCode === 401 || probe?.statusCode === 403) { reason = auth ? 'credential-rejected' : 'credential-required'; detail = 'OpenCode service credentials are required or were rejected.'; }
  else if (probe?.statusCode === 503 && info?.code === 'service_starting') { reason = 'v2-service-starting'; detail = 'The OpenCode service is starting. Existing sessions are retained.'; }
  else if (validInfo && registration.kind === 'valid' && registration.registration.url === server?.origin && (info.pid !== registration.registration.pid || (registration.registration.version && info.version !== registration.registration.version))) { reason = 'registration-invalid'; detail = 'Registration identity does not match the OpenCode service.'; }
  else if (validInfo) { reason = 'server-reachable'; detail = 'OpenCode shared service is reachable.'; }
  checks.push({ id: 'opencode.server', status: reason === 'server-reachable' ? 'pass' : 'warn', detailCode: reason, summary: detail });
  checks.push({ id: 'opencode.managed-serve-eligibility', status: 'skip', detailCode: 'external-v2-service', summary: 'cosyncing never starts, stops or pairs the OpenCode service.' });

  if (reason === 'server-reachable' && server && ['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname)) {
    const root = options.dataDir || context.env.OPENCODE_DATA || join(context.env.XDG_DATA_HOME || join(context.homeDir, '.local', 'share'), 'opencode');
    const path = join(root, 'opencode.db');
    if (isRegularSqliteStoreSync(path)) {
      let database: Database | undefined;
      try {
        database = new Database(path, { readonly: true });
        const legacy = new Set((database.query('SELECT id FROM session WHERE time_archived IS NULL').all() as { id: string }[]).map((row) => row.id));
        const migration = await context.fetchJson(new URL('/api/experimental/migration/v1', server).toString(), headers);
        if ((migration.json as any)?.status === 'completed' && legacy.size) {
          const deadline = Date.now() + 15_000;
          const cursors = new Set<string>();
          let cursor: string | undefined;
          let complete = false;
          for (let page = 0; page < 50 && Date.now() < deadline; page++) {
            const result = await context.fetchJson(new URL('/api/session?limit=100&archived=false' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''), server).toString(), headers, 1500, 16 * 1024 * 1024);
            const value = result.json as any;
            if (result.status !== 'ok' || !Array.isArray(value?.data) || !value.data.every(object)) break;
            for (const row of value.data) if (isSession(row)) legacy.delete(row.id);
            cursor = value.cursor?.next;
            if (!value.data.length || cursor === undefined) { complete = true; break; }
            if (typeof cursor !== 'string' || cursors.has(cursor)) break;
            cursors.add(cursor);
          }
          if (complete && legacy.size) {
            const storage = checks.find((check) => check.id === 'opencode.storage')!;
            Object.assign(storage, { status: 'warn', detailCode: 'v1-sessions-not-imported', summary: `${legacy.size} V1 sessions were not imported by OpenCode.`, evidence: { count: legacy.size } });
          }
        }
      } catch { /* A missing V1 schema is normal on a fresh V2 installation. */ }
      finally { database?.close(); }
    }
  }
  return { agent: 'opencode', displayName: 'OpenCode', minimumVersion: V2_MINIMUM, checks };
}

export const OPENCODE_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: '1.17.19',
  requiredFeature: 'the headless `opencode serve` HTTP/OpenAPI and SSE surface used for shared-owner terminal sync',
  evidenceUrl: 'https://github.com/anomalyco/opencode/releases/tag/v1.17.19',
  evidenceNote: 'Conservative floor: this repository is fixture- and real-host-verified on OpenCode 1.17.19; official server docs define the required multi-client HTTP surface.',
});

function dataDirectory(context: SetupDiagnosisContext, configured?: string): string {
  if (configured) return configured;
  if (context.env.OPENCODE_DATA?.trim()) return context.env.OPENCODE_DATA.trim();
  if (context.platform === 'darwin') return join(context.homeDir, 'Library', 'Application Support', 'opencode');
  if (context.platform === 'win32') {
    return join(context.env.LOCALAPPDATA?.trim() || join(context.homeDir, 'AppData', 'Local'), 'opencode');
  }
  return join(context.env.XDG_DATA_HOME?.trim() || join(context.homeDir, '.local', 'share'), 'opencode');
}

function storageCheck(context: SetupDiagnosisContext, path: string, binaryPresent: boolean): SetupCheck {
  const inspected = context.inspectPath(path);
  if (inspected.status === 'directory' && inspected.readable) {
    return {
      id: 'opencode.storage',
      status: 'pass',
      detailCode: 'storage-readable',
      summary: 'OpenCode local session storage is readable.',
      evidence: { path: inspected.displayPath },
    };
  }
  if (inspected.status === 'missing') {
    return {
      id: 'opencode.storage',
      status: binaryPresent ? 'warn' : 'skip',
      detailCode: 'storage-missing',
      summary: 'OpenCode local session storage is not present yet.',
      evidence: { path: inspected.displayPath },
      ...(binaryPresent ? {
        remediation: { kind: 'manual' as const, message: 'Start OpenCode once or use a reachable shared server.' },
      } : {}),
    };
  }
  return {
    id: 'opencode.storage',
    status: 'fail',
    detailCode: inspected.status === 'unreadable' ? 'storage-unreadable' : 'storage-unsafe-type',
    summary: 'OpenCode local session storage is unreadable or has an unexpected type.',
    evidence: { path: inspected.displayPath },
    remediation: { kind: 'command', message: 'Repair the OpenCode integration paths.', command: 'cosyncing repair' },
  };
}

function normalizedServerUrl(raw: string): URL | undefined {
  try {
    const value = new URL(raw);
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value.hostname);
    if (loopback && !value.port) value.port = '4096';
    if ((value.protocol !== 'http:' && value.protocol !== 'https:')
        || value.username || value.password || value.search || value.hash
        || (value.pathname !== '/' && value.pathname !== '')) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function serverEvidence(server: URL): string {
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(server.hostname);
  return loopback ? server.origin : `${server.protocol}//<configured-host>${server.port ? `:${server.port}` : ''}`;
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() || '');
}

export async function diagnoseOpenCodeSetup(
  context: SetupDiagnosisContext,
  options: { baseUrl?: string; dataDir?: string; serverExplicitlyConfigured?: boolean } = {},
): Promise<AgentSetupDiagnosis> {
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    versionArgs: ['--version'],
    // Doctor and setup spawn this probe too, and an unguarded `--version`
    // here is the same class of gap as an unguarded runtime child --
    // `diagnoseBinaryVersion` runs it on every doctor and every setup.
    versionProbeEnv: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
    minimum: OPENCODE_MINIMUM_VERSION,
    // opencode.ai and Homebrew now install OpenCode 2 (`@opencode/cli` on npm). Also name the installs
    // that stay on OpenCode 1 (the install script refuses 2.x; `opencode-ai` only carries 1.x).
    installMessage: 'Install OpenCode 2 with `npm install --global @opencode/cli`, or stay on OpenCode 1 with `curl -fsSL https://opencode.ai/install | bash` or `npm install --global opencode-ai`, then rerun doctor.',
    upgradeCommand: 'opencode upgrade',
  });
  const major = Number(binary.installedVersion?.split('.')[0]);
  const v2 = await diagnoseV2(context, binary, options);
  if (v2) return v2;
  const unsupported = major >= 2;
  if (unsupported) {
    const version = binary.checks.find((check) => check.id === 'opencode.version');
    if (version) {
      version.status = 'warn';
      version.detailCode = major === 2 ? 'generation-2-unsupported' : 'generation-unknown';
      version.summary = major === 2
        ? 'OpenCode 2 is detected but not yet supported. cosyncing supports OpenCode 1.'
        : 'This OpenCode generation is not yet supported. cosyncing supports OpenCode 1.';
      delete version.remediation;
    }
  }
  const checks: SetupCheck[] = [
    ...binary.checks,
    unsupported
      ? { id: 'opencode.storage', status: 'skip', detailCode: 'storage-not-checked', summary: 'V1 storage checks do not apply to this OpenCode generation.' }
      : storageCheck(context, dataDirectory(context, options.dataDir), !!binary.executable),
  ];

  const server = normalizedServerUrl(options.baseUrl || context.env.OPENCODE_URL?.trim() || 'http://127.0.0.1:4096');
  if (!server) {
    checks.push({
      id: 'opencode.server',
      status: 'fail',
      detailCode: 'server-url-invalid',
      summary: 'The configured OpenCode server URL is invalid.',
      remediation: { kind: 'command', message: 'Reconfigure the OpenCode integration.', command: 'cosyncing repair' },
    });
  } else {
    const healthUrl = new URL('/global/health', server).toString();
    const health = await context.fetchJson(healthUrl);
    const payload = health.json as { healthy?: unknown; version?: unknown } | undefined;
    if (health.status === 'ok' && payload?.healthy === true) {
      checks.push({
        id: 'opencode.server',
        status: 'pass',
        detailCode: 'server-reachable',
        summary: 'OpenCode shared server is reachable.',
        evidence: { url: serverEvidence(server) },
      });
    } else {
      const port = Number(server.port || (server.protocol === 'https:' ? 443 : 80));
      const portState = await context.probeTcp(server.hostname, port);
      const explicitlyConfigured = options.serverExplicitlyConfigured ?? !!context.env.OPENCODE_URL?.trim();
      checks.push(portState === 'open'
        ? {
            id: 'opencode.server',
            status: 'fail',
            detailCode: 'server-port-conflict',
            summary: 'The OpenCode port is occupied but does not expose the expected health contract.',
            evidence: { url: serverEvidence(server) },
            remediation: { kind: 'command', message: 'Reconcile the managed OpenCode server without killing an unowned process.', command: 'cosyncing repair' },
          }
        : {
            id: 'opencode.server',
            status: explicitlyConfigured ? 'fail' : binary.executable ? 'warn' : 'skip',
            detailCode: portState === 'unknown' ? 'server-reachability-unknown' : 'server-not-running',
            summary: explicitlyConfigured
              ? 'The configured OpenCode server is unreachable.'
              : 'No shared OpenCode server is currently reachable.',
            evidence: { url: serverEvidence(server) },
            remediation: binary.executable
              ? { kind: 'command', message: 'Let setup reconcile the managed OpenCode server.', command: 'cosyncing setup' }
              : { kind: 'manual', message: 'Install OpenCode before enabling its shared server.' },
          });
    }

    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(server.hostname);
    if (unsupported) {
      checks.push({
        id: 'opencode.managed-serve-eligibility', status: 'skip', detailCode: 'external-v2-service',
        summary: 'cosyncing does not manage this OpenCode generation.',
      });
    } else if (!loopback) {
      checks.push({
        id: 'opencode.managed-serve-eligibility',
        status: 'skip',
        detailCode: 'external-server-configured',
        summary: 'OpenCode uses an externally managed server; cosyncing will not launch another one.',
        evidence: { url: serverEvidence(server) },
      });
    } else if (truthy(context.env.COSYNCING_OPENCODE_NO_AUTOSERVE)) {
      checks.push({
        id: 'opencode.managed-serve-eligibility',
        status: 'warn',
        detailCode: 'managed-serve-disabled',
        summary: 'Managed OpenCode serve is disabled by source-development configuration.',
        remediation: { kind: 'command', message: 'Reconcile packaged configuration.', command: 'cosyncing repair' },
      });
    } else {
      checks.push({
        id: 'opencode.managed-serve-eligibility',
        status: binary.executable ? 'pass' : 'skip',
        detailCode: binary.executable ? 'managed-serve-eligible' : 'managed-serve-binary-missing',
        summary: binary.executable
          ? 'OpenCode is eligible for the broker-managed shared server.'
          : 'Managed serve eligibility was not checked because OpenCode is missing.',
      });
    }
  }

  if (unsupported) {
    // Setup cannot reconcile a managed serve for an unsupported generation.
    const serverCheck = checks.find((check) => check.id === 'opencode.server');
    if (serverCheck) delete serverCheck.remediation;
  }

  return {
    agent: 'opencode',
    displayName: 'OpenCode',
    minimumVersion: OPENCODE_MINIMUM_VERSION,
    checks,
  };
}
