import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import type { DesktopClientHost } from './desktop-client-types.ts';

const MAX_EXPANDED_BYTES = 768 * 1024 * 1024;

function archivePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  if (!normalized || /[\0-\x1f:]/.test(normalized)
      || normalized.startsWith('/')
      || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('desktop-client-archive-path-unsafe');
  }
  return normalized;
}

/** Validate ZIP entry names and Unix link targets before the native extractor writes anything. */
export function validateDesktopZip(bytes: Uint8Array, host: DesktopClientHost): void {
  const data = Buffer.from(bytes);
  let end = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65_557); offset--) {
    if (data.readUInt32LE(offset) === 0x06054b50
        && offset + 22 + data.readUInt16LE(offset + 20) === data.length) { end = offset; break; }
  }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) {
    throw new Error('desktop-client-zip-invalid');
  }
  const count = data.readUInt16LE(end + 10);
  const directorySize = data.readUInt32LE(end + 12);
  let offset = data.readUInt32LE(end + 16);
  const directoryEnd = offset + directorySize;
  if (!count || count === 0xffff || count !== data.readUInt16LE(end + 8) || directoryEnd > end) {
    throw new Error('desktop-client-zip-invalid');
  }
  const paths = new Set<string>();
  const links = new Map<string, string>();
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directoryEnd || data.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('desktop-client-zip-invalid');
    }
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameSize = data.readUInt16LE(offset + 28);
    const extraSize = data.readUInt16LE(offset + 30);
    const commentSize = data.readUInt16LE(offset + 32);
    const mode = data.readUInt32LE(offset + 38) >>> 16;
    const local = data.readUInt32LE(offset + 42);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    if (next > directoryEnd || flags & 1 || ![0, 8].includes(method)
        || compressed === 0xffffffff || size === 0xffffffff || local + 30 > offset) {
      throw new Error('desktop-client-zip-invalid');
    }
    const rawName = data.subarray(offset + 46, offset + 46 + nameSize);
    const path = archivePath(rawName.toString('utf8'));
    if (paths.has(path)) throw new Error('desktop-client-archive-duplicate-path');
    paths.add(path);
    expanded += size;
    if (expanded > MAX_EXPANDED_BYTES) throw new Error('desktop-client-archive-too-large');
    const kind = mode & 0o170000;
    if (![0, 0o100000, 0o040000, 0o120000].includes(kind)
        || (kind === 0o120000 && host !== 'macos-arm64')) {
      throw new Error('desktop-client-archive-type-unsafe');
    }
    if (data.readUInt32LE(local) !== 0x04034b50
        || data.readUInt16LE(local + 6) !== flags || data.readUInt16LE(local + 8) !== method) {
      throw new Error('desktop-client-zip-invalid');
    }
    const localNameSize = data.readUInt16LE(local + 26);
    const start = local + 30 + localNameSize + data.readUInt16LE(local + 28);
    if (start + compressed > data.readUInt32LE(end + 16)
        || !data.subarray(local + 30, local + 30 + localNameSize).equals(rawName)) {
      throw new Error('desktop-client-zip-invalid');
    }
    if (kind === 0o120000) {
      if (size > 4096) throw new Error('desktop-client-archive-link-unsafe');
      const body = data.subarray(start, start + compressed);
      const targetBytes = method === 0 ? body : inflateRawSync(body, { maxOutputLength: 4096 });
      const target = targetBytes.toString('utf8');
      if (targetBytes.length !== size || !target || /[\0-\x1f:\\]/.test(target)
          || posix.isAbsolute(target)) throw new Error('desktop-client-archive-link-unsafe');
      const resolved = posix.normalize(posix.join(posix.dirname(path), target));
      const root = path.split('/')[0]!;
      if (resolved !== root && !resolved.startsWith(`${root}/`)) {
        throw new Error('desktop-client-archive-link-unsafe');
      }
      links.set(path, resolved);
    }
    offset = next;
  }
  if (offset !== directoryEnd) throw new Error('desktop-client-zip-invalid');
  // Following any chain remains within its application root; cycles are refused as well.
  for (const origin of links.keys()) {
    let target = origin;
    const seen = new Set<string>();
    for (let depth = 0; depth < 128; depth++) {
      if (seen.has(target)) throw new Error('desktop-client-archive-link-unsafe');
      seen.add(target);
      const prefix = [...links.keys()].find((link) => target === link || target.startsWith(`${link}/`));
      if (!prefix) break;
      target = posix.join(links.get(prefix)!, target.slice(prefix.length));
      if (depth === 127) throw new Error('desktop-client-archive-link-unsafe');
    }
  }
}

/** ZIP extraction uses each host's existing installer tool; Bun.Archive handles Linux tarballs. */
export async function extractDesktopArchive(
  archive: string, destination: string, host: DesktopClientHost,
): Promise<void> {
  if (host === 'linux-x64') {
    const tar = gunzipSync(readFileSync(archive), { maxOutputLength: MAX_EXPANDED_BYTES });
    await new Bun.Archive(tar).extract(destination);
    return;
  }
  validateDesktopZip(readFileSync(archive), host);
  const command = host === 'macos-arm64'
    ? ['/usr/bin/ditto', '-x', '-k', archive, destination]
    : ['tar.exe', '-xf', archive, '-C', destination];
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
  try {
    const [exit] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error('desktop-client-archive-extraction-failed');
  } finally { clearTimeout(timer); }
}
