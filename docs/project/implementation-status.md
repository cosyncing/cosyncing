# Implementation status

Last updated: 2026-07-20.

The curated monorepo import, fresh Git lineage, root-relative tool repairs,
same-checkout contract exporter, BPC13 client handoff and per-profile identity
persistence, public-tree policy, dual private/public workflow profiles,
package boundaries, release-notice generation, and open-source documentation
are implemented in the private consolidation tree. The source repositories
remain unchanged.

The complete Flutter application now lives in `apps/client`, including its
platform runners, tests, integration drivers, web sources, and developer Dart
tools. The retained broker PoC UI lives in `apps/poc-ui`. Root Bun commands,
support scripts, CI working directories, contract tests, boundary checks,
workspace locks, public-content manifests, and contributor docs were migrated
to those paths and revalidated. Stale root Flutter caches and the empty
`tools/` directory were removed locally.

The roadmap was re-baselined on 2026-07-19. Clickable jailed-workspace file
references in the Flutter client (R-01) and Kimi Code adapter support (R-02)
are the first selected post-consolidation product wave. A separate source audit
maps still-open predecessor client, broker, layered-roadmap, backlog, and code
TODO outcomes into the living roadmap; it does not re-open completed milestones.

A post-migration reference audit on 2026-07-19 removed every dangling
predecessor-document and archived-tree pointer from the public working tree.
Attention, client routing, Claude control, and managed-runtime decisions now
resolve to public documentation. The public-tree gate checks those reference
families even inside exact-hash content exceptions. The three foundational
TypeScript packages also have independent package configuration files. Whether
to accept or rebuild the unpublished early lineage containing benign path-only
references remains an explicit pre-visibility owner decision.

The TypeScript `core` package is replaced by `protocol` and `adapter-api`; the
ambiguous `wire` package is now `transport-wire`. Broker and adapter entrypoints
are thin, while full responsibility decomposition remains roadmap item D-07.
Session Detail uses a controller facade plus typed coordinators and
panel parts, renderer families are separated, and the two monolithic behavior
tests are split below the 1,500-line ceiling. CI enforces the dependency graph
and named ratchets.

The first Session Detail and sessions-list UI wave is implemented. Project
groups collapse and expand, the command picker moved from an always-visible
card into a modal sheet opened from the composer bar, and the expand-all and
report-view toggles became compact icon buttons in that bar. Chat content is
full bleed with an explicit scrollbar at the window edge and keeps its
sixteen-pixel gutter below the readable-width constraint, dead space under the
composer is trimmed, and token-count and status events render as caption lines
instead of cards. The per-message read-aloud button is replaced by a
context-menu entry while live playback and error controls stay inline. Four
earlier follow-ups landed with it: the fresh-terminal indicator clears on tab
swipe as well as tap, goal-command lookup is consolidated, route paths are
shared constants, and the navigation badge label is deduplicated.

Two further UI waves followed, driven by readability and vertical density. Token
and context telemetry left the transcript for a coalesced latest-value
statusline, which also fixed tool cards splitting in two: pairing matched only
adjacent frames, and the most common interleaved frame was the token line, so
cards are now paired by tool call id. Transcript envelopes stopped leaking
their own scaffolding fields beneath the text they described, by rendering an
allowlist instead of every remaining field. Text selection works across a
message again — a nested selectable widget had been creating its own island
inside the surrounding selection area. Markdown gained tables and links, the
composer was rebuilt for density, and the model button now derives a short human
name rather than printing a raw model id. Browser-native zoom works through both
Ctrl +/- and Ctrl+wheel. The sessions roster sits in a draggable, persisted
split that defaults to collapsed and keeps an icon rail when collapsed. The
slash-command palette accepts free-text arguments and opens on `/`. Creating a
session now shows progress instead of appearing to hang. Settings and the
telemetry panel were localized.

A code review of that work found three defects that passing tests had not:
context percentages inflated a hundredfold by rescaling values that were already
percentages, backslashes dropped before non-punctuation so ordinary prose and
Windows-looking paths were corrupted, and unbounded quadratic rescans in inline
markdown parsing. All three are fixed and covered.

