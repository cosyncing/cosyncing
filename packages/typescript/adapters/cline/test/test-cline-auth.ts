import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClineAcpEnvironment } from '../src/auth.ts';
import { CLINE_NATIVE_RENAME_TIMEOUT_MS } from '../src/implementation.ts';

// The shipped half of the old drive suite: how Cline API-key authentication is resolved. None of it
// involves the unshipped ACP writer.
let passed = 0;
const check = (name: string, condition: unknown, detail = '') => {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
};

const root = mkdtempSync(join(tmpdir(), 'cosyncing-cline-auth-'));
const dataRoot = join(root, 'cline-data');
try {
  check('production native rename budget covers measured slow Cline history updates',
    CLINE_NATIVE_RENAME_TIMEOUT_MS === 30_000);
  const explicitAuthPath = join(root, 'cline-openai-compatible.json');
  writeFileSync(explicitAuthPath, JSON.stringify({
    provider: 'openai-compatible', model: 'fixture/model', apiKey: 'fixture-secret',
  }), { mode: 0o600 });
  const fileAuth = await resolveClineAcpEnvironment({
    env: { COSYNCING_CLINE_AUTH_FILE: explicitAuthPath },
  });
  check('Cline API-key auth uses an explicit owner-only cosyncing file, not native provider settings',
    fileAuth?.provider === 'openai-compatible' && fileAuth.model === 'fixture/model'
      && fileAuth.source === 'auth-file' && fileAuth.env.CLINE_API_KEY === 'fixture-secret');
  chmodSync(explicitAuthPath, 0o644);
  check('world-readable Cline auth files fail closed',
    await resolveClineAcpEnvironment({ env: { COSYNCING_CLINE_AUTH_FILE: explicitAuthPath } }) === undefined);
  chmodSync(explicitAuthPath, 0o600);
  const providerSettings = join(dataRoot, 'settings', 'providers.json');
  mkdirSync(join(dataRoot, 'settings'), { recursive: true });
  writeFileSync(providerSettings, JSON.stringify({ providers: {
    'openai-compatible': { settings: { provider: 'openai-compatible', model: 'forbidden', apiKey: 'forbidden' } },
  } }), { mode: 0o600 });
  check('Cline native providers.json is never an adapter authentication source',
    await resolveClineAcpEnvironment({ env: {} }) === undefined);
  check('partial explicit Cline environment fails closed instead of falling through to the auth file',
    await resolveClineAcpEnvironment({
      env: { COSYNCING_CLINE_AUTH_FILE: explicitAuthPath, CLINE_API_KEY: 'partial-secret' },
    }) === undefined
      && await resolveClineAcpEnvironment({
      env: { COSYNCING_CLINE_AUTH_FILE: explicitAuthPath, CLINE_MODEL: 'partial/model' },
      }) === undefined
      && await resolveClineAcpEnvironment({
        env: { COSYNCING_CLINE_AUTH_FILE: explicitAuthPath, CLINE_API_KEY: '' },
      }) === undefined
      && await resolveClineAcpEnvironment({
        env: { COSYNCING_CLINE_AUTH_FILE: explicitAuthPath, CLINE_API_KEY: 'x'.repeat(4_097) },
      }) === undefined);
  console.log(`\n${passed} passed, 0 failed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
