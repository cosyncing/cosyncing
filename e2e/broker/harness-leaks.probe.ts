/**
 * A test process for `harness-leaks.test.ts` to kill: it starts a harness broker that owns a managed
 * host (the fake `kilo serve`), prints what it started as one JSON line, and waits.
 *
 *   bun run e2e/broker/harness-leaks.probe.ts
 */
import { startBroker } from '../harness/index.ts';
import { installKilo, type KiloFake, kilocodeKit } from '../adapters/kits/kilocode.ts';

let fake!: KiloFake;
const broker = await startBroker({
  name: 'leak-probe',
  env: (paths) => kilocodeKit.env(paths),
  setup: async (paths) => {
    fake = await installKilo(paths);
  },
});
await kilocodeKit.ready?.({ broker, client: broker.client(), fake });
console.log(JSON.stringify({ root: broker.paths.root, broker: broker.pid, serves: fake.serves().map((serve) => serve.pid) }));
// Held open until this process is killed.
setInterval(() => {}, 60_000);
