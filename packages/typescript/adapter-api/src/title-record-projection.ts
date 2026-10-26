/**
 * A display-fact projection of one JSONL record. Ordinary records are unchanged;
 * large image strings do not require retaining their payload to find adjacent
 * prompt text. Fragments are raw bytes (or their lossless latin1 representation).
 * The caller owns newline framing and must not emit before finish().
 */
export type TitleRecordProjectionResult =
  | { kind: 'record'; value: any }
  | { kind: 'malformed' }
  | { kind: 'opaque' };

const RAW_BYTES = 1024 * 1024;
const STRING_BYTES = 64 * 1024;
const DEPTH = 64;
const CHUNK_BYTES = 128 * 1024;
// These controls are invalid everywhere in JSON, including inside strings.
const INVALID_CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
const BINARY_KEYS = new Set(['data', 'image_url', 'imageUrl']);
const TEXT_KEYS = new Set([
  'text', 'content', 'message', 'prompt', 'title', 'name', 'sessionName',
  'customTitle', 'aiTitle', 'thread_name',
]);
interface Container {
  kind: '{' | '[';
  key?: string;
}

export class TitleRecordProjection {
  bytes = 0;
  private raw = '';
  private projected = false;
  private invalid = false;
  private opaque = false;
  private output: string[] = [];
  private outputChunk = '';
  private outputBytes = 0;
  private containers: Container[] = [];
  private previous = '';
  private inString = false;
  private stringKey = false;
  private stringField?: string;
  private stringPrefix = '';
  private stringCut = false;
  private stringDropped = false;
  private stringBeyondText = false;
  private escaped = false;
  private unicodeLeft = 0;
  private utf8Left = 0;
  private utf8Min = 0x80;
  private utf8Max = 0xbf;

  /** A failed source validation must not mutate a retained partial record. */
  clone(): TitleRecordProjection {
    const copy = new TitleRecordProjection();
    Object.assign(copy, this);
    copy.output = [...this.output];
    copy.containers = this.containers.map((container) => ({ ...container }));
    return copy;
  }

  append(fragment: Buffer | string): void {
    if (this.invalid || this.opaque) { this.bytes += fragment.length; return; }
    for (let start = 0; start < fragment.length; start += CHUNK_BYTES) {
      const end = Math.min(fragment.length, start + CHUNK_BYTES);
      this.bytes += end - start;
      if (this.invalid || this.opaque) continue;
      const part = typeof fragment === 'string'
        ? fragment.slice(start, end)
        : fragment.subarray(start, end).toString('latin1');
      // Reject sparse/malformed input before the raw fast path retains it.
      if (INVALID_CONTROL_BYTES.test(part)) { this.invalid = true; this.raw = ''; continue; }
      if (!this.projected && this.raw.length + part.length <= RAW_BYTES) {
        this.raw += part;
        continue;
      }
      if (!this.projected) {
        this.projected = true;
        const held = this.raw;
        this.raw = '';
        this.consume(held);
      }
      this.consume(part);
    }
  }

  /** Non-mutating: callers may inspect EOF and later append the missing suffix. */
  finish(): TitleRecordProjectionResult {
    if (this.invalid) return { kind: 'malformed' };
    if (this.opaque) return { kind: 'opaque' };
    if (this.projected && (this.inString || this.utf8Left || this.containers.length)) {
      return { kind: 'malformed' };
    }
    try {
      const bytes = Buffer.from(this.projected ? this.output.join('') + this.outputChunk : this.raw, 'latin1');
      const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { kind: 'record', value: JSON.parse(json) };
    } catch { return { kind: 'malformed' }; }
  }

  private write(text: string): void {
    if (this.outputBytes + text.length > RAW_BYTES) { this.opaque = true; return; }
    this.outputBytes += text.length;
    this.outputChunk += text;
    if (this.outputChunk.length >= 4096) {
      // Per-character projection creates ropes. Retain flat byte strings so
      // bounded output cannot keep thousands of concatenation nodes alive.
      this.output.push(Buffer.from(this.outputChunk, 'latin1').toString('latin1'));
      this.outputChunk = '';
    }
  }

