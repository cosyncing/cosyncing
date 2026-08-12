import { createHash } from 'node:crypto';
import piBridgeEmbeddedSource from '../agent-extensions/cosyncing-bridge/index.ts' with { type: 'text' };
import piBridgeV010LegacyAsset from '../assets/legacy/cosyncing-bridge-v0.1.0.json';
import { PRODUCT_IDENTITY } from '@cosyncing/adapter-api';

function decodeFrozenTextAsset(asset: unknown): string {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
    throw new Error('invalid frozen Pi bridge asset');
  }
  const record = asset as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.release !== '0.1.0'
    || !Array.isArray(record.lines) || !record.lines.every((line) => typeof line === 'string')
    || typeof record.trailingNewline !== 'boolean') {
    throw new Error('invalid frozen Pi bridge asset');
  }
  return `${record.lines.join('\n')}${record.trailingNewline ? '\n' : ''}`;
}

// TypeScript resolves a `.ts` import as a module even when Bun's text loader is selected. At runtime and in
// a compiled executable, the import attribute yields source bytes. Core identity substitution keeps the
// installed state path aligned with the parameterized product name without importing broker runtime code.
export const PI_BRIDGE_EMBEDDED_SOURCE = (piBridgeEmbeddedSource as unknown as string)
  .replaceAll('__COSYNCING_STATE_DIRECTORY__', PRODUCT_IDENTITY.stateDirectoryName);
export const PI_BRIDGE_LEGACY_MARKER = 'cosyncing — Pi live bridge extension';
/**
 * Exact bytes shipped by the immediately preceding v0.1.0 bridge. This asset must never be derived from
 * the current bridge: unrelated future edits cannot change which existing installations qualify for the
 * explicit legacy migration. Full-string equality is deliberate; any local edit remains `unowned`.
 */
export const PI_BRIDGE_KNOWN_LEGACY_SOURCE = decodeFrozenTextAsset(piBridgeV010LegacyAsset);
export const PI_BRIDGE_EMBEDDED_SHA256 = createHash('sha256').update(PI_BRIDGE_EMBEDDED_SOURCE).digest('hex');
