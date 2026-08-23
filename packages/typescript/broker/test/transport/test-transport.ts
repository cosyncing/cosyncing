import { strict as assert } from 'node:assert';
import {
  BrokerHttpTransport,
  MemoryRelay,
  textEnvelope,
} from '../../../transport/src/index.ts';

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name} - ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

let failed = 0;

await test('relay transport carries opaque envelopes in order', async () => {
  const relay = new MemoryRelay();
  const phone = relay.endpoint('phone');
  const broker = relay.endpoint('broker');
  await phone.send(textEnvelope({ id: 'm1', from: 'phone', to: 'broker', channel: 'session', text: 'hello' }));
  await phone.send({ id: 'm2', from: 'phone', to: 'broker', channel: 'bytes', bytes: new Uint8Array([0, 1, 255]) });

  const received: any[] = [];
  for await (const env of broker.receive()) {
    received.push(env);
    if (received.length === 2) break;
  }

  assert.equal(received[0]?.id, 'm1');
  assert.equal(new TextDecoder().decode(received[0]?.bytes), 'hello');
  assert.deepEqual([...received[1].bytes], [0, 1, 255]);
});

await test('Broker HTTP transport posts raw envelope bytes with metadata headers', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new BrokerHttpTransport({
    baseUrl: 'http://cosyncing.test',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    },
  });

  await transport.send({ id: 'm3', from: 'phone', to: 'broker', channel: 'ciphertext', bytes: new Uint8Array([7, 8, 9]) });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'http://cosyncing.test/api/transport/envelopes');
  assert.equal(calls[0]?.init.method, 'POST');
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers['x-cosyncing-envelope-id'], 'm3');
  assert.equal(headers['x-cosyncing-channel'], 'ciphertext');
  assert.deepEqual([...new Uint8Array(calls[0]?.init.body as ArrayBuffer)], [7, 8, 9]);
});

await test('Broker HTTP transport receives broker mailbox envelopes', async () => {
  let calls = 0;
  const transport = new BrokerHttpTransport({
    baseUrl: 'http://cosyncing.test',
    peerId: 'phone',
    peerToken: 'phone-token',
    pollMs: 1,
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), 'http://cosyncing.test/api/transport/envelopes?peer=phone');
      assert.equal((init?.headers as Record<string, string>)['x-cosyncing-peer-token'], 'phone-token');
      return Response.json({
        envelopes: [{
          id: 'm4',
          from: 'broker',
          to: 'phone',
          channel: 'ciphertext',
          headers: { 'x-cosyncing-wire-kind': 'cipher-envelope' },
          bytes: Buffer.from(new Uint8Array([10, 11, 12])).toString('base64url'),
        }],
      });
    },
  });

  const ac = new AbortController();
  const received: any[] = [];
  for await (const env of transport.receive(ac.signal)) {
    received.push(env);
    ac.abort();
    break;
  }

  assert.equal(calls, 1);
  assert.equal(received[0]?.id, 'm4');
  assert.equal(received[0]?.headers?.['x-cosyncing-wire-kind'], 'cipher-envelope');
  assert.deepEqual([...received[0].bytes], [10, 11, 12]);
});

if (failed) {
  console.error(`\nFAIL: ${failed} transport test(s) failed.`);
  process.exit(1);
}

console.log('\nPASS transport tests');
