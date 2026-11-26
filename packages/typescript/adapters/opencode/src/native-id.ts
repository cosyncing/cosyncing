import { randomBytes } from 'node:crypto';

/**
 * Generate a message id in OpenCode's own ascending format (`Identifier.ascending('message')`):
 * `msg_` + 12 hex chars of the 48-bit big-endian value `Date.now()*4096 + counter` + 14 random
 * base62 chars. `prompt_async` accepts a caller-supplied `messageID` (the TUI uses this for its own
 * sends) — supplying one is the NATIVE app-send correlation handle, so the SSE user echo can be
 * attributed to the exact send by id, never by text. The timestamp encoding must match OpenCode's
 * or the message would sort out of order among native ids.
 */
const OC_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let ocIdLastMs = 0;
let ocIdCounter = 0;
export function nativeMessageId(prefix: 'msg' | 'ses' = 'msg'): string {
  const now = Date.now();
  if (now !== ocIdLastMs) {
    ocIdLastMs = now;
    ocIdCounter = 0;
  }
  ocIdCounter++;
  const value = BigInt(now) * 4096n + BigInt(ocIdCounter);
  const time = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) time[i] = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
  const rand = randomBytes(14);
  let suffix = '';
  for (let i = 0; i < 14; i++) suffix += OC_ID_ALPHABET[rand[i]! % 62];
  return `${prefix}_${time.toString('hex')}${suffix}`;
}
