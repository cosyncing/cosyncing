/**
 * Pi adapter — integrationKind 'jsonrpc-stdio'.
 *
 * The dialect-parameterized engine lives in `@cosyncing/pi-engine`; this module binds it to the pi
 * dialect runtime (module-level resolution at import, as the adapter always did — tests set env,
 * then import) and adds the fork/clone lifecycle hooks only pi's RPC exposes.
 */
import {
  PiEngineAdapter,
  PI_DIALECT,
  inspectDialectBridgeAsset,
  resolvePiDialectRuntime,
  runPiLifecycleAction,
  type PiAdapterOptions,
  type PiBridgeAssetInspection,
  type PiDialectRuntime,
} from '@cosyncing/pi-engine';
import type { SessionInfo } from '@cosyncing/adapter-api';
import {
  PI_BRIDGE_EMBEDDED_SHA256,
  PI_BRIDGE_EMBEDDED_SOURCE,
  PI_BRIDGE_KNOWN_LEGACY_SOURCE,
} from './bridge-asset.ts';
import { currentPiRuntimeReadiness } from './runtime-readiness.ts';
import { diagnosePiSetup } from './diagnostics.ts';

/**
 * The pi dialect resolved against the process environment at module load — the exact values the
 * adapter always computed from its module-level constants (tests set the env, then import).
 */
export const PI_RUNTIME: PiDialectRuntime = resolvePiDialectRuntime(PI_DIALECT, process.env, {
  hooks: {
    readiness: () => currentPiRuntimeReadiness(),
    diagnose: (context, inspectBridge) => diagnosePiSetup(context, { inspectBridge }),
  },
  bridgeAsset: {
    source: PI_BRIDGE_EMBEDDED_SOURCE,
    sha256: PI_BRIDGE_EMBEDDED_SHA256,
    legacySource: PI_BRIDGE_KNOWN_LEGACY_SOURCE,
  },
});

/** The pi dialect adapter: the shared engine plus the fork/clone lifecycle hooks only pi exposes. */
export class PiAdapter extends PiEngineAdapter {
  constructor(opts: PiAdapterOptions = {}) {
    super(PI_RUNTIME, opts);
  }

  async forkSession(sessionId: string, opts: { messageId?: string | null } = {}): Promise<SessionInfo> {
    return runPiLifecycleAction(this.rt, sessionId, 'fork', {
      messageId: opts.messageId,
      brokerUrl: this.brokerUrl,
      bridgeUsesIntegrationFile: this.bridgeUsesIntegrationFile,
    });
  }

  async cloneSession(sessionId: string): Promise<SessionInfo> {
    return runPiLifecycleAction(this.rt, sessionId, 'clone', {
      brokerUrl: this.brokerUrl,
      bridgeUsesIntegrationFile: this.bridgeUsesIntegrationFile,
    });
  }
}

/** Pi-dialect bridge inspection — the historical default export surface for the broker. */
export function inspectPiBridgeAsset(agentDir = PI_RUNTIME.agentDir): PiBridgeAssetInspection {
  return inspectDialectBridgeAsset(PI_RUNTIME, agentDir);
}

// The bridge asset constants remain importable from this module path (broker setup/tests).
export {
  PI_BRIDGE_EMBEDDED_SHA256,
  PI_BRIDGE_EMBEDDED_SOURCE,
  PI_BRIDGE_KNOWN_LEGACY_SOURCE,
  PI_BRIDGE_LEGACY_MARKER,
} from './bridge-asset.ts';
export type { PiAdapterOptions, PiBridgeAssetInspection } from '@cosyncing/pi-engine';
