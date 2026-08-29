import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { setupStateHome } from '../installation/setup-state.ts';
import {
  atomicWriteJsonOwnerOnly,
  atomicWriteOwnerOnly,
  inspectOwnerOnlyFile,
  readOwnerOnlyText,
  type SecureFileInspection,
} from './secure-files.ts';

export const BROKER_TOKEN_FILENAME = 'broker-token';
export const PI_INTEGRATION_FILENAME = 'pi-integration.json';
export const PI_INTEGRATION_SCHEMA_VERSION = 1 as const;
export const OMP_INTEGRATION_FILENAME = 'omp-integration.json';
export const OMP_INTEGRATION_SCHEMA_VERSION = 1 as const;

export interface PiIntegrationCredential {
  schemaVersion: typeof PI_INTEGRATION_SCHEMA_VERSION;
  kind: 'pi-bridge';
  internalUrl: string;
  credential: string;
  [key: string]: unknown;
}

export interface OmpIntegrationCredential {
  schemaVersion: typeof OMP_INTEGRATION_SCHEMA_VERSION;
  kind: 'omp-bridge';
  internalUrl: string;
  credential: string;
  [key: string]: unknown;
}

export interface CredentialInspection {
  status: 'missing' | 'ok' | 'unsafe' | 'unreadable' | 'malformed';
  path: string;
  detailCode: string;
}

export interface RuntimeCredentials {
  brokerToken: string;
  brokerTokenSource: 'file' | 'legacy-environment' | 'none';
  piIntegrationToken: string;
  piIntegrationSource: 'file' | 'environment' | 'none';
  piInternalUrl?: string;
  ompIntegrationToken: string;
  ompIntegrationSource: 'file' | 'environment' | 'none';
  ompInternalUrl?: string;
  warnings: string[];
}

export class CredentialStateError extends Error {
  constructor(readonly detailCode: string) {
    super(`credential state is invalid (${detailCode})`);
    this.name = 'CredentialStateError';
  }
}

function secretsDirectory(home = setupStateHome()): string {
  return join(home, 'secrets');
}

export function brokerTokenPath(home = setupStateHome()): string {
  return join(secretsDirectory(home), BROKER_TOKEN_FILENAME);
}

export function piIntegrationPath(home = setupStateHome()): string {
  return join(secretsDirectory(home), PI_INTEGRATION_FILENAME);
}

export function ompIntegrationPath(home = setupStateHome()): string {
  return join(secretsDirectory(home), OMP_INTEGRATION_FILENAME);
}

export function generateCredential(): string {
  return randomBytes(32).toString('base64url');
}

