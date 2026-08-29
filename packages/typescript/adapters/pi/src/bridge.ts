/**
 * Compatibility surface: the bridge engine lives in the shared pi-engine package; the historical
 * adapter module path keeps working for the broker and its tests.
 */
export { PiBridgeConnection, PiBridgeRegistry, type BridgeCommand } from '@cosyncing/pi-engine';
