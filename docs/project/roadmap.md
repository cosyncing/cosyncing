# Roadmap

Last updated: 2026-07-29.

This roadmap contains open work only. Completed predecessor milestones are not
repeated as future work. Each item must name an owner, an activation condition,
and acceptance evidence before implementation starts. The maintainers' internal
roadmap source audit records how predecessor plans and code TODO markers were
dispositioned; it is kept outside the public tree.

## Now: public readiness and first release proof

- Pass every required GitHub-hosted workflow lane and validate workflow syntax.
- Complete history, secret, private-hostname, personal-path, and binary
  provenance audits with zero unresolved findings.
- Apply the branch, tag, environment, fork-approval, and token settings in the
  maintainers' internal release checklist.
- Exercise a real fork pull request without secrets.
- Resolve and record the compiled Bun runtime distribution obligations; keep the
  binary-release legal gate closed until approval.
- Run broker prerelease, the real app-triggered upgrade/unhealthy-rollback
  exercise, and stable promotion from hosted infrastructure.
- Run packaged platform acceptance for every client and broker host included in
  release claims. An unavailable capability must remain unclaimed.

## Next: first post-consolidation product wave

### R-01: clickable workspace file references in the Flutter client

Make references such as `lib/example.dart:42:7` useful from session transcripts
without turning arbitrary model text into authority.

Scope:

- Render explicit paths from typed filesystem-edit and file-artifact messages as
  links. Add conservative recognition of workspace-relative `path:line:column`
  references in model and tool text.
- Activate explicit Markdown file references such as
  `[friendly label](workspace/path)` without hiding the target location.
  Pre-release transcript rendering keeps these targets visible and copyable but
  deliberately non-actionable; R-01 owns the later click/open behavior.
- Resolve every link against the selected session's broker-owned workspace and
  existing read-only file API. Opening a link selects the Files surface and the
  referenced file or preview; line and column are hints, not separate authority.
- Keep the behavior agent-neutral. Renderers and controllers must not branch on
  Claude, Codex, Kimi, OpenCode, Pi, or a tool command name.
- Reject traversal, symlink escape, unsupported schemes, arbitrary external
  URLs, and host-local `file:` URLs. An unresolved reference remains selectable
  and copyable text.
- Support keyboard, pointer, touch, and screen-reader activation across Flutter
  web and native clients. The retained PoC UI is not a parity gate.

Acceptance:

- Parser tests cover relative paths, spaces, punctuation, line/column suffixes,
  Windows-looking text, URLs, Markdown label/target pairs, traversal attempts,
  code fences, and false positives.
- Widget/controller tests prove typed and recognized links open only the current
  session's jailed read-only file surface and preserve ordinary text selection.
- Broker filesystem tests remain the authority for path containment and symlink
  rejection; the client does not duplicate or weaken that policy.
- A real-session audit covers at least two registered adapters and one missing,
  renamed, or denied file.

Owner: client and protocol maintainers. This can start after the public-release
baseline is stable; it does not require Kimi support.

### R-02: Kimi Code adapter support

Add Kimi as a fifth adapter through the same protocol and evidence system used
by the four registered adapters. Historical research is a starting point, not
an API guarantee: re-audit the current Kimi CLI, persisted session format, and
supported structured control interface before selecting a transport.

Scope:

- Implement read-only discovery, bounded history, stable identity, and live
  observation from canonical Kimi evidence first.
- Add create/resume/Drive only through a currently supported structured
  interface. Do not claim true live terminal coexistence without multi-client
  evidence from the current upstream runtime.
- Map messages, thinking, tool calls/results, edits, usage, status, permissions,
  questions, and files into existing canonical protocol families. Unsupported
  capabilities remain explicit.
- Keep Kimi credentials and session stores broker-local. Setup, doctor, repair,
  upgrade, and uninstall must never expose or rewrite upstream credentials
  without an approved, receipt-owned operation.
- Add an adapter capability manifest, support-matrix column, conformance tests,
  deterministic fixtures, and opt-in real-runtime trajectories. No Kimi-specific
  branch may enter the Flutter client.

Acceptance:

- Discovery/history/reattach and stable replay pass deterministic and real-store
  evidence lanes.
- Every advertised capability has the required evidence level; unavailable
  functions render honest read-only or unsupported states.
- File-edit references feed the same typed filesystem surfaces used by R-01,
  while image or file input is enabled only when current runtime evidence proves
  it.
- Existing four-adapter conformance, broker aggregate, contract drift, and
  Flutter suites remain green.

Owner: adapter and protocol maintainers. R-02 can start after the public-release
baseline is stable and a maintainer supplies a clean current-runtime evidence
scope. It is the promoted Kimi slice of the former generic additional-adapter
item; other adapters remain D-06.

## Later and decision-gated work

