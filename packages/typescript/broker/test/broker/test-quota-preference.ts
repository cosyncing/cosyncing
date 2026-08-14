#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getQuotaWarningsEnabled,
  setQuotaWarningsEnabled,
} from '../../src/installation/setup-state.ts';

const home = mkdtempSync(join(tmpdir(), 'cosyncing-quota-preference-'));
const previous = process.env.COSYNCING_HOME;
process.env.COSYNCING_HOME = home;
try {
  assert.equal(getQuotaWarningsEnabled(), false, 'quota warnings must be opt-in');
  setQuotaWarningsEnabled(true);
  assert.equal(getQuotaWarningsEnabled(), true);
  const stored = JSON.parse(readFileSync(join(home, 'setup-state.json'), 'utf8'));
  assert.equal(stored.quotaWarningsEnabled, true);

  writeFileSync(join(home, 'setup-state.json'), JSON.stringify({ quotaWarningsEnabled: 'yes', preserved: 1 }));
  assert.equal(getQuotaWarningsEnabled(), false, 'malformed values fail closed');
  setQuotaWarningsEnabled(false);
  const rewritten = JSON.parse(readFileSync(join(home, 'setup-state.json'), 'utf8'));
  assert.equal(rewritten.quotaWarningsEnabled, false);
  assert.equal(rewritten.preserved, 1, 'unrelated setup keys survive preference writes');
  console.log('PASS: quota-warning preference is separate, durable, and default-off');
} finally {
  if (previous == null) delete process.env.COSYNCING_HOME;
  else process.env.COSYNCING_HOME = previous;
  rmSync(home, { recursive: true, force: true });
}
