/**
 * What a gate's run means: pass or fail, required or advisory, and why.
 *
 * Extracted from the runner so the PRECEDENCE is testable. The order these
 * rules apply in is the whole content of the decision, and getting it wrong is
 * silent: an advisory gate whose findings match its baseline is reported as an
 * expected failure, and for a while that also swallowed the fact that the gate
 * had leaked processes. A matching baseline says the findings are the known
 * ones. It says nothing about the process tree.
 */
export type GateStatus = 'pass' | 'fail';
export type GateRequirement = 'required' | 'advisory';

export interface BaselineOutcome {
  matches: boolean;
  added: number;
  removed: number;
  expectedCount: number;
  actualCount: number;
}

export interface GateOutcomeInput {
  /** What the inventory declares this gate to be. */
  declaredRequirement: GateRequirement;
  /** The supervised child exited zero. */
  success: boolean;
  timedOut: boolean;
  /** The child left processes behind and the supervisor reaped them. */
  strays: boolean;
  timeoutMs: number;
  timeoutClass: string;
  /** The summary line derived from the child's own output. */
  observedSummary: string;
  /** Present only for gates that carry an advisory policy baseline. */
  baseline?: BaselineOutcome;
  missingArtifacts: string[];
}

export interface GateOutcome {
  requirement: GateRequirement;
  status: GateStatus;
  summary: string;
}

export function gateOutcome(input: GateOutcomeInput): GateOutcome {
  let requirement = input.declaredRequirement;
  let status: GateStatus = input.success && !input.timedOut ? 'pass' : 'fail';
  let summary = input.timedOut
    ? `FAIL timed out after ${input.timeoutMs}ms (${input.timeoutClass})`
    : input.observedSummary;

  // An advisory gate is allowed to fail, but only in exactly the way it is
  // known to fail. Any drift is a required failure.
  if (input.baseline && !input.baseline.matches) {
    requirement = 'required';
    status = 'fail';
    summary = `FAIL advisory baseline changed: +${input.baseline.added} -${
      input.baseline.removed
    }; expected ${input.baseline.expectedCount}, received ${
      input.baseline.actualCount
    }`;
  }

  // A gate that produced no evidence has not run, whatever its exit code said.
  if (input.missingArtifacts.length > 0) {
    requirement = 'required';
    status = 'fail';
    summary = `FAIL missing expected artifact(s): ${
      input.missingArtifacts.join(', ')
    }`;
  }

  // Last, and unconditional: a gate that leaves processes behind has not
  // passed, and no baseline can excuse it. The deterministic lane already
  // fails its own sub-suites for this; without the same rule here a browser
  // gate could leak a Chrome and still be green, with `strayGates: 1` sitting
  // in the report next to `requiredFail: 0`.
  if (input.strays) {
    requirement = 'required';
    status = 'fail';
    summary = 'FAIL exited leaving processes behind; the runner reaped them';
  }

  return { requirement, status, summary };
}
