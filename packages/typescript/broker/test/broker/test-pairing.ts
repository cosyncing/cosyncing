import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQrPairingPayload } from '@cosyncing/crypto';
import {
  pairingBrokerUrlUsesUnprotectedHttp,
  normalizePairingBrokerUrl,
  PairingBrokerUrlError,
} from '../../src/transport/pairing-url.ts';
import { PairingHttpError, TransportPairingRegistry } from '../../src/transport/transport-pairing.ts';

const home = mkdtempSync(join(tmpdir(), 'cosyncing-pairing-'));

try {
  const registry = new TransportPairingRegistry({ home, now: () => Date.parse('2026-08-22T12:00:00Z') });

  const urlFree = parseQrPairingPayload(registry.createOffer({ clientLabel: 'phone' }).qr);
  assert.equal(urlFree.version, 3);
  assert.equal(urlFree.transport.kind, 'broker-url');
  assert.equal('url' in urlFree.transport, false);

  const reachable = parseQrPairingPayload(registry.createOffer({
    brokerUrl: 'https://example.test/',
  }).qr);
  assert.deepEqual(reachable.transport, { kind: 'broker-url', url: 'https://example.test' });

  assert.equal(normalizePairingBrokerUrl('http://127.0.0.1:7734/'), 'http://127.0.0.1:7734');
  assert.equal(normalizePairingBrokerUrl(undefined), undefined);
  assert.equal(pairingBrokerUrlUsesUnprotectedHttp('http://127.0.0.1:7734'), false);
  assert.equal(pairingBrokerUrlUsesUnprotectedHttp('http://broker.example:7734'), true);
  assert.throws(() => normalizePairingBrokerUrl('ftp://example.test'), PairingBrokerUrlError);
  assert.throws(() => normalizePairingBrokerUrl('https://user:secret@example.test'), PairingBrokerUrlError);
  assert.throws(() => registry.createOffer({ brokerUrl: 'https://example.test/path' }), (error: unknown) =>
    error instanceof PairingHttpError && error.code === 'PAIRING_INVALID_INPUT');

  const invalid = JSON.parse(readFileSync(join(
    import.meta.dir,
    '../../../crypto/test-vectors/pairing-invalid.json',
  ), 'utf8')) as { cases: Array<{ name: string; payload: unknown }> };
  for (const fixture of invalid.cases) {
    const qr = `cosyncing://pair?payload=${Buffer.from(JSON.stringify(fixture.payload)).toString('base64url')}`;
    assert.throws(() => parseQrPairingPayload(qr), Error, fixture.name);
  }

  console.log('PASS provider-neutral pairing URL and shared invalid-fixture contracts');
} finally {
  rmSync(home, { recursive: true, force: true });
}
