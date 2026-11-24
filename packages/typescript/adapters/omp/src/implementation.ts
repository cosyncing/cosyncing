/**
 * omp (oh-my-pi) adapter — the shared Pi engine composed with the omp dialect.
 *
 * `OmpAdapter` IS `PiEngineAdapter` bound to `OMP_RUNTIME`; it carries no engine code of its own
 * beyond the fork hook. omp has no RPC `clone`, so cloneSession stays absent (canClone=false). Its
 * RPC `fork` was removed and came back: 17.4.2 has none, 19.1.0 has it (measured), so forkSession is
 * present and `canForkSession` answers from the configured omp's version.
 */
import {
  inspectDialectBridgeAsset,
  PiEngineAdapter,
  resolvePiDialectRuntime,
  runPiLifecycleAction,
  type PiAdapterOptions,
  type PiDialectRuntime,
} from '@cosyncing/pi-engine';
import { CLIENT_REVISION_WITH_OMP_ROSTER_IDENTITY, type SessionInfo } from '@cosyncing/adapter-api';
import { inspectOmpPathCollision, OMP_DIALECT } from './dialect.ts';
import { OMP_BRIDGE_EMBEDDED_SHA256, OMP_BRIDGE_EMBEDDED_SOURCE } from './bridge-asset.ts';
import {
  currentOmpRuntimeReadiness,
  OMP_RPC_FORK_MINIMUM_VERSION,
  ompSupportsRpcFork,
  type OmpRuntimeReadiness,
} from './runtime-readiness.ts';
import { diagnoseOmpSetup } from './diagnostics.ts';

/**
 * The omp dialect resolved against the process environment at module load — the same
 * module-level-constants timing the pi adapter always had (tests set the env, then import).
 */
export const OMP_RUNTIME: PiDialectRuntime = resolvePiDialectRuntime(OMP_DIALECT, process.env, {
  hooks: {
    readiness: () => {
      const collision = inspectOmpPathCollision(process.env);
      if (collision) {
        return {
          ready: false,
          blocksSessionAccess: true,
          detailCode: collision.code,
          message: `${collision.summary} ${collision.remediation}`,
        };
      }
      return currentOmpRuntimeReadiness();
    },
    diagnose: (context, inspectBridge) => diagnoseOmpSetup(context, { inspectBridge }),
  },
  bridgeAsset: {
    source: OMP_BRIDGE_EMBEDDED_SOURCE,
    sha256: OMP_BRIDGE_EMBEDDED_SHA256,
  },
});

/** omp takes the same adapter options as pi (broker URL + integration-file flag). */
export type OmpAdapterOptions = PiAdapterOptions;

export class OmpAdapter extends PiEngineAdapter {
  /**
   * omp declares only long-decodable wire values (integrationKind 'jsonrpc-stdio'; attach modes
   * live/resume/observe), so this is NOT the decode-tolerance floor the adapter-api doc describes —
   * that floor would be absent. It is the C7 review decision instead: an omp roster row is
   * second-class on any client that predates omp roster identity (label, tool color, New Session),
   * so only the client generation carrying that support is shown the row. This is an explicit
   * feature floor rather than an alias of the moving current revision. roster-visibility.ts applies
   * it; the value is never sent to clients.
   */
  readonly minimumClientRevision = CLIENT_REVISION_WITH_OMP_ROSTER_IDENTITY;

  constructor(opts: OmpAdapterOptions = {}) {
    super(OMP_RUNTIME, opts);
  }

  /** Fork is offered only while the configured omp is ready and is a build whose RPC has `fork`. */
  canForkSession(): boolean {
    const readiness = this.rt.hooks.readiness() as OmpRuntimeReadiness;
    return readiness.ready && ompSupportsRpcFork(readiness.packageVersion);
  }

  async forkSession(sessionId: string, opts: { messageId?: string | null } = {}): Promise<SessionInfo> {
    const readiness = this.rt.hooks.readiness() as OmpRuntimeReadiness;
    if (!readiness.ready) throw new Error(readiness.message);
    if (!ompSupportsRpcFork(readiness.packageVersion)) {
      const installed = readiness.packageVersion ? `omp ${readiness.packageVersion}` : 'This omp';
      throw new Error(`${installed} has no RPC fork; forking needs omp ${OMP_RPC_FORK_MINIMUM_VERSION}.`);
    }
    return runPiLifecycleAction(this.rt, sessionId, 'fork', {
      messageId: opts.messageId,
      brokerUrl: this.brokerUrl,
      bridgeUsesIntegrationFile: this.bridgeUsesIntegrationFile,
    });
  }
}

/** omp-dialect bridge inspection — the default export surface for the broker's omp routes. */
export function inspectOmpBridgeAsset(agentDir = OMP_RUNTIME.agentDir) {
  return inspectDialectBridgeAsset(OMP_RUNTIME, agentDir);
}
