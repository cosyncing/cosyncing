import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import type { BuildInfo } from '../runtime/build-info.ts';
import { atomicWriteJsonOwnerOnly, inspectOwnerOnlyFile } from '../security/secure-files.ts';

export const WINDOWS_ACTIVE_INSTALL_SCHEMA_VERSION = 1 as const;
export const WINDOWS_SERVICE_ENVIRONMENT_SCHEMA_VERSION = 1 as const;
export const WINDOWS_SERVICE_BOOTSTRAP_FILENAME = 'service-bootstrap.mjs';
export const WINDOWS_ACTIVE_INSTALL_FILENAME = 'active-install.json';
export const WINDOWS_SERVICE_LOG_FILENAME = 'broker.log';
export const WINDOWS_BOOTSTRAP_RESOURCE_ID = 'service-windows-bootstrap';
export const WINDOWS_ACTIVE_INSTALL_RESOURCE_ID = 'service-windows-active-install';
export const WINDOWS_VERSION_RESOURCE_ID = 'service-windows-version';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface WindowsActiveInstallManifest {
  schemaVersion: typeof WINDOWS_ACTIVE_INSTALL_SCHEMA_VERSION;
  installationId: string;
  versionKey: string;
}

export interface WindowsServiceEnvironment {
  schemaVersion: typeof WINDOWS_SERVICE_ENVIRONMENT_SCHEMA_VERSION;
  variables: Record<string, string>;
}

export interface WindowsServiceInstallPaths {
  serviceRoot: string;
  bootstrapPath: string;
  activeManifestPath: string;
  versionsRoot: string;
  versionRoot: string;
  applicationPath: string;
  webRoot: string;
  environmentPath: string;
  logDirectory: string;
  logPath: string;
}

function cleanWindowsAbsolutePath(value: string, label: string): string {
  if (!win32.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`invalid ${label} path`);
  return win32.resolve(value);
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

export function windowsServiceVersionKey(
  build: Readonly<Omit<BuildInfo, 'schemaVersions' | 'contract'>>,
): string {
  const value = [
    build.version,
    build.commit,
    build.dirty === true ? 'dirty' : build.dirty === false ? 'clean' : 'unknown',
    build.target,
    build.buildDate ?? 'undated',
  ].join('-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return safeId(value, 'Windows service version key');
}

export function windowsServiceInstallPaths(stateHome: string, versionKey: string): WindowsServiceInstallPaths {
  const stateRoot = cleanWindowsAbsolutePath(stateHome, 'Windows state home');
  const cleanVersionKey = safeId(versionKey, 'Windows service version key');
  const serviceRoot = win32.join(stateRoot, 'service', 'windows');
  const versionsRoot = win32.join(serviceRoot, 'versions');
  const versionRoot = win32.join(versionsRoot, cleanVersionKey);
  const logDirectory = win32.join(stateRoot, 'logs');
  return {
    serviceRoot,
    bootstrapPath: win32.join(serviceRoot, WINDOWS_SERVICE_BOOTSTRAP_FILENAME),
    activeManifestPath: win32.join(serviceRoot, WINDOWS_ACTIVE_INSTALL_FILENAME),
    versionsRoot,
    versionRoot,
    applicationPath: win32.join(versionRoot, PRODUCT_IDENTITY.primaryBinary),
    webRoot: win32.join(versionRoot, 'web'),
    environmentPath: win32.join(versionRoot, 'environment.json'),
    logDirectory,
    logPath: win32.join(logDirectory, WINDOWS_SERVICE_LOG_FILENAME),
  };
}

export function windowsActiveInstallManifest(
  installationId: string,
  versionKey: string,
): WindowsActiveInstallManifest {
  return {
    schemaVersion: WINDOWS_ACTIVE_INSTALL_SCHEMA_VERSION,
    installationId: safeId(installationId, 'Windows installation id'),
    versionKey: safeId(versionKey, 'Windows service version key'),
  };
}

export function parseWindowsActiveInstallManifest(value: unknown): WindowsActiveInstallManifest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== WINDOWS_ACTIVE_INSTALL_SCHEMA_VERSION
      || typeof record.installationId !== 'string' || !SAFE_ID.test(record.installationId)
      || typeof record.versionKey !== 'string' || !SAFE_ID.test(record.versionKey)
      || Object.keys(record).some((key) => !['schemaVersion', 'installationId', 'versionKey'].includes(key))) {
    return undefined;
  }
  return record as unknown as WindowsActiveInstallManifest;
}

export function windowsServiceEnvironment(
  entries: ReadonlyArray<readonly [string, string]>,
): WindowsServiceEnvironment {
  const variables: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || /[\0\r\n]/.test(value)) {
      throw new Error('invalid Windows service environment entry');
    }
    const existing = Object.keys(variables).find((key) => key.toLowerCase() === name.toLowerCase());
    if (existing) throw new Error('duplicate Windows service environment entry');
    variables[name] = value;
  }
  return { schemaVersion: WINDOWS_SERVICE_ENVIRONMENT_SCHEMA_VERSION, variables };
}

export function parseWindowsServiceEnvironment(value: unknown): WindowsServiceEnvironment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== WINDOWS_SERVICE_ENVIRONMENT_SCHEMA_VERSION
      || !record.variables || typeof record.variables !== 'object' || Array.isArray(record.variables)
      || Object.keys(record).some((key) => !['schemaVersion', 'variables'].includes(key))) return undefined;
  try {
    return windowsServiceEnvironment(Object.entries(record.variables as Record<string, unknown>).map(([name, entry]) => {
      if (typeof entry !== 'string') throw new Error('invalid Windows service environment entry');
      return [name, entry] as const;
    }));
  } catch {
    return undefined;
  }
}

export function inspectWindowsActiveInstall(path: string):
  | { status: 'missing' | 'unsafe' | 'unreadable' | 'malformed' }
  | { status: 'ok'; manifest: WindowsActiveInstallManifest } {
  const inspection = inspectOwnerOnlyFile(path);
  if (inspection.status !== 'ok') return { status: inspection.status };
  try {
    const manifest = parseWindowsActiveInstallManifest(JSON.parse(readFileSync(path, 'utf8')));
    return manifest ? { status: 'ok', manifest } : { status: 'malformed' };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code ? 'unreadable' : 'malformed' };
  }
}

export function writeWindowsActiveInstall(path: string, manifest: WindowsActiveInstallManifest): void {
  const normalized = parseWindowsActiveInstallManifest(manifest);
  if (!normalized) throw new Error('refusing to write invalid Windows active installation');
  atomicWriteJsonOwnerOnly(path, normalized);
}

export function writeWindowsServiceEnvironment(path: string, environment: WindowsServiceEnvironment): void {
  const normalized = parseWindowsServiceEnvironment(environment);
  if (!normalized) throw new Error('refusing to write invalid Windows service environment');
  atomicWriteJsonOwnerOnly(path, normalized);
}
