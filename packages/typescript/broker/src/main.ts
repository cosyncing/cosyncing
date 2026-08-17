import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import { exitFatalStartup } from './runtime/fatal-start.ts';
import {
  installBrokerSignalHandlers,
  startBrokerRuntime,
} from './runtime/runtime.ts';

export * from './runtime/runtime.ts';

if (import.meta.main) {
  try {
    const runtime = startBrokerRuntime();
    installBrokerSignalHandlers(runtime);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // EXITS, rather than setting `process.exitCode` and falling out of the
    // block. A `startBrokerRuntime` that throws part-way can leave the event
    // loop non-empty, and this process would then run forever having announced
    // that it failed — never serving, never dying, and still holding whatever
    // its spawner is waiting on. See {@link exitFatalStartup}.
    exitFatalStartup(`[${PRODUCT_IDENTITY.productName}] broker failed: ${detail}`);
  }
}