Session run state no longer goes stale. The broker broadcasts the existing
session frame when `accumulateLive` observes a status transition, guarded by a
before-and-after comparison so streamed tokens do not become control frames.
The client roster polls on a lifecycle-gated fifteen-second timer that stops
while the tab is hidden and refetches immediately on resume, which keeps
browser timer throttling out of the path the user sees. The detail controller
folds status messages into session info under a narrowed rule: a running status
promotes to working, and an idle status only demotes a session that is
currently working, so a needs-input session is never cleared by inference.

Both clients handle a token-gated broker. The Flutter client classifies the
active broker as connected, unreachable, or unauthorized through an
authenticated probe against `/api/broker/health`; the unauthenticated
`/api/health` route cannot observe a rejection and is deliberately not used for
this. An unauthorized result blocks the application from the router builder
until a credential is accepted and names whether none is stored or a stored one
was refused, while an unreachable broker never requests credentials and never
blocks. Pairing is the preferred recovery because peer credentials are
per-device and revocable, with raw-token entry retained as a bootstrap path.
Settings gained an explicit sign-out that clears stored credentials through the
credential store; credential retention is otherwise unchanged and remains
indefinite by design. The retained PoC UI gained an equivalent unlock form that
validates a token against the broker before persisting it. Multiple concurrent
brokers in one client is recorded as roadmap item D-28.

The `pair` command offers to pair another device after each accepted device,
creating a fresh offer per device because one QR pairs exactly one peer. The
prompt is terminal-only: JSON output stays single-shot and machine-parseable,
and non-interactive callers keep their previous behavior and exit contract.

The client web build now sets `--base-href /cosy/`. Without it the bundle
declared a root base, every asset request resolved outside the mount and
returned 404, and the served application delivered its shell but never painted.
A source-run broker can also serve the PoC shell from disk behind
`COSYNCING_POC_DEV`, so PoC edits appear on the next browser refresh instead of
requiring a restart; packaged builds refuse this and serve their own
hash-verified assets.

Local verified gates include TypeScript typecheck, boundary ratchets, contract
drift and conformance, capability and support-matrix checks, BPC13 (26/26),
broker release assembly (19/19), BPC11 release evidence (19/19), compiled
empty-directory package checks (37/37), and the public-tree/workflow audits.
Flutter app analysis and 1,570 tests pass, with 3 explicitly skipped tests, last
verified at commit `298e527`. One boundary ratchet fails there and is known:
`session_detail_controller.dart` exceeds its 900-line ceiling, which predates
the UI waves rather than being introduced by them.
Reusable package analysis and visible tests pass independently: broker contract
231, broker client 164, Flutter adapter 44, and crypto 7. The deterministic broker
aggregate passes 16/16. The web release build passes with upstream
`flutter_tts` Wasm dry-run warnings only.

This workstation cannot authoritatively run Linux desktop (missing
WebKitGTK/libsoup development packages), Android
(no SDK), macOS/iOS, or Windows builds. Those remain GitHub-hosted activation
checks. Repository rulesets and environments likewise require repository
administration context.

The private GitHub repository currently activates the same coverage on generic
self-hosted platform labels. The exact GitHub-hosted workflows are stored in a
non-executable backup and can be restored with
`scripts/ci/restore-github-hosted-workflows.sh`. The workflow and public-tree
audits enforce the tracked mode and reject a public profile that still selects
self-hosted runners.

Visibility has not changed. The independent review's code and documentation
findings are remediated. On 2026-07-19 the owner moved the real
published-candidate app-triggered upgrade/rollback exercise from migration
Phase 11 to the mandatory Phase 12 pre-release gate. Compiled broker
distribution remains separately blocked pending the Bun LGPL
relinking/object-material decision. Commit-exact acceptance, final
history/secret scans, GitHub settings, hosted platform runs, a real fork PR,
and both release gates must pass before their corresponding publication or
release action is approved.
