import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Publication is a flat closed set, including hidden entries; links and directories cannot hide assets. */
export function exactReleaseFiles(directory: string, expected: readonly string[]): void {
  const actual = readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`release asset set mismatch; expected: ${expected.join(', ')}; actual: ${actual.join(', ')}`);
  }
  for (const name of actual) {
    if (!lstatSync(join(directory, name)).isFile()) {
      throw new Error(`release asset must be a regular file: ${name}`);
    }
  }
}

/** Check the payload itself before signing or publishing. Desktop archives are outside this broker check. */
export function assertJavaScriptBroker(bytes: Uint8Array): void {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.startsWith('#!/usr/bin/env bun\n') && !text.startsWith('#!/usr/bin/env bun\r\n')) {
    throw new Error('broker payload must be JavaScript with a Bun interpreter line; embedded-runtime broker distribution remains blocked');
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || !text.split('\n').slice(1).join('\n').trim()) {
    throw new Error('broker payload must be nonempty JavaScript text');
  }
  // Parsing catches shell wrappers, archives, and executable bytes disguised with a JavaScript filename.
  new Bun.Transpiler({ loader: 'js', target: 'bun' }).transformSync(text);
}
