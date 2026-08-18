# Client UI architecture

The Flutter client renders typed broker state and dispatches user intents. It
does not parse raw REST or WebSocket payloads and does not branch on agent or
tool names. Wire types belong in `packages/dart/broker_contract`; transport and
reconnection belong in `packages/dart/broker_client`; feature controllers own
lifecycle and persistence; screens render state.

## Adaptive shell

The same route model serves phone, tablet, desktop, and web layouts. Compact
surfaces use one active session; wider surfaces may keep a list and multiple
session tabs visible. Layout depends on window size and platform capability,
not hard-coded device names.

## Session detail

Session Detail composes transcript, actions, connection state, artifacts,
files, terminal, and transfer surfaces from typed session state. Compatibility
may make a session read-only. In that state, Observe remains available while
mutating controls stay disabled with an explanation.

## Transcript rendering

Markdown is rendered by an in-repo parser rather than a package, so the subset
and its escaping rules stay reviewable alongside the renderers that depend on
them. Two rules exist because breaking them corrupts ordinary prose:

Backslash handling follows CommonMark — only ASCII punctuation is escapable, and
a backslash before anything else is a literal character. Consuming it
unconditionally turns `C:\Data\config` into `C:Dataconfig` and `\d+` into `d+`.
Text the parser does not recognize must survive byte for byte. Inline scanning is
also length-bounded, because unbounded rescans of pathological input are
quadratic.

Tappable links are an **allowlist of `http` and `https`**, not a blocklist of
unwanted schemes. `file:`, `mailto:`, absolute and relative device paths, and
every scheme nobody has thought of yet stay plain text by default. A blocklist
here fails open, and the thing it would fail open into is opening arbitrary
model-authored paths on the user's machine.

Local file references are therefore deliberately inert for now. Making them
useful is what [open workspace file references](../project/roadmap.md) exists to
do properly — resolved against the broker-owned workspace through its jailed
read-only file API, with traversal and symlink escape rejected there rather than
re-litigated in the client. That work likewise rejects host-local `file:` URLs.
Until it lands, such references stay selectable, copyable text.

## Session telemetry

Token counts and context-usage metadata stream once per turn but are only ever
read as a current value. They coalesce into a latest-value projection and never
render as transcript rows — one row per turn buries the conversation under
telemetry. The retained PoC statusline established the same rule.

Percent semantics are a trap worth stating explicitly, because getting them
wrong once inflated readings by 100x. A reported `percent` may arrive as a 0-1
fraction or a 0-100 value, so it needs a heuristic. A `ratio` is always 0-1. A
percentage computed from used and max is *already* a percentage. Applying the
fraction heuristic to either of the latter two double-counts.

## Workspace layout

The roster/detail split is user-draggable, persisted, clamped to a sane range,
and snap-collapses below a threshold rather than degrading into an unusable
sliver. It defaults to collapsed.

A collapsed roster keeps a narrow icon rail. This is not decoration: the bottom
navigation is Compact-only, so at wider widths the roster header is the sole
route to the Notifications and Settings destinations. Collapsing it without a
rail creates a navigation dead end that no test covering either destination
would catch, because both remain reachable by direct route.

## View scale

On web, Ctrl +/- and Ctrl+wheel must behave as browser-native zoom. Flutter
otherwise consumes the wheel event and the page never zooms, which reads as a
broken control rather than a deliberate one; a capture-phase listener in the web
entry point yields those events back to the browser. Iconography scales with the
application's UI scale — icons that stay fixed while text grows dominate the
layout at large scales and waste the space the scale control was used to reclaim.

## Routing

Route construction is centralized and treats tool and session identifiers as
opaque path segments. Every segment is encoded through URI construction before
it enters `go_router`; callers must not concatenate ids into route strings.
Deep links and programmatic navigation use the same helper so `/`, `#`, `?`,
`%`, spaces, and non-ASCII identifiers cannot change route structure.

## Broker connection gate

A broker may require a credential. The client classifies the active broker as
connected, unreachable, or unauthorized. These three stay distinct because each
needs different handling: conflating an unreachable broker with a rejected
credential teaches users to re-enter a secret that was never the problem.

Classification comes from an authenticated probe. `/api/health` is served
without authentication and therefore cannot observe a rejection, so the gate
probes `/api/broker/health`, which sits in the broker's default-deny set. Only
an HTTP 401 means unauthorized; any other failure, including a refused
connection carrying no status code, is unreachable. An absent credential is not
itself a failure, because a broker with no token configured answers
authenticated routes anonymously and is correctly reported as connected.

An unauthorized result blocks the application. The barrier is installed in the
router builder so it covers every route without the router knowing about it,
and it names whether no credential is stored or a stored one was refused.
Unresolved probes and unreachable brokers deliberately fall through instead of
blocking: blocking on an unresolved probe would flash a barrier over every cold
start, and blocking on transport failure would let one dropped connection
replace the whole interface.

Pairing is the preferred recovery, because a paired peer credential is
per-device and individually revocable while the shared broker token is a
master secret that can only be rotated. Raw-token entry remains available as
a bootstrap path. Credential fields are wrapped in an autofill group so a
password manager can offer to store the secret; support for this on Flutter
web is partial and unverified, and it is not the primary path. Settings offers
an explicit sign-out that clears stored credentials. Retention is otherwise
indefinite and deliberate — credentials survive restarts until the user clears
them or the broker revokes them.

## Design system

Feature code uses semantic tokens from `apps/client/lib/src/design` and shared components.
Theme modules are reviewed public source. Platform adapters stay outside the
design layer.

## Interaction rules

- Use capabilities and typed message families to choose controls and renderers.
- Keep permission, question, stop, retry, upload, and artifact actions in the
  controller layer.
- Preserve keyboard, pointer, touch, and screen-reader operation.
- Store credentials only through platform secure storage.
- Keep generated previews, traces, screenshots, and build output untracked.

Changes to wire behavior must follow [contract synchronization](../protocol/contract-sync.md).
Adapter support claims and evidence live in the [adapter support matrix](../protocol/adapter-support.md).
