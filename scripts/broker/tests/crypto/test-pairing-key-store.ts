import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createQrPairingPayload,
  generateDataKey,
  generateIdentityKeyPair,
  generateX25519KeyPair,
  loadOrCreateLocalKeyStore,
  parseQrPairingPayload,
  unwrapDataKey,
  wrapDataKeyForPeer,
} from '../../../../packages/typescript/crypto/src/index.ts';

let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
}

function throws(name: string, fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
    check(name, false, 'did not throw');
  } catch (err) {
    check(name, pattern.test(String(err)), String(err));
  }
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-pairing-store-'));
try {
  const broker = loadOrCreateLocalKeyStore(join(root, 'broker'), 'broker');
  const brokerReloaded = loadOrCreateLocalKeyStore(join(root, 'broker'), 'broker');
  check('identity key reloads from disk', broker.identity.publicKey === brokerReloaded.identity.publicKey);
  check('x25519 key reloads from disk', broker.exchange.publicKey === brokerReloaded.exchange.publicKey);
  check('key file mode is owner-only', (statSync(join(root, 'broker', 'cosyncing-keys.json')).mode & 0o077) === 0);

  const phoneIdentity = generateIdentityKeyPair();
  const phoneExchange = generateX25519KeyPair();
  const qr = createQrPairingPayload({
    brokerId: 'broker-1',
    publicKey: broker.exchange.publicKey,
    transport: { kind: 'tailscale-direct', url: 'http://127.0.0.1:7734' },
  });
  const parsed = parseQrPairingPayload(qr);
  check('QR carries broker public exchange key', parsed.publicKey === broker.exchange.publicKey);
  check('QR does not carry private key material', !JSON.stringify(parsed).includes(broker.exchange.privateKey) && !qr.includes(broker.exchange.privateKey));

  const dataKey = generateDataKey();
  const wrapped = wrapDataKeyForPeer(dataKey, phoneExchange.publicKey);
  const unwrapped = unwrapDataKey(wrapped, phoneExchange.privateKey);
  check('wrapped DataKey opens on paired phone exchange key', Buffer.from(unwrapped).equals(Buffer.from(dataKey.bytes)));
  const wrong = generateX25519KeyPair();
  throws('wrapped DataKey rejects wrong private key', () => unwrapDataKey(wrapped, wrong.privateKey), /authenticate|bad decrypt|Unsupported state|unable/i);

  const raw = readFileSync(join(root, 'broker', 'cosyncing-keys.json'), 'utf8');
  check('persisted key store records identity and exchange keys', raw.includes(broker.identity.publicKey) && raw.includes(broker.exchange.publicKey));
  check('phone identity is generated independently', phoneIdentity.publicKey !== broker.identity.publicKey);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nFAIL: ${failed} crypto pairing key-store test(s) failed.`);
  process.exit(1);
}

console.log('\nPASS crypto pairing key-store tests');
