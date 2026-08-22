import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setupStateHome } from '../installation/setup-state.ts';
import {
  atomicWriteJsonOwnerOnly,
  atomicWriteOwnerOnly,
  ensureOwnerOnlyDirectory,
  inspectOwnerOnlyFile,
  readOwnerOnlyText,
  type SecureFileInspection,
} from '../security/secure-files.ts';

export const BROKER_CONFIG_SCHEMA_VERSION = 2 as const;
export const BROKER_CONFIG_FILENAME = 'config.json';
export const BROKER_LISTEN_HOST = '127.0.0.1' as const;

export function brokerInternalUrl(port: number): string {
  return `http://${BROKER_LISTEN_HOST}:${port}`;
}

export type UpdateChannel = 'stable' | 'beta' | 'nightly';

export interface BrokerConfig {
  schemaVersion: typeof BROKER_CONFIG_SCHEMA_VERSION;
  broker: {
    port: number;
    machineLabel: string;
    /** Derived at runtime and never persisted. */
    readonly host: typeof BROKER_LISTEN_HOST;
    /** Derived at runtime and never persisted. */
    readonly internalUrl: string;
    /** Removed persisted field retained temporarily for source compatibility. Always undefined in v2. */
    readonly advertisedUrl?: undefined;
    [key: string]: unknown;
  };
  paths?: {
    flutterWebRoot?: string;
    [key: string]: unknown;
  };
  limits?: {
    historyMaxMessages?: number;
    filesystemReadMaxBytes?: number;
    uploadMaxBytes?: number;
    artifactCacheMaxBytes?: number;
    [key: string]: unknown;
  };
  update: {
    channel: UpdateChannel;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type BrokerConfigProblem =
  | 'missing'
  | 'unsafe-file'
  | 'unreadable'
  | 'malformed-json'
  | 'unsupported-schema'
  | 'invalid-value'
  | 'migration-required';

export type BrokerConfigInspection =
  | { status: 'ok'; path: string; config: BrokerConfig; migratedFrom?: 1; previousHost?: string }
  | { status: 'missing'; path: string; problem: 'missing' }
  | {
      status: 'error';
      path: string;
      problem: Exclude<BrokerConfigProblem, 'missing'>;
      detailCode: string;
    };

export class BrokerConfigurationError extends Error {
  constructor(readonly detailCode: string) {
    super(`broker configuration is invalid (${detailCode})`);
    this.name = 'BrokerConfigurationError';
  }
}

export interface EffectiveBrokerConfiguration {
  config: BrokerConfig;
  source: {
    host: 'derived';
    port: 'default' | 'config' | 'environment';
    machineLabel: 'default' | 'config' | 'environment';
    internalUrl: 'derived';
    advertisedUrl: 'unset';
    flutterWebRoot: 'unset' | 'config' | 'environment';
    updateChannel: 'default' | 'config' | 'environment';
  };
  environmentOverrides: string[];
}

export interface RepoEraConfigurationPlan {
  schemaVersion: 1;
  requiresConfirmation: true;
  findings: {
    legacyBrokerUrl: boolean;
    legacySharedToken: boolean;
  };
  actions: Array<
    | { kind: 'write-config'; port: number }
    | { kind: 'generate-new-broker-token'; reason: 'legacy-token-is-treated-as-leaked' }
  >;
}

export function brokerConfigPath(home = setupStateHome()): string {
  return join(home, BROKER_CONFIG_FILENAME);
}

function loopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

function withDerivedBrokerFields<T extends { port: number }>(broker: T): T & {
  readonly host: typeof BROKER_LISTEN_HOST;
  readonly internalUrl: string;
  readonly advertisedUrl?: undefined;
} {
  const result = { ...broker } as T & {
    readonly host: typeof BROKER_LISTEN_HOST;
    readonly internalUrl: string;
    readonly advertisedUrl?: undefined;
  };
  Object.defineProperties(result, {
    host: { value: BROKER_LISTEN_HOST, enumerable: true, writable: true },
    internalUrl: { value: brokerInternalUrl(broker.port), enumerable: true, writable: true },
    advertisedUrl: { value: undefined, enumerable: true, writable: true },
    toJSON: {
      enumerable: false,
      value(this: Record<string, unknown>) {
        const { host: _host, internalUrl: _internalUrl, advertisedUrl: _advertisedUrl, ...persisted } = this;
        return persisted;
      },
    },
  });
  return result;
}

export function defaultBrokerConfig(): BrokerConfig {
  return {
    schemaVersion: BROKER_CONFIG_SCHEMA_VERSION,
    broker: withDerivedBrokerFields({
      port: 7734,
      machineLabel: hostname(),
    }),
    update: { channel: 'stable' },
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== 'string') throw new BrokerConfigurationError(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\0\r\n]/.test(normalized)) {
    throw new BrokerConfigurationError(code);
  }
  return normalized;
}

function requirePort(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new BrokerConfigurationError('port');
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new BrokerConfigurationError(code);
  return value as number;
}

function normalizeBaseUrl(value: unknown, code: string, internal: boolean): string {
  const raw = requireString(value, code, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BrokerConfigurationError(code);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BrokerConfigurationError(code);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new BrokerConfigurationError(code);
  if (internal && (!loopbackHost(parsed.hostname) || parsed.protocol !== 'http:')) {
    throw new BrokerConfigurationError('internal-url-must-be-loopback-http');
  }
  if (!internal && !loopbackHost(parsed.hostname) && parsed.protocol !== 'https:') {
    throw new BrokerConfigurationError('advertised-url-must-be-https');
  }
  return parsed.origin;
}

export function validateBrokerConfig(value: unknown): BrokerConfig {
  if (!plainRecord(value)) throw new BrokerConfigurationError('root');
  if (value.schemaVersion !== BROKER_CONFIG_SCHEMA_VERSION) {
    throw new BrokerConfigurationError('schema-version');
  }
  if (!plainRecord(value.broker)) throw new BrokerConfigurationError('broker');
  if (!plainRecord(value.update)) throw new BrokerConfigurationError('update');

  const port = requirePort(value.broker.port);
  const machineLabel = requireString(value.broker.machineLabel, 'machine-label', 128);

  const channel = value.update.channel;
  if (channel !== 'stable' && channel !== 'beta' && channel !== 'nightly') {
    throw new BrokerConfigurationError('update-channel');
  }

  let paths: BrokerConfig['paths'];
  if (value.paths != null) {
    if (!plainRecord(value.paths)) throw new BrokerConfigurationError('paths');
    const flutterWebRoot = value.paths.flutterWebRoot == null
      ? undefined
      : requireString(value.paths.flutterWebRoot, 'flutter-web-root', 4_096);
    if (flutterWebRoot && (!isAbsolute(flutterWebRoot) || flutterWebRoot.includes('\0'))) {
      throw new BrokerConfigurationError('flutter-web-root');
    }
    paths = { ...value.paths, ...(flutterWebRoot ? { flutterWebRoot: resolve(flutterWebRoot) } : {}) };
  }

  let limits: BrokerConfig['limits'];
  if (value.limits != null) {
    if (!plainRecord(value.limits)) throw new BrokerConfigurationError('limits');
    limits = { ...value.limits };
    for (const [field, code] of [
      ['historyMaxMessages', 'history-max-messages'],
      ['filesystemReadMaxBytes', 'filesystem-read-max-bytes'],
      ['uploadMaxBytes', 'upload-max-bytes'],
      ['artifactCacheMaxBytes', 'artifact-cache-max-bytes'],
    ] as const) {
      const candidate = value.limits[field];
      if (candidate != null) limits[field] = requirePositiveInteger(candidate, code);
    }
  }

  return {
    ...value,
    schemaVersion: BROKER_CONFIG_SCHEMA_VERSION,
    broker: withDerivedBrokerFields({
      ...Object.fromEntries(
        Object.entries(value.broker).filter(([key]) => !['host', 'internalUrl', 'advertisedUrl'].includes(key)),
      ),
      port,
      machineLabel,
    }),
    ...(paths ? { paths } : {}),
    ...(limits ? { limits } : {}),
    update: { ...value.update, channel },
  } as BrokerConfig;
}

function fileProblem(inspection: SecureFileInspection): BrokerConfigInspection {
  if (inspection.status === 'missing') return { status: 'missing', path: inspection.path, problem: 'missing' };
  return {
    status: 'error',
    path: inspection.path,
    problem: inspection.status === 'unsafe' ? 'unsafe-file' : 'unreadable',
    detailCode: inspection.status === 'unsafe' ? `config-${inspection.problem ?? 'unsafe'}` : 'config-unreadable',
  };
}

function migrateLegacyBrokerConfigValue(value: Record<string, unknown>): {
  config: BrokerConfig;
  previousHost: string;
} {
  if (!plainRecord(value.broker)) throw new BrokerConfigurationError('broker');
  const previousHost = requireString(value.broker.host, 'host', 255);
  if (/\s|\//.test(previousHost)) throw new BrokerConfigurationError('host');
  normalizeBaseUrl(value.broker.internalUrl, 'internal-url', true);
  if (value.broker.advertisedUrl != null) {
    normalizeBaseUrl(value.broker.advertisedUrl, 'advertised-url', false);
  }
  return {
    previousHost,
    config: validateBrokerConfig({
      ...value,
      schemaVersion: BROKER_CONFIG_SCHEMA_VERSION,
      broker: Object.fromEntries(
        Object.entries(value.broker).filter(([key]) => !['host', 'internalUrl', 'advertisedUrl'].includes(key)),
      ),
    }),
  };
}

export function inspectBrokerConfig(home = setupStateHome()): BrokerConfigInspection {
  const path = brokerConfigPath(home);
  const file = inspectOwnerOnlyFile(path);
  if (file.status !== 'ok') return fileProblem(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readOwnerOnlyText(path));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { status: 'error', path, problem: 'malformed-json', detailCode: 'config-malformed-json' };
    }
    return { status: 'error', path, problem: 'unreadable', detailCode: 'config-unreadable' };
  }
  if (plainRecord(parsed) && parsed.schemaVersion == null) {
    return { status: 'error', path, problem: 'migration-required', detailCode: 'config-unversioned' };
  }
  if (plainRecord(parsed) && parsed.schemaVersion !== 1 && parsed.schemaVersion !== BROKER_CONFIG_SCHEMA_VERSION) {
    return { status: 'error', path, problem: 'unsupported-schema', detailCode: 'config-schema-version' };
  }
  try {
    if (plainRecord(parsed) && parsed.schemaVersion === 1) {
      const migrated = migrateLegacyBrokerConfigValue(parsed);
      return {
        status: 'ok',
        path,
        config: migrated.config,
        migratedFrom: 1,
        previousHost: migrated.previousHost,
      };
    }
    return { status: 'ok', path, config: validateBrokerConfig(parsed) };
  } catch (error) {
    return {
      status: 'error',
      path,
      problem: 'invalid-value',
      detailCode: error instanceof BrokerConfigurationError ? `config-${error.detailCode}` : 'config-invalid',
    };
  }
}

/** Back up and transactionally replace a valid v1 file. Read-only callers use inspectBrokerConfig instead. */
export function migrateBrokerConfigV1(home = setupStateHome()): {
  migrated: boolean;
  previousHost?: string;
  backupPath?: string;
} {
  const inspection = inspectBrokerConfig(home);
  if (inspection.status !== 'ok' || inspection.migratedFrom !== 1) return { migrated: false };
  const backupDirectory = join(home, 'backups');
  ensureOwnerOnlyDirectory(backupDirectory);
  const backupPath = join(
    backupDirectory,
    `config-v1-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(6).toString('hex')}.json`,
  );
  atomicWriteOwnerOnly(backupPath, readOwnerOnlyText(inspection.path), { mode: 0o600 });
  writeBrokerConfig(inspection.config, home);
  return {
    migrated: true,
    previousHost: inspection.previousHost,
    backupPath,
  };
}

export function writeBrokerConfig(config: BrokerConfig, home = setupStateHome()): BrokerConfig {
  const validated = validateBrokerConfig(config);
  atomicWriteJsonOwnerOnly(brokerConfigPath(home), validated);
  return validated;
}

function envInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new BrokerConfigurationError(`environment-${name.toLowerCase()}`);
  return parsed;
}

