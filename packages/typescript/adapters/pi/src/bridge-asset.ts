import { createHash } from 'node:crypto';
import piBridgeEmbeddedSource from '../agent-extensions/cosyncing-bridge/index.ts' with { type: 'text' };
import { PRODUCT_IDENTITY } from '@cosyncing/adapter-api';

// TypeScript resolves a `.ts` import as a module even when Bun's text loader is selected. At runtime and in
// a compiled executable, the import attribute yields source bytes. Core identity substitution keeps the
// installed state path aligned with the parameterized product name without importing broker runtime code.
export const PI_BRIDGE_EMBEDDED_SOURCE = (piBridgeEmbeddedSource as unknown as string)
  .replaceAll('__COSYNCING_STATE_DIRECTORY__', PRODUCT_IDENTITY.stateDirectoryName);
export const PI_BRIDGE_LEGACY_MARKER = 'cosyncing — Pi live bridge extension';
export const PI_BRIDGE_EMBEDDED_SHA256 = createHash('sha256').update(PI_BRIDGE_EMBEDDED_SOURCE).digest('hex');