export function validCredential(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function validDevelopmentCredential(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !/[\0\r\n]/.test(value);
}

export function safeCredentialEqual(expected: string, supplied: string): boolean {
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeInternalUrl(value: unknown, code = 'pi-internal-url'): string {
  if (typeof value !== 'string' || value.length > 2_048) throw new CredentialStateError(code);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CredentialStateError(code);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.');
  if (!loopback || parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new CredentialStateError(code);
  }
  return parsed.origin;
}

function inspectionFromFile(file: SecureFileInspection, prefix: string): CredentialInspection {
  if (file.status === 'missing') return { status: 'missing', path: file.path, detailCode: `${prefix}-missing` };
  if (file.status === 'unsafe') {
    return { status: 'unsafe', path: file.path, detailCode: `${prefix}-${file.problem ?? 'unsafe'}` };
  }
  if (file.status === 'unreadable') return { status: 'unreadable', path: file.path, detailCode: `${prefix}-unreadable` };
  return { status: 'ok', path: file.path, detailCode: `${prefix}-ok` };
}

export function inspectBrokerToken(target = brokerTokenPath()): CredentialInspection {
  const file = inspectionFromFile(inspectOwnerOnlyFile(target), 'broker-token');
  if (file.status !== 'ok') return file;
  try {
    const token = readOwnerOnlyText(target).trim();
    return validCredential(token)
      ? file
      : { status: 'malformed', path: target, detailCode: 'broker-token-malformed' };
  } catch {
    return { status: 'unreadable', path: target, detailCode: 'broker-token-unreadable' };
  }
}

export function readBrokerToken(target = brokerTokenPath()): string {
  const inspection = inspectBrokerToken(target);
  if (inspection.status !== 'ok') throw new CredentialStateError(inspection.detailCode);
  return readOwnerOnlyText(target).trim();
}

/** One scoped bridge-integration record family: the filename, record kind, and detail-code prefix differ per tool. */
interface IntegrationRecordSpec<K extends string, C extends { kind: K; internalUrl: string; credential: string }> {
  prefix: 'pi-integration' | 'omp-integration';
  kind: K;
  schemaVersion: 1;
}

const PI_INTEGRATION_SPEC: IntegrationRecordSpec<'pi-bridge', PiIntegrationCredential> = {
  prefix: 'pi-integration',
  kind: 'pi-bridge',
  schemaVersion: PI_INTEGRATION_SCHEMA_VERSION,
};
const OMP_INTEGRATION_SPEC: IntegrationRecordSpec<'omp-bridge', OmpIntegrationCredential> = {
  prefix: 'omp-integration',
  kind: 'omp-bridge',
  schemaVersion: OMP_INTEGRATION_SCHEMA_VERSION,
};

function validateIntegration<K extends string, C extends { kind: K; internalUrl: string; credential: string }>(
  spec: IntegrationRecordSpec<K, C>,
  value: unknown,
): C {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CredentialStateError(`${spec.prefix}-root`);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== spec.schemaVersion || record.kind !== spec.kind) {
    throw new CredentialStateError(`${spec.prefix}-schema`);
  }
  if (typeof record.credential !== 'string' || !validCredential(record.credential)) {
    throw new CredentialStateError(`${spec.prefix}-credential`);
  }
  return {
    ...record,
    schemaVersion: spec.schemaVersion,
    kind: spec.kind,
    internalUrl: normalizeInternalUrl(record.internalUrl, `${spec.prefix.replace(/-integration$/, '')}-internal-url`),
    credential: record.credential,
  } as unknown as C;
}

function inspectIntegration<K extends string, C extends { kind: K; internalUrl: string; credential: string }>(
  spec: IntegrationRecordSpec<K, C>,
  target: string,
): CredentialInspection {
  const file = inspectionFromFile(inspectOwnerOnlyFile(target), spec.prefix);
  if (file.status !== 'ok') return file;
  try {
    validateIntegration(spec, JSON.parse(readOwnerOnlyText(target)));
    return file;
  } catch {
    return { status: 'malformed', path: target, detailCode: `${spec.prefix}-malformed` };
  }
}

function readIntegration<K extends string, C extends { kind: K; internalUrl: string; credential: string }>(
  spec: IntegrationRecordSpec<K, C>,
  target: string,
): C {
  const inspection = inspectIntegration(spec, target);
  if (inspection.status !== 'ok') throw new CredentialStateError(inspection.detailCode);
  try {
    return validateIntegration(spec, JSON.parse(readOwnerOnlyText(target)));
  } catch (error) {
    if (error instanceof CredentialStateError) throw error;
    throw new CredentialStateError(`${spec.prefix}-malformed`);
  }
}

function validatePiIntegration(value: unknown): PiIntegrationCredential {
  return validateIntegration(PI_INTEGRATION_SPEC, value);
}

export function inspectPiIntegration(target = piIntegrationPath()): CredentialInspection {
  return inspectIntegration(PI_INTEGRATION_SPEC, target);
}

export function readPiIntegration(target = piIntegrationPath()): PiIntegrationCredential {
  return readIntegration(PI_INTEGRATION_SPEC, target);
}

export function inspectOmpIntegration(target = ompIntegrationPath()): CredentialInspection {
  return inspectIntegration(OMP_INTEGRATION_SPEC, target);
}

export function readOmpIntegration(target = ompIntegrationPath()): OmpIntegrationCredential {
  return readIntegration(OMP_INTEGRATION_SPEC, target);
}

export function writeBrokerToken(token: string, target = brokerTokenPath()): void {
  if (!validCredential(token)) throw new CredentialStateError('broker-token-malformed');
  atomicWriteOwnerOnly(target, `${token}\n`);
}

export function writePiIntegration(value: PiIntegrationCredential, target = piIntegrationPath()): void {
  atomicWriteJsonOwnerOnly(target, validatePiIntegration(value));
}

export function writeOmpIntegration(value: OmpIntegrationCredential, target = ompIntegrationPath()): void {
  atomicWriteJsonOwnerOnly(target, validateIntegration(OMP_INTEGRATION_SPEC, value));
}

/**
 * Idempotent setup primitive. Existing valid credentials survive repeated setup; URL drift updates each
 * record atomically without changing its scoped credential. Rotation always mints fresh random material.
 */
export function ensureInstallationCredentials(options: {
  home?: string;
  internalUrl: string;
  rotateBrokerToken?: boolean;
  rotatePiCredential?: boolean;
  rotateOmpCredential?: boolean;
}): { brokerToken: string; piIntegration: PiIntegrationCredential; ompIntegration: OmpIntegrationCredential } {
  const home = options.home ?? setupStateHome();
  const tokenTarget = brokerTokenPath(home);
  const normalizedInternalUrl = normalizeInternalUrl(options.internalUrl);

  let brokerToken: string;
  const tokenInspection = inspectBrokerToken(tokenTarget);
  if (!options.rotateBrokerToken && tokenInspection.status === 'ok') {
    brokerToken = readBrokerToken(tokenTarget);
  } else if (tokenInspection.status !== 'missing' && tokenInspection.status !== 'ok' && !options.rotateBrokerToken) {
    throw new CredentialStateError(tokenInspection.detailCode);
  } else {
    brokerToken = generateCredential();
    writeBrokerToken(brokerToken, tokenTarget);
  }

  const ensureIntegration = <K extends string, C extends { schemaVersion: 1; kind: K; internalUrl: string; credential: string }>(
    spec: IntegrationRecordSpec<K, C>,
    target: string,
    rotate: boolean | undefined,
  ): C => {
    const inspection = inspectIntegration(spec, target);
    let record: C;
    if (!rotate && inspection.status === 'ok') {
      const existing = readIntegration(spec, target);
      record = { ...existing, internalUrl: normalizedInternalUrl };
    } else if (inspection.status !== 'missing' && inspection.status !== 'ok' && !rotate) {
      throw new CredentialStateError(inspection.detailCode);
    } else {
      record = {
        schemaVersion: spec.schemaVersion,
        kind: spec.kind,
        internalUrl: normalizedInternalUrl,
        credential: generateCredential(),
      } as C;
    }
    atomicWriteJsonOwnerOnly(target, validateIntegration(spec, record));
    return record;
  };

  const piIntegration = ensureIntegration(PI_INTEGRATION_SPEC, piIntegrationPath(home), options.rotatePiCredential);
  const ompIntegration = ensureIntegration(OMP_INTEGRATION_SPEC, ompIntegrationPath(home), options.rotateOmpCredential);
  return { brokerToken, piIntegration, ompIntegration };
}

function explicitAbsolutePath(value: string | undefined, fallback: string, code: string): string {
  const target = value?.trim() || fallback;
  if (!isAbsolute(target)) throw new CredentialStateError(code);
  return target;
}

export function resolveRuntimeCredentials(options: {
  packaged: boolean;
  internalUrl: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): RuntimeCredentials {
  const env = options.env ?? process.env;
  const home = options.home ?? setupStateHome();
  const tokenTarget = explicitAbsolutePath(env.COSYNCING_TOKEN_FILE, brokerTokenPath(home), 'broker-token-file-path');
  const piTarget = explicitAbsolutePath(env.COSYNCING_PI_INTEGRATION_FILE, piIntegrationPath(home), 'pi-integration-file-path');
  const ompTarget = explicitAbsolutePath(env.COSYNCING_OMP_INTEGRATION_FILE, ompIntegrationPath(home), 'omp-integration-file-path');
  const warnings: string[] = [];

  let brokerToken = '';
  let brokerTokenSource: RuntimeCredentials['brokerTokenSource'] = 'none';
  const tokenInspection = inspectBrokerToken(tokenTarget);
  if (tokenInspection.status === 'ok') {
    brokerToken = readBrokerToken(tokenTarget);
    brokerTokenSource = 'file';
  } else if (!options.packaged && tokenInspection.status === 'missing' && env.COSYNCING_TOKEN?.trim()) {
    if (!validDevelopmentCredential(env.COSYNCING_TOKEN.trim())) throw new CredentialStateError('legacy-broker-token-malformed');
    brokerToken = env.COSYNCING_TOKEN.trim();
    brokerTokenSource = 'legacy-environment';
    warnings.push('legacy-shared-token-present');
  } else if (options.packaged || tokenInspection.status !== 'missing') {
    throw new CredentialStateError(tokenInspection.detailCode);
  }

  let piIntegrationToken = '';
  let piIntegrationSource: RuntimeCredentials['piIntegrationSource'] = 'none';
  let piInternalUrl: string | undefined;
  const piInspection = inspectPiIntegration(piTarget);
  if (piInspection.status === 'ok') {
    const integration = readPiIntegration(piTarget);
    if (integration.internalUrl !== normalizeInternalUrl(options.internalUrl)) {
      throw new CredentialStateError('pi-integration-url-mismatch');
    }
    piIntegrationToken = integration.credential;
    piInternalUrl = integration.internalUrl;
    piIntegrationSource = 'file';
  } else if (!options.packaged && piInspection.status === 'missing' && env.COSYNCING_PI_INTEGRATION_TOKEN?.trim()) {
    const candidate = env.COSYNCING_PI_INTEGRATION_TOKEN.trim();
    if (!validDevelopmentCredential(candidate)) throw new CredentialStateError('pi-integration-environment-malformed');
    piIntegrationToken = candidate;
    piInternalUrl = normalizeInternalUrl(options.internalUrl);
    piIntegrationSource = 'environment';
  } else if (options.packaged || piInspection.status !== 'missing') {
    throw new CredentialStateError(piInspection.detailCode);
  }

  let ompIntegrationToken = '';
  let ompIntegrationSource: RuntimeCredentials['ompIntegrationSource'] = 'none';
  let ompInternalUrl: string | undefined;
  const ompInspection = inspectOmpIntegration(ompTarget);
  if (ompInspection.status === 'ok') {
    const integration = readOmpIntegration(ompTarget);
    if (integration.internalUrl !== normalizeInternalUrl(options.internalUrl, 'omp-internal-url')) {
      throw new CredentialStateError('omp-integration-url-mismatch');
    }
    ompIntegrationToken = integration.credential;
    ompInternalUrl = integration.internalUrl;
    ompIntegrationSource = 'file';
  } else if (!options.packaged && ompInspection.status === 'missing' && env.COSYNCING_OMP_INTEGRATION_TOKEN?.trim()) {
    const candidate = env.COSYNCING_OMP_INTEGRATION_TOKEN.trim();
    if (!validDevelopmentCredential(candidate)) throw new CredentialStateError('omp-integration-environment-malformed');
    ompIntegrationToken = candidate;
    ompInternalUrl = normalizeInternalUrl(options.internalUrl, 'omp-internal-url');
    ompIntegrationSource = 'environment';
  } else if (options.packaged || ompInspection.status !== 'missing') {
    throw new CredentialStateError(ompInspection.detailCode);
  }

  return {
    brokerToken,
    brokerTokenSource,
    piIntegrationToken,
    piIntegrationSource,
    ...(piInternalUrl ? { piInternalUrl } : {}),
    ompIntegrationToken,
    ompIntegrationSource,
    ...(ompInternalUrl ? { ompInternalUrl } : {}),
    warnings,
  };
}
