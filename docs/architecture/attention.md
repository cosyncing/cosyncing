# Attention feed architecture

The broker owns notification meaning. It records typed attention events in a
durable feed; clients fetch that feed after authentication and decide how to
present it. A push to a native provider, when configured, carries only an
opaque wake signal and never contains prompts, paths, session text, or
credentials. A Web Push to a browser is end-to-end encrypted to that browser
and carries no more than the notification shows: the event type's title, the
truncated session title, and what a click needs to open it.

## Durable state

- Events use stable deduplication keys, monotonic cursors, revisions, explicit
  active/resolved state, severity, presentation revision, and typed actions.
- The store writes a complete versioned snapshot through staged, synchronized,
  atomic replacement. Corrupt startup state is quarantined and reported through
  broker health instead of being silently discarded.
- Read and dismiss state is scoped by client id. One device cannot acknowledge
  or dismiss another device's view. The first read or dismissal by any client
  stamps the event's `seenAt` and moves it to a new cursor, so every other
  client's next page carries it and can clear its own notification. `seenAt`
  is not a revision: nothing is presented again and an exact-revision
  dismissal still applies. A runtime update's delayed alert or a reopened
  event clears it.
- Served events carry `notificationType` and `collapseKey`, derived from the
  kind and session rather than stored. `contracts/fixtures/attention-notification-types.json`
  holds the cases the broker and the Flutter client both test against.
- Resolved events and delivery records are bounded by explicit retention and
  count limits. Policy changes must preserve deterministic pruning and recovery.
- Broker-health episodes are reconciled from durable observations after restart.
  The store, not process memory, is authoritative. If the attention store itself
  fails, health reporting must not recursively write through it.

## API and client behavior

Authenticated clients page `/api/attention-events` by cursor and post read or
dismiss mutations to the corresponding event routes. The Flutter client commits
feed pages and cursors together, persists local read/dismiss intent before the
network mutation, and retries pending mutations. The durable feed is the only
source of local notifications; live session events never post one.

## Client notifications

Each event kind maps to one user-configurable notification type, in three
families:

| Family | Types | Off by default |
| --- | --- | --- |
| Sessions | permission request, question, turn finished, goal finished, turn failed, scheduled message failed | none |
| Security | security alert, new device paired | none |
| Server | server problem (critical or action-required health only), runtime update, usage running low | runtime update, usage |

Scheduled-send success, informational health, and unknown kinds never become
OS notifications. They stay as inbox rows. The broker no longer raises
sync-degraded: losing a drive or terminal-sync path is shown in the session's
own control state, and rows an older broker left active are resolved on start.

A permission or question event resolves when its resolution frame arrives, when
the session ends, or when the session's own connection drops the request from
its pending list without a frame, which is how an answer typed in the agent's
terminal arrives. Only requests that connection itself surfaced count, and a
connection that sets `pendingListMayOmitOpenRequests` never resolves one this
way. An asynchronous question (`blocking: false`) raises no event. A finished
turn or goal notifies once per occurrence: turns dedupe on the adapter's run
key, and goals on their key plus start time. A run the tool opened itself
(`origin: 'background'`, such as Claude continuing after a background task
reported) never notifies.

Every event alerts once. Nothing is re-alerted on a timer: an unanswered
request stays in the inbox until it is answered, and an unchanged condition
stays listed while it lasts. A runtime update alerts two hours after it is
found, so an update applied meanwhile never notifies, and a broker-health
episode alerts again only when it gets worse. Stages an older broker stored
for its reminders (`15m`, `7h`, `24h`, ...) are still read, so an event
already past its first alert is never presented again after an upgrade.

- On Android each type is a notification channel, grouped by family, and the
  user owns its on/off, sound, and lock-screen behavior in system settings. The
  app reads the channel state and links to it. Elsewhere the app's per-type
  switches are authoritative.
