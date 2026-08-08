import { AGENT_SKILL_RESOURCE_IDS } from './agent-skill.ts';
import { OPENCODE_SHIM_RC_RESOURCE_IDS, OPENCODE_SHIM_RESOURCE_ID } from './opencode-shim.ts';
import { TAILSCALE_SERVE_RESOURCE_ID } from './tailscale-serve.ts';

/**
 * Every installed-resource id the setup catalog can commit, and the single source of truth for the uninstall
 * planner's "unknown receipt" catch-all (an id NOT in this set is preserved as `resource-<id>-preserved`).
 *
 * INVARIANT: every id here MUST have a matching uninstall handler in broker-lifecycle.ts — an id branch or a
 * kind branch that removes the resource when owned and preserves it on drift.
 *
 * scripts/broker/tests/broker/test-opencode-shim-symmetry.ts enforces this by (a) building the full setup
 * action catalog with realistic inputs, collecting every id any action emits, and asserting each is a member
 * of this set; and (b) for each such id, running the uninstall PLAN against a receipt that contains it and
 * asserting the planner does NOT drop it into the `resource-<id>-preserved` unknown catch-all (i.e. it has a
 * real handler). The test verifies handler presence, not per-id remove/preserve correctness.
 */
export const KNOWN_INSTALL_RESOURCE_IDS: ReadonlySet<string> = new Set<string>([
  'broker-binary',
  'broker-binary-previous',
  'broker-alias',
  'service-systemd',
  'service-launchd',
  'service-environment',
  'service-systemd-linger',
  'pi-bridge',
  TAILSCALE_SERVE_RESOURCE_ID,
  ...Object.values(AGENT_SKILL_RESOURCE_IDS),
  OPENCODE_SHIM_RESOURCE_ID,
  ...Object.values(OPENCODE_SHIM_RC_RESOURCE_IDS),
]);
