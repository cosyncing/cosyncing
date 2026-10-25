import { closeSync, fstatSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openRegularFileSync } from '@cosyncing/adapter-api';

export const OPENCODE_V2_MINIMUM_VERSION = '2.1.4';
export const OPENCODE_V2_MEASURED_VERSIONS: readonly string[] = Object.freeze(['2.1.4']);

export interface V2Registration {
  readonly url: string;
  readonly pid: number;
  readonly id?: string;
  readonly version?: string;
  readonly password?: string;
}

export type RegistrationRead =
  | { kind: 'absent' }
  | { kind: 'invalid'; detail: string }
  | { kind: 'valid'; registration: V2Registration };

export function registrationPath(env: Readonly<Record<string, string | undefined>> = process.env, home = homedir()): string {
  return join(env.XDG_STATE_HOME?.trim() || join(home, '.local', 'state'), 'opencode', 'service.json');
}

export function parseRegistration(text: string): RegistrationRead {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return { kind: 'invalid', detail: 'Registration PID must be a positive integer.' };
    if (typeof value.url !== 'string') return { kind: 'invalid', detail: 'Registration URL is missing.' };
    const url = new URL(value.url);
    if (!['http:', 'https:'].includes(url.protocol)
        || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return { kind: 'invalid', detail: 'Registration must name an HTTP(S) loopback origin with an explicit port and no path or credentials.' };
    }
    for (const key of ['id', 'version', 'password']) {
      if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 4096)) {
        return { kind: 'invalid', detail: 'Registration identity or credential has an invalid type or size.' };
      }
    }
    return { kind: 'valid', registration: Object.freeze({
      url: url.origin, pid: value.pid,
      ...(value.id === undefined ? {} : { id: value.id }),
      ...(value.version === undefined ? {} : { version: value.version }),
      ...(value.password === undefined ? {} : { password: value.password }),
    }) };
  } catch {
    return { kind: 'invalid', detail: 'Registration is not valid bounded JSON.' };
  }
}

/** Read and validate the same descriptor, without following a leaf symlink or opening a FIFO. */
export function readRegistration(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): RegistrationRead {
  let fd: number | undefined;
  try {
    fd = openRegularFileSync(registrationPath(env, home), { noFollow: true });
    const stat = fstatSync(fd);
    if (platform !== 'win32' && ((stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid()))) {
      return { kind: 'invalid', detail: 'Registration must be owned by this user and not writable by other users.' };
    }
    if (stat.size > 16 * 1024) return { kind: 'invalid', detail: 'Registration exceeds its size limit.' };
    const bytes = Buffer.alloc(16 * 1024 + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 16 * 1024) return { kind: 'invalid', detail: 'Registration exceeds its size limit.' };
    return parseRegistration(bytes.subarray(0, size).toString('utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'invalid', detail: 'Registration is not a readable regular file.' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function registrationAuthorization(registration?: V2Registration): string | undefined {
  return registration?.password ? `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` : undefined;
}
