#!/usr/bin/env bun

import { strict as assert } from 'node:assert';
import { normalizeOpenCodeRetryDetail } from '../../../../packages/typescript/adapters/opencode/src/implementation.ts';

const longDetail = `\u0000\u0007\n\n  ${'😀'.repeat(300)}\nignored second line`;
const normalized = normalizeOpenCodeRetryDetail(longDetail, 4);

assert.equal([...normalized].length, 240);
assert.equal(normalized.endsWith('…'), true);
assert.equal(normalized.includes('\n'), false);
assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(normalized), false);
assert.equal(normalized.startsWith('😀'), true);
assert.equal(normalized.includes('ignored'), false);

assert.equal(
  normalizeOpenCodeRetryDetail('\n\u0000\n  provider unavailable  \nnext', undefined),
  'provider unavailable',
);
assert.equal(
  normalizeOpenCodeRetryDetail('\u0000\n\u0007', 2),
  'Retrying… (retry #2)',
);

console.log('OpenCode retry detail normalization tests passed');
