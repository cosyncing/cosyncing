import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../src/updates/bun-runtime-upgrade.ts';

/**
 * A minimal zip writer for runtime-archive fixtures.
 *
 * Bun publishes its builds as zips, and the updater reads them with its own extractor. Fixtures written here
 * exercise the shapes real zip tools produce -- stored and deflated entries, streamed entries whose sizes
 * live in a trailing data descriptor, and ZIP64 records -- without depending on a `zip` binary, which is
 * not present on every host the suite runs on.
 */
export interface ZipFixtureEntry {
  name: string;
  data?: Uint8Array | string;
  method?: 'store' | 'deflate';
  /** Unix mode recorded in the external attributes. Directories default to 0o40755, files to 0o100755. */
  mode?: number;
}

export interface ZipFixtureOptions {
  /** Write sizes and CRC after the data (flag bit 3), with zeroes in the local header. */
  dataDescriptor?: boolean;
  /** Saturate every 32-bit size/offset and carry the real values in ZIP64 extra fields and records. */
  zip64?: boolean;
  /** Set the encryption flag on every entry. The reader must refuse it. */
  encrypted?: boolean;
  /** XOR the stored CRC of the named entry, so its bytes no longer match what the directory claims. */
  corruptCrcOf?: string;
}

class Writer {
  private readonly parts: Buffer[] = [];
  length = 0;
  push(bytes: Uint8Array): void {
    const buffer = Buffer.from(bytes);
    this.parts.push(buffer);
    this.length += buffer.byteLength;
  }
  u16(value: number): void { const b = Buffer.alloc(2); b.writeUInt16LE(value); this.push(b); }
  u32(value: number): void { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); this.push(b); }
  u64(value: number): void { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); this.push(b); }
  bytes(): Uint8Array { return new Uint8Array(Buffer.concat(this.parts)); }
}

export function writeZipFixture(entries: readonly ZipFixtureEntry[], options: ZipFixtureOptions = {}): Uint8Array {
  const out = new Writer();
  const central: Array<{
    name: Buffer; flags: number; method: number; crc: number; compressed: number; size: number;
    offset: number; mode: number;
  }> = [];
  const version = options.zip64 ? 45 : 20;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const directory = entry.name.endsWith('/');
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data) : Buffer.from(entry.data ?? new Uint8Array());
    const method = directory || entry.method === 'store' ? 0 : 8;
    const payload = method === 8 ? deflateRawSync(data) : data;
    let crc = crc32(data);
    if (options.corruptCrcOf === entry.name) crc = (crc ^ 0x5a5a5a5a) >>> 0;
    const flags = (options.dataDescriptor && !directory ? 0x08 : 0) | (options.encrypted ? 0x01 : 0);
    const offset = out.length;
    const localExtra = options.zip64 ? 20 : 0;
    out.u32(0x04034b50);
    out.u16(version);
    out.u16(flags);
    out.u16(method);
    out.u16(0); // time
    out.u16(0x21); // 1980-01-01
    const streamed = (flags & 0x08) !== 0;
    out.u32(streamed ? 0 : crc);
    out.u32(options.zip64 ? 0xffffffff : streamed ? 0 : payload.byteLength);
    out.u32(options.zip64 ? 0xffffffff : streamed ? 0 : data.byteLength);
    out.u16(name.byteLength);
    out.u16(localExtra);
    out.push(name);
    if (options.zip64) {
      out.u16(0x0001);
      out.u16(16);
      out.u64(streamed ? 0 : data.byteLength);
      out.u64(streamed ? 0 : payload.byteLength);
    }
    out.push(payload);
    if (streamed) {
      out.u32(0x08074b50);
      out.u32(crc);
      if (options.zip64) {
        out.u64(payload.byteLength);
        out.u64(data.byteLength);
      } else {
        out.u32(payload.byteLength);
        out.u32(data.byteLength);
      }
    }
    central.push({
      name, flags, method, crc, compressed: payload.byteLength, size: data.byteLength, offset,
      mode: entry.mode ?? (directory ? 0o40755 : 0o100755),
    });
  }
  const directoryOffset = out.length;
  for (const entry of central) {
    out.u32(0x02014b50);
    out.u16((3 << 8) | version); // made by: unix
    out.u16(version);
    out.u16(entry.flags);
    out.u16(entry.method);
    out.u16(0);
    out.u16(0x21);
    out.u32(entry.crc);
    out.u32(options.zip64 ? 0xffffffff : entry.compressed);
    out.u32(options.zip64 ? 0xffffffff : entry.size);
    out.u16(entry.name.byteLength);
    out.u16(options.zip64 ? 28 : 0);
    out.u16(0); // comment
    out.u16(0); // disk
    out.u16(0); // internal attributes
    out.u32(entry.mode << 16);
    out.u32(options.zip64 ? 0xffffffff : entry.offset);
    out.push(entry.name);
    if (options.zip64) {
      out.u16(0x0001);
      out.u16(24);
      out.u64(entry.size);
      out.u64(entry.compressed);
      out.u64(entry.offset);
    }
  }
  const directorySize = out.length - directoryOffset;
  if (options.zip64) {
    const record = out.length;
    out.u32(0x06064b50);
    out.u64(44);
    out.u16((3 << 8) | 45);
    out.u16(45);
    out.u32(0);
    out.u32(0);
    out.u64(central.length);
    out.u64(central.length);
    out.u64(directorySize);
    out.u64(directoryOffset);
    out.u32(0x07064b50);
    out.u32(0);
    out.u64(record);
    out.u32(1);
  }
  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(options.zip64 ? 0xffff : central.length);
  out.u16(options.zip64 ? 0xffff : central.length);
  out.u32(options.zip64 ? 0xffffffff : directorySize);
  out.u32(options.zip64 ? 0xffffffff : directoryOffset);
  out.u16(0);
  return out.bytes();
}

/** The archive shape Bun publishes: one top-level folder named after the asset, holding the executable. */
export function bunArchiveFixture(asset: string, executable: string | Uint8Array, platform: string = process.platform): Uint8Array {
  const folder = asset.replace(/\.zip$/, '');
  return writeZipFixture([
    { name: `${folder}/` },
    { name: `${folder}/${platform === 'win32' ? 'bun.exe' : 'bun'}`, data: executable },
  ]);
}