/** Resolve source-development overrides. Packaged builds use committed config except explicit file locations. */
export function resolveBrokerConfiguration(options: {
  packaged: boolean;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): EffectiveBrokerConfiguration {
  const env = options.env ?? process.env;
  const defaults = defaultBrokerConfig();
  const inspection = inspectBrokerConfig(options.home ?? setupStateHome());
  if (inspection.status === 'error') throw new BrokerConfigurationError(inspection.detailCode);
  if (options.packaged && inspection.status !== 'ok') throw new BrokerConfigurationError('config-missing');
  const stored = inspection.status === 'ok' ? inspection.config : defaults;
  const hasStored = inspection.status === 'ok';
  const allowEnv = !options.packaged;
  const overrides: string[] = [];

  let port = stored.broker.port;
  let machineLabel = stored.broker.machineLabel;
  let flutterWebRoot = stored.paths?.flutterWebRoot;
  let updateChannel = stored.update.channel;

  if (allowEnv && env.PORT?.trim()) {
    port = envInteger(env, 'PORT')!;
    overrides.push('PORT');
  }
  if (allowEnv && env.COSYNCING_MACHINE?.trim()) {
    machineLabel = env.COSYNCING_MACHINE.trim();
    overrides.push('COSYNCING_MACHINE');
  }
  // D17 keeps the adjacent bundle default but permits one explicit bundle override in source and package.
  if (env.COSYNCING_WEB_DIR?.trim()) {
    flutterWebRoot = env.COSYNCING_WEB_DIR.trim();
    overrides.push('COSYNCING_WEB_DIR');
  }
  if (allowEnv && env.COSYNCING_UPDATE_CHANNEL?.trim()) {
    updateChannel = env.COSYNCING_UPDATE_CHANNEL.trim() as UpdateChannel;
    overrides.push('COSYNCING_UPDATE_CHANNEL');
  }

  const candidate = validateBrokerConfig({
    ...stored,
    broker: { ...stored.broker, port, machineLabel },
    ...(flutterWebRoot ? { paths: { ...stored.paths, flutterWebRoot } } : {}),
    update: { ...stored.update, channel: updateChannel },
  });

  return {
    config: candidate,
    source: {
      host: 'derived',
      port: overrides.includes('PORT') ? 'environment' : hasStored ? 'config' : 'default',
      machineLabel: overrides.includes('COSYNCING_MACHINE') ? 'environment' : hasStored ? 'config' : 'default',
      internalUrl: 'derived',
      advertisedUrl: 'unset',
      flutterWebRoot: overrides.includes('COSYNCING_WEB_DIR') ? 'environment' : flutterWebRoot ? 'config' : 'unset',
      updateChannel: overrides.includes('COSYNCING_UPDATE_CHANNEL') ? 'environment' : hasStored ? 'config' : 'default',
    },
    environmentOverrides: overrides,
  };
}

/** Read-only repo-era detector. It reports presence and a migration action, never the legacy token value. */
export function planRepoEraConfigurationMigration(
  env: NodeJS.ProcessEnv = process.env,
): RepoEraConfigurationPlan | undefined {
  const legacyBroker = env.COSYNCING_BROKER?.trim();
  const legacyTokenPresent = !!env.COSYNCING_TOKEN?.trim();
  if (!legacyBroker && !legacyTokenPresent) return undefined;
  const actions: RepoEraConfigurationPlan['actions'] = [];
  if (legacyBroker) {
    const parsed = new URL(normalizeBaseUrl(legacyBroker, 'legacy-broker-url', true));
    actions.push({ kind: 'write-config', port: parsed.port ? Number(parsed.port) : 7734 });
  }
  if (legacyTokenPresent) {
    actions.push({ kind: 'generate-new-broker-token', reason: 'legacy-token-is-treated-as-leaked' });
  }
  return {
    schemaVersion: 1,
    requiresConfirmation: true,
    findings: { legacyBrokerUrl: !!legacyBroker, legacySharedToken: legacyTokenPresent },
    actions,
  };
}
