/// Per-session plumbing for clickable file mentions in a transcript.
///
/// Modelled on the transcript's existing selection scope: an [InheritedWidget]
/// carrying one session's open intent down to every row. Deliberately **not** a
/// library-level global like `transcriptLinkOpener` — the workspace can hold
/// two session pages at once (`workspace/retained_session_pages.dart`), and a
/// global opener would send a tap made in one session's transcript to the other
/// session's Files surface.
library;

import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/file_reference.dart';
import 'package:flutter/widgets.dart';

/// Whether this session's host will answer the read-only workspace file API.
///
/// The broker's `fsTrustGate` treats **every** HTTP/WS client as remote — the
/// decision is `features.httpWorkspaceBrowsing` in the broker configuration
/// (or `COSYNCING_FS_REMOTE_ENABLED` on an unpackaged build), not the caller's
/// address. On a default host the gate is therefore CLOSED for every client,
/// loopback included, and every mention must degrade to plain text.
///
/// This is a property of the session's host connection, so it is probed once
/// per attach and cached — never per link, and never re-probed on scroll.
enum SessionFileLinkGate {
  /// Not probed yet. Mentions stay plain text: a link the client cannot back
  /// is a promise the surface may not be able to keep.
  unknown,

  /// The fs routes answered. Mentions render as links.
  open,

  /// `FS_REMOTE_DISABLED` (HTTP 403) — workspace browsing is off on this host.
  remoteDisabled,

  /// The session has no working directory, so no mention can ever resolve.
  ///
  /// Reached through a 404 on the workspace-root probe: the fs routes
  /// short-circuit `NO_CWD` to 404 before the error mapper, so a root request
  /// that cannot find the root is a missing workspace, not a missing file.
  noWorkspace,

  /// The probe failed for some other reason (network, unclassified broker
  /// error). Honest plain text rather than a link that may 403 or 500.
  unavailable,
}

/// Whether a gate outcome permits rendering a styled, tappable link.
extension SessionFileLinkGateX on SessionFileLinkGate {
  /// True only for [SessionFileLinkGate.open].
  bool get allowsLinks => this == SessionFileLinkGate.open;
}

/// Carries one session's file-link capability and open intent to its rows.
class SessionFileLinkScope extends InheritedWidget {
  /// Creates a scope for one session detail page's transcript subtree.
  const SessionFileLinkScope({
    required this.sessionKey,
    required this.gate,
    required this.onOpen,
    required this.onProbeNeeded,
    required super.child,
    super.key,
  });

  /// The session whose workspace a mention resolves against.
  final SessionDetailKey sessionKey;

  /// Cached outcome of this attach's single gate probe.
  final SessionFileLinkGate gate;

  /// Opens [SessionFileReference] in this session's Files surface.
  final void Function(SessionFileReference reference) onOpen;

  /// Asks for the once-per-attach gate probe, raised the first time a mention
  /// actually needs the answer.
  ///
  /// Deferred rather than eager because a session with no file mention has
  /// nothing to light up, and should not spend a request finding that out. It
  /// costs no visible delay: the probe is a round-trip either way, so mentions
  /// render as plain text for the same first few frames under both timings.
  /// The controller makes it idempotent, so many mentions raise one request.
  final VoidCallback onProbeNeeded;

  /// Whether mentions in this subtree may render as links at all.
  bool get linksEnabled => gate.allowsLinks;

  /// Reads the nearest scope, or null outside a session transcript.
  static SessionFileLinkScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SessionFileLinkScope>();

  /// `==` rather than [identical]: the opener is passed as an instance method
  /// tear-off, which Dart canonicalizes for equality but not for identity, so
  /// an identity test would report a change on every single page build.
  @override
  bool updateShouldNotify(SessionFileLinkScope oldWidget) =>
      oldWidget.gate != gate ||
      oldWidget.sessionKey != sessionKey ||
      oldWidget.onOpen != onOpen ||
      oldWidget.onProbeNeeded != onProbeNeeded;
}