| Item | Owner | Activation condition |
|---|---|---|
| D-01: updater expansion beyond explicit signed stable/pinned-candidate actions | product and security/release maintainers | Silent automation, extra channels, fleet rollout, or remote policy is proposed and receives a separate threat review |
| D-02: automatic discovery, relay/NAT traversal, and credential provisioning | product and transport/security maintainers | Zero-configuration remote connection enters supported scope |
| D-03: interactive artifact execution | client and security maintainers | Interaction beyond display-only trusted content is required and sandbox policy is approved |
| D-04: production remote wake | client/platform and privacy maintainers | Remote wake becomes an advertised capability and deployment ownership exists |
| D-05: PTY/SSH and remote workspace mutation | broker/security and client maintainers | Authorization, containment, audit, and recovery models are approved |
| D-06: additional adapters other than Kimi | adapter maintainer | A launch requirement or community proposal includes conformance and trajectory evidence budget |
| D-07: full broker/runtime/adapter hotspot responsibility decomposition beyond entrypoint and line-count ratchets | component maintainers | Public-release invariants pass or a hotspot blocks correctness or review |
| D-08: health fallback and detail UI enhancements | broker and client maintainers | The core compatibility/health contract is stable |
| D-09: task-list canonicalization, universal session surfaces, and timestamp/runtime semantics, including the OpenCode context-meter, Pi context-stat, and Pi live-output telemetry follow-ups | protocol, adapter, and client maintainers | A verified cross-adapter inconsistency affects a supported claim |
| D-10: quota interruption continuation | broker and client maintainers | Product semantics and adapter support are approved |
| D-11: tray/background desktop operation | client/platform maintainer | A supported platform requires always-on behavior |
| D-12: private hardware/evidence automation, including the deferred real-Pi immediate-typing and OpenCode no-window user-timing trace lanes | release/evidence maintainer | Repeat cost justifies it; it never becomes required public CI |
| D-13: real-session dogfood and rich Session Detail residuals, including final terminal, permission/question, request/transfer, dense desktop, goal-confirmation, and optional composer-prediction UX; the natural-language pending-input promotion decision is taken together with composer prediction | client and product/design maintainers | Before claiming a polished interactive terminal/session experience or when dogfood finds a release blocker |
| D-14: packaged platform evidence for voice, notifications, camera, secure storage, file pickers, WebViews, lifecycle, and background tasks | client/platform maintainer | Before claiming the corresponding capability on a shipped platform |
| D-15: transcript, checkpoint, protocol-journal, migration, crash, and large-session operational evidence | client, broker, and storage maintainers | Before expanding durability claims beyond deterministic bounded tests |
| D-16: transfer completion ambiguity, background uploads, token-at-rest hardening, retention, expiry, orphan cleanup, and quota policy | broker, client, and security maintainers | Before promising automatic restart/background transfer or deletion behavior |
| D-17: paired-peer least privilege, roster/revoke/rotate UI, envelope replay defense, and recovery/migration | protocol and security maintainers | Before expanding peer access or encrypted-session claims |
| D-18: broker host expansion to macOS and native Windows | broker/release maintainer | Packaging, service integration, and clean-host evidence are funded and pass together |
| D-19: Claude answer-only/true-sync expansion | Claude adapter and security maintainers | A packaged, authenticated command boundary and current-runtime trajectory evidence exist |
| D-20: macOS/Windows terminal-presence detection and other adapter-host parity | adapter/platform maintainers | The relevant broker host becomes supported |
| D-21: agent-generated UI beyond display-only artifacts | protocol, client, and security maintainers | A stable structured UI contract and sandboxed interaction authority are approved |
| D-22: production brand masters and platform icon exports | design/client maintainer | Before public marketing or store submission; current scaffold assets remain until reviewed exports replace them |
| D-23: candidate-manifest app UI | release maintainer | Protected prerelease acceptance workflow needs it |
| D-24: published-candidate app-triggered upgrade/unhealthy-rollback evidence | release maintainer | Credential-free hosted topology is available; required before every compiled broker release |
| D-25: usage and quota-limit visibility: a stable Tokdash integration contract with packaged configuration, consent, and durable persistence, plus native agent usage-window display (Claude/Codex five-hour and weekly limits) | broker and client maintainers | Before usage or quota visibility is claimed as a supported capability, or when packaged setup configures Tokdash |
| D-26: native plan-channel adoption beyond the shipped semantic fallback, starting with Codex `plan\|default` collaboration mode and any real Pi plan channel | adapter and protocol maintainers | Current-runtime evidence proves a native plan approve/revise/exit channel for that agent |
| D-27: sealed-client follow-ups: terminal fresh-state parity for swipe and tap, goal/command lookup consolidation, shared route constants, unread-badge helper deduplication, real-broker fork-boundary confirmation, and live roster timing | client maintainers | The owning module is next changed; a correctness or advertised-capability gap escalates into the matching release blocker |
| D-28: multiple concurrent brokers in one client, reframing pairing from a first-run gate into an ongoing broker-add surface: a client served by broker A pairs to broker B and switches between them, with per-broker identity, credential isolation, session-roster attribution, and a defined story for name collisions and offline brokers | client, protocol, and security maintainers | More than one broker must be reachable from a single client, or the pairing surface is redesigned; do not weaken the one-QR-one-device peer model to satisfy it |

## Audited branch and plan dispositions

| Historical slice | Public disposition |
|---|---|
| Design-system and localization experiments | Not imported. The consolidated design system and localization files are canonical; remaining product ideas enter D-13 through a new proposal. |
| Session-workspace routing experiments | Not imported. Current typed routing and workspace behavior are canonical; future changes are D-13 work. |
| Flutter version-file repair | Closed: the consolidated version file is valid and CI pins the same Flutter version explicitly. |
| Personal form-factor captures and historical status branches | Private evidence/history only; no source or captures imported. |

The broker root redirect, remote transcript-export default-deny policy,
multi-machine roster identity, durable transcript/checkpoint foundation,
scheduled-send client adoption, and BPC13 client compatibility/update adoption
are implemented decisions rather than open roadmap items. The retained PoC UI
stays non-production under `apps/poc-ui`. Older phased plans, agent breakdowns,
review sweeps, private implementation logs, and raw roadmap worktrees were not
bulk-imported; their still-open outcomes are mapped in the roadmap source audit.
