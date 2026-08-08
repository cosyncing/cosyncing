# Store listing copy

Submission-ready listing text for Google Play, the Apple App Store, and the Microsoft Store.

- [`listing-en.md`](listing-en.md) — English.
- [`listing-zh-CN.md`](listing-zh-CN.md) — Simplified Chinese.

The two files are **separate editable layers**, not a translation pair (doc 14, acceptance
checklist). They carry the same claims and the same structure; the Chinese is written in Chinese
rather than transliterated from the English, and matches the register already used in
`apps/client/lib/l10n/app_zh.arb` — `Broker` stays Latin, agents are 智能体, sessions are 会话.

## Rules these files follow

- The tagline system is locked (doc 19): hero `Code anywhere. Sync everywhere.` /
  `代码随处。同步无界。`, support `Your agents keep working. You keep moving.` /
  `智能体照常运转，你持续前行。`, and the merged one-liner for short descriptions.
- The wordmark stays Latin `cosyncing` in every locale.
- Only shipped functionality is claimed. In particular, notifications are described as arriving
  while the app is running: the default build has no push provider, so terminated-app remote wake
  must not be advertised (`docs/architecture/attention.md`).
- Per-agent differences follow the generated matrix in `docs/protocol/adapter-support.md`. Do not
  restate a capability here that the matrix marks partial without the qualifier.
- Platform claims separate the **client** (Android, iOS/iPadOS, macOS, Windows, Linux, browser)
  from the **broker**, which supports Linux and Apple Silicon macOS hosts. Windows and Intel Mac
  broker hosts are not supported.

## Screenshots

The campaign is generated, never hand-made, and never committed:

```bash
bash scripts/dev/run-store-capture.sh
```

That seeds a self-contained fictitious world under a unique throwaway root, serves the real client
from a broker that can see only that world, proves it, captures the app in each listing locale,
composes the store frames, and publishes the result transactionally — the accepted campaign is kept
until the replacement is in place, and restored if anything fails. It needs no privileged directory
and no pre-existing state. Output lands in `output/brand/store/`:

| Path | What it is |
|---|---|
| `raw/<locale>/` | Unaltered captures of the real app — the locked inputs |
| `final/<locale>/` | The submission set: upload this folder |

Apple and Google frames are the capture placed unchanged inside the approved background with the
doc 14 campaign headline; the composer re-reads each finished frame and fails if a single product
pixel moved. Microsoft and PWA frames carry no headline or logo at all, because Microsoft asks for
none. Both locales show the app in that locale, not one build with captions pasted over it.

### The approval frame

Doc 14's third beat wants a session detail with a *permission request*, and that is the one frame
that cannot be assembled out of transcript. A permission request is not transcript data: the agent
raises it mid-turn on its control channel and blocks until the answer comes back. A request found
in a transcript is over, and one replayed to an observing client renders read-only, under the
honest notice that it must be answered where the agent is running — which is the wrong screenshot
for a headline that says "approve".

So the capture takes the session over from the app, sends one prompt, and photographs the request
that comes back while it is still pending, with Reject and Allow live. Everything that turns it
into that card is shipped code: the fixture's stand-in `claude` (`COSYNCING_CLAUDE_BIN`, the
adapter's own documented launch-binary override) speaks the same stream-json a real
`claude --resume` speaks, and the adapter, broker, and client are the real ones. It contacts no
model, writes no transcript, and never answers its own request.

Making that frame honest also changed one line of the client, which is not a screenshot detail and
should not be read as one. The permission renderer passed its read-only hint unconditionally, and
that hint renders as "… (read-only)" — so an answerable request announced itself read-only directly
above its own working Reject and Allow buttons. It is now conditional on the request actually being
read-only (`message_family_renderers.dart`), with a regression test either way in
`test/src/features/sessions/renderers/message_renderer_registry_test.dart`. Read-only requests are
unchanged. The identical defect on the *question* renderer is deliberately left alone and queued: no
frame shows a question card, and fixing it here would be a second product change smuggled in behind
a screenshot.

The frames are also *framed*. A Session Detail frame is scrolled to the end of its session, so the
top edge lands wherever the transcript's own height puts it — and each surface has its own width,
wrapping and viewport, so the same conversation opens cleanly on one and halfway through a line on
the next. No wording fixes all of them at once: a change that clears one surface moves another. So
the capture finds the clip by looking (ink is never painted above it), and scrolls a few pixels
until the frame opens on clear space (`frameTranscriptTop`). It frames the shot; it does not change
what the shot is of, the movement is single-digit pixels, and the frame still has to pass its
witness check afterwards. Whether the line it opens on is a whole *sentence* is the fixture's job,
which is why the messages near the top of that session are written as short standalone paragraphs.

Three consequences worth knowing. The fixture broker carries a credential like a real one, and the
capture enters it through the app's own "Connect this device" gate — the broker refuses a Drive
attach to a client that cannot prove a credential, so on a token-less broker the app could only
ever observe. The detail frames are captured last, after every other frame, because the turn leaves
the session driven. And the turn is started in a warm-up page that is never photographed, so every
frame that is photographed joins the request rather than raising it — which is how a reader meets
one, and what keeps the four frames identical.

## Length budgets

Character counts are noted next to each field. They were checked against the limits each console
enforces at submission time — Play short description 80, Play full description 4,000, Apple
subtitle 30, Apple promotional text 170, Apple description 4,000, Microsoft short description 500.
Re-check them in the console before submitting: the limits are the store's, not ours, and CJK
fields are counted per character.