- A notification shows the event type as its title. Its body is the truncated
  session title (or, for non-session events, the broker's event title). The
  "event type only" option per type leaves the body empty.
- Notifications collapse into slots: one per pending request, one per session
  for turn outcomes, and one per other event. A newer outcome replaces the
  session's older one.
- Opening a session, or tapping its notification, marks its finished and failed
  turns read and clears them. A pending request only loses its OS notification;
  its inbox row stays until the request is answered. A request answered
  anywhere, including in the agent's terminal, clears its notification when the
  feed page that resolves it lands. Clearing a row never removes a slot that a
  newer, unhandled event has taken.
- Reading or dismissing an event on one device clears its notification on the
  others when their next feed page carries its `seenAt`, and an event seen
  elsewhere before a device got to it is never shown there. Requests are the
  exception: they clear when answered. Each device keeps its own inbox read
  state.
- With a broker that serves `notificationType` and `collapseKey`, the client
  presents by those, and a type it does not know is never shown. With an older
  broker it maps the kind itself, the same way.
- The master switch starts unset. A first-run card offers it once a Server is
  paired, and turning it on asks for OS permission in the same tap. Settings
  shows the permission state, explains a refused or insecure-context browser,
  offers a test notification, and reports the last delivery outcome (shown,
  blocked, unavailable, or failed). A failed presentation is retried a bounded
  number of times.
- An app window counts as in the foreground only while it has focus. A
  visible window without focus, or a hidden one, gets OS notifications
  instead of in-app banners. A browser tab reads this from the document
  itself, because Flutter's web engine reports every new tab as focused.
- On macOS and Windows, closing the window keeps the app, and so its feed
  workers, running (Dock on macOS, notification area on Windows) unless the
  user turns that off. The native host quits on close until the app tells it
  otherwise, and a notification tap reopens a closed window. On Windows one
  client runs per executable: a second start shows the first.
- On Android, an opt-in foreground service keeps the process running while
  notifications are on, so the feed workers keep polling after the user leaves
  the app or swipes it away. The Flutter engine outlives the activity while the
  service runs, and a later activity attaches to it instead of starting a
  second app. The service is not sticky: if Android kills the process, it stays
  stopped until the app is opened again.
- A request the OS refused while notification permission was not granted is
  presented once permission is granted, if it is still open. Finished turns
  are not replayed.
- Unpackaged Windows toasts carry a fixed group, so a read or answered toast
  can be removed from Action Center, and clicking a toast after the app quit
  starts it on that event.
- In a browser, notifications are shown through the app's own service worker
  (`sw.js`). A click focuses an app window under the app's mount and hands it
  the payload, or opens the app with the payload in `?attention=` when none is
  open. Several tabs of one browser coordinate through Web Locks: one tab
  presents an event, and a tab in the background leaves it to a focused tab,
  which shows it in-app.
- With every tab closed, a browser is notified by Web Push from the Server
  that serves the web app. While notifications are on and allowed, the app
  subscribes its service worker with the broker's VAPID key
  (`GET /api/push/web-push-key`) and registers the subscription as platform
  `webpush`, with the enabled types, their titles in the app's language, each
  type's "event type only" and sound choices, and a context naming the broker
  profile. It registers again when any of those change and withdraws when
  notifications go off. The subscription must be an `https:` endpoint on a
  known push service (Google, Mozilla, Apple, Microsoft) or on a host listed
  in `COSYNCING_WEB_PUSH_EXTRA_HOSTS` (exact hosts or `*.suffix`, comma
  separated). The broker keeps its VAPID key owner-only in its state
  directory, created on first use. It sends each delivery itself, RFC 8291
  encrypted under RFC 8292 VAPID, and skips a type the registration does not
  present, an event this device already read or dismissed, a delayed alert
  of an event another device has seen, and any alert raised before the
  browser registered, which its open app already lists. A refusal
  from the push service is logged with the service's own reason, never the
  endpoint's path. `sw.js` shows a push under the same tag as
  the app's own notification of that slot, and both record the alert they
  raise, so one event notifies once: the alert already on screen is replaced
  without a second sound. Only Chromium lets a site with a visible tab skip a
  push, so only there does a focused app window leave it to the page. A browser
  holds one subscription per app, so other paired Servers notify only while a
  tab is open.

Native remote wake is deployment-dependent. The default build provides no
production APNs or FCM provider and must not advertise terminated-app wake on
those platforms. If a provider is
later enabled, registration, rotation, revocation, consent, and end-to-end
opaque-payload evidence are required before the capability is claimed.

## Verification

The deterministic broker suites cover persistence, deduplication, per-client
state, corruption recovery, pruning, once-only delivery, health episodes, API
authentication, and route registration. Client suites cover durable paging,
mutation retry, source exclusivity, notification policy, inbox actions, and
opaque-wake catch-up. The web worker's click routing and push handling, the
browser backend, lifecycle, and tab coordination run in their own suites; Web
Push encryption is checked against the RFC 8291 test vector. Packaged
platform notification behavior remains an explicit roadmap evidence gate.
