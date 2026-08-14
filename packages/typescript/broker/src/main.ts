import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
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
    console.error(`[${PRODUCT_IDENTITY.productName}] broker failed: ${detail}`);
    process.exitCode = 1;
  }
}
