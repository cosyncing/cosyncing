import type { R2ActionDescriptor } from '../types.ts';

const MiB = 1024 * 1024;

/**
 * Reviewed R2 action registry (GPT-Pro §2 rules 1-3/10/15/18/20 + maintainer §4.5 defaults, verified
 * 2026-07-03). This is DATA the broker consults generically — never a tool-name branch. Adding an R2
 * action means adding a reviewed descriptor here, not a code path in broker/app. Only `transcriptExport`
 * is defined today; session delete stays an excluded reviewed non-action (no descriptor => not offered).
 */
export const R2_ACTIONS: R2ActionDescriptor[] = [
  {
    schemaVersion: 1,
    id: 'transcriptExport',
    riskClass: 'R2',
    // T1 same-machine may run R2 with confirm; T2 own-network device may run it only when locally
    // enabled (requiresLocalEnablement below). T3 is never allowed (not listed).
    allowedTrustTiers: ['T1', 'T2'],
    requiresConfirm: true,
    requiresLocalEnablement: true,
    deliveryClass: 'export-attachment',
    // Read-only export: the weak `session-timestamp` revision is acceptable here (60s nonce TTL +
    // single-use). A future destructive R2 action MUST set mutatesSession:true and a content-derived
    // revisionBinding — `assertR2ActionsSafe` refuses to start otherwise (maintainer Decision #2).
    mutatesSession: false,
    revisionBinding: 'session-timestamp',
    // Execute body may carry ONLY the confirmation nonce. Any client-supplied path/filename/dir is a
    // schema rejection (rule 6 / do-not-build "no client-supplied output paths").
    paramSchema: {
      allowedKeys: ['nonce'],
      rejectKeys: ['outputPath', 'output_path', 'path', 'filename', 'file', 'directory', 'dir', 'dest', 'destination'],
    },
    sizeCapBytes: 25 * MiB, // maintainer §4.5 #4 default
    localMaxBytes: 100 * MiB, // maintainer §4.5 #4 hard local ceiling
    retentionMs: 30 * 60 * 1000, // maintainer §4.5 #2
    nonceTtlMs: 60 * 1000, // rule 3 (≤60s)
    timeoutMs: 60 * 1000, // rule 9 default
    localMaxTimeoutMs: 300 * 1000, // rule 9 local hard max
    rateLimit: {
      perSessionWindowMs: 10 * 60 * 1000,
      perSessionMax: 3, // rule 20: 3 exports / session / 10 min
      perBrokerWindowMs: 60 * 60 * 1000,
      perBrokerMax: 10, // rule 20: 10 exports / broker / hour
    },
  },
];

export function getR2Action(id: string): R2ActionDescriptor | undefined {
  return R2_ACTIONS.find((a) => a.id === id);
}
