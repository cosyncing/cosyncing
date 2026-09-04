# Roadmap

This page describes where cosyncing is going. It lists open product work, not a
release schedule. Priorities may change as real-world testing exposes more
important problems. Shipped work belongs in the [changelog](../CHANGELOG.md).

## Now

### Make releases and upgrades dependable

- Keep installation and package-manager updates predictable.
- Reduce CI flakes without weakening contract, security, or release checks.
- Test changes that affect installation or platform behavior on packaged
  clients and supported broker hosts.

### Finish Kimi Code and DeepSeek Harness support

Both shipped as provisional integrations. What remains before either becomes a
full support claim:

- Add Kimi file and image input.
- Add the DeepSeek Harness background subscription and its remaining
  presentation work. Non-image file input stays unavailable while the host
  accepts image content only.
- Complete the physical acceptance each one needs on the platforms its claims
  depend on.
- Keep unsupported functions visibly unavailable instead of approximating them,
  and leave the behavior and compatibility of existing adapters unchanged.

## Next

### Improve the everyday session experience

- Make session health, control ownership, pending questions, and permissions
  easier to understand.
- Improve usage, runtime, and context reporting where an agent exposes reliable
  evidence.
- Continue real-session testing across agents, clients, and desktop form
  factors.
- Keep shared behavior agent-neutral; provider-specific code stays inside its
  adapter.
- Show subagent sessions as nested roster rows for OpenCode. Claude Code, Kimi
  Code, Codex, and DeepSeek Harness nest them under the parent session today;
  OpenCode surfaces subagent work inside the transcript only, so the roster's
  background-session toggle has nothing to collapse there.

## Later

### Easier connections and broader platform support

- Support more than one broker in a client with clear identity and credential
  separation.
- Explore automatic discovery and relay/NAT traversal without weakening pairing
  security.
- Qualify Windows ARM64 broker hosting. Windows x64 is supported now; ARM64 is
  refused as not yet qualified, and clearing that needs a Bun floor of at least
  1.3.10, a windows-11-arm lane, the native suites run there, and its own
  physical pass.
- Evaluate tray operation, background tasks, notifications, and remote wake per
  platform before advertising them.

### Richer interaction

- Add interactive artifacts and agent-generated UI only with a defined sandbox
  and authority model.
- Consider PTY/SSH access and remote workspace mutation only after authorization,
  containment, audit, and recovery are designed.
- Improve long-running transfers, retention, cleanup, and interruption recovery.

### More agents and native capabilities

- Add more adapters when their current runtime offers stable interfaces and the
  required conformance evidence can be maintained.
- Expand existing adapters only when upstream evidence supports the claim—for
  example, richer Claude synchronization, native planning channels, or native
  usage limits.

### Compiled native broker distribution

The npm package remains the supported broker distribution. Compiled native
broker releases stay blocked until legal review, signing, protected release
infrastructure, rollback testing, and clean-host platform acceptance are all in
place.

## How roadmap work is accepted

Roadmap items ship only when:

- advertised capabilities match tested behavior;
- unavailable or unsafe behavior fails closed;
- credentials and local agent data remain broker-local;
- protocol, adapter, client, and upgrade compatibility checks pass; and
- public claims are backed by deterministic tests and the necessary physical
  platform evidence.

Detailed implementation plans and machine-specific evidence are maintained
privately. Public support claims are tracked in the
[adapter support documentation](../protocol/adapter-support.md).