  private validUtf8(byte: number): boolean {
    if (this.utf8Left) {
      if (byte < this.utf8Min || byte > this.utf8Max) return false;
      this.utf8Left--;
      this.utf8Min = 0x80;
      this.utf8Max = 0xbf;
      return true;
    }
    if (byte < 0x80) return true;
    if (byte >= 0xc2 && byte <= 0xdf) this.utf8Left = 1;
    else if (byte >= 0xe0 && byte <= 0xef) {
      this.utf8Left = 2;
      if (byte === 0xe0) this.utf8Min = 0xa0;
      if (byte === 0xed) this.utf8Max = 0x9f;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      this.utf8Left = 3;
      if (byte === 0xf0) this.utf8Min = 0x90;
      if (byte === 0xf4) this.utf8Max = 0x8f;
    } else return false;
    return true;
  }

  private consume(fragment: string): void {
    for (let index = 0; index < fragment.length && !this.invalid && !this.opaque; index++) {
      const byte = fragment.charCodeAt(index);
      const char = fragment[index]!;
      if (!this.validUtf8(byte)) { this.invalid = true; break; }
      if (!this.inString) {
        if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
          this.invalid = true;
          break;
        }
        if (char === '"') {
          const parent = this.containers.at(-1);
          this.stringKey = parent?.kind === '{' && (this.previous === '{' || this.previous === ',');
          this.stringField = this.stringKey ? undefined : parent?.key;
          this.inString = true;
          this.stringPrefix = '';
          this.stringCut = false;
          this.stringDropped = !this.stringKey && BINARY_KEYS.has(this.stringField ?? '');
          this.stringBeyondText = false;
          this.escaped = false;
          this.unicodeLeft = 0;
        } else {
          if (char === '{' || char === '[') {
            if (this.containers.length >= DEPTH) { this.opaque = true; break; }
            const parent = this.containers.at(-1);
            this.containers.push({ kind: char, ...(char === '[' ? { key: parent?.key } : {}) });
          } else if (char === '}' || char === ']') {
            if (this.containers.at(-1)?.kind !== (char === '}' ? '{' : '[')) { this.invalid = true; break; }
            this.containers.pop();
          }
          this.write(char);
          if (!/\s/.test(char)) this.previous = char;
        }
        continue;
      }

      if (!this.escaped && !this.unicodeLeft && char === '"') {
        this.endString();
        this.inString = false;
        this.previous = '"';
        continue;
      }
      if (byte < 0x20) { this.invalid = true; break; }
      if (this.unicodeLeft) {
        if (!/[0-9a-f]/i.test(char)) { this.invalid = true; break; }
        this.unicodeLeft--;
      } else if (this.escaped) {
        this.escaped = false;
        if (char === 'u') this.unicodeLeft = 4;
        else if (!'"\\/bfnrt'.includes(char)) { this.invalid = true; break; }
      } else if (char === '\\') this.escaped = true;
      if (!this.stringDropped && !this.stringCut) {
        this.stringPrefix += char;
        if (this.stringPrefix.length >= STRING_BYTES && !this.utf8Left && !this.escaped && !this.unicodeLeft) this.stringCut = true;
      } else if (!this.stringDropped && !/\s/.test(char)) this.stringBeyondText = true;
    }
  }

  private endString(): void {
    if (this.stringDropped) { this.write('""'); return; }
    try {
      let value = JSON.parse('"' + Buffer.from(this.stringPrefix, 'latin1').toString('utf8') + '"') as string;
      if (this.stringCut) {
        // Never introduce a split surrogate when the retained prefix ends just
        // before the second escaped code unit of an astral character.
        if (/[\ud800-\udbff]$/.test(value)) value = value.slice(0, -1);
        if (this.stringKey || !TEXT_KEYS.has(this.stringField ?? '')) { this.opaque = true; return; }
        const meaningful = value.replace(/[\p{Cc}\p{Z}\s]+/gu, ' ').trim();
        if (this.stringBeyondText && Array.from(meaningful).length < 160) {
          this.opaque = true;
          return;
        }
      }
      if (this.stringKey) this.containers.at(-1)!.key = value;
      this.write(Buffer.from(JSON.stringify(value), 'utf8').toString('latin1'));
    } catch { this.invalid = true; }
  }
}
