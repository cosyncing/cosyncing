import 'dart:async';

import 'package:flutter/foundation.dart';

/// One surface that owns local state a web-update handoff could destroy (N3b).
///
/// A participant answers four questions and nothing else:
///
/// * [isBusy] — is the user editing right now? A tab that answers yes defers
///   the handoff silently. Moving a focused composer would take the caret and
///   the in-progress keystrokes away mid-sentence, which is worse than staying
///   on the previous build for another minute.
/// * [flush] — make everything durable, and report whether it actually crossed
///   the repository boundary. A false answer defers the handoff, because the
///   whole point of asking is that nothing unsent is lost when the document is
///   destroyed.
/// * [lock] — SYNCHRONOUSLY stop accepting edits and capture the exact value
///   that [flush] will persist. Returns false to refuse. This is what makes the
///   handoff lossless: several seconds pass between a tab agreeing to move and
///   being told to go, and a value flushed at the start of that window is not
///   the value on screen at the end of it. Nothing may await before the surface
///   stops accepting input, or a keystroke lands in the gap.
/// * [release] — undo [lock]. Called when the round is abandoned, so a tab is
///   never left permanently unable to type because some other tab deferred.
@immutable
final class WebHandoffParticipant {
  /// Creates a participant over its four callbacks.
  const WebHandoffParticipant({
    required this.isBusy,
    required this.flush,
    required this.lock,
    required this.release,
  });

  /// Whether this surface is being actively edited.
  final bool Function() isBusy;

  /// Persists this surface's durable state; false when it did not land.
  final Future<bool> Function() flush;

  /// Synchronously freezes this surface for the commit; false refuses.
  final bool Function() lock;

  /// Synchronously unfreezes this surface after an abandoned commit.
  final void Function() release;
}

/// The set of surfaces that must be safe before this tab may be moved.
///
/// Deliberately a plain registry rather than a provider: the caller is a
/// browser-side coordinator in `web/index.html`, which has no Riverpod
/// container and must get a truthful answer even while the app is rebuilding,
/// disposing, or reconnecting.
///
/// Registration is what installs the browser hooks, and unregistering the last
/// participant removes them again. That is load-bearing: the coordinator treats
/// missing hooks as "this tab owns nothing losable" and moves immediately,
/// which is correct for a page that has not booted or has no editor open — and
/// is only correct because an empty registry cannot be mistaken for a populated
/// one, and because EVERY surface holding unsaved state registers.
final class WebHandoffParticipants {
  WebHandoffParticipants._();

  /// The process-wide registry.
  static final WebHandoffParticipants instance = WebHandoffParticipants._();

  /// Ceiling on concurrently registered surfaces.
  ///
  /// One per open editor; the client mounts a small, bounded number. Refusing
  /// past the ceiling keeps a leaked registration from growing the prepare
  /// fan-out without bound.
  ///
  /// A refused registration is reported as permanently busy rather than
  /// silently ignored: an editor the registry cannot track is exactly an editor
  /// whose contents a handoff would discard.
  static const int maxParticipants = 32;

  /// Longest one participant's flush may take before it is treated as a defer.
  ///
  /// The browser coordinator bounds the whole call as well; this bound exists
  /// so one stuck surface cannot consume the entire budget and make every other
  /// surface look slow.
  static const Duration flushTimeout = Duration(seconds: 2);

  final List<WebHandoffParticipant> _participants = <WebHandoffParticipant>[];
  final List<WebHandoffParticipant> _locked = <WebHandoffParticipant>[];

  /// Set when a registration was refused past [maxParticipants].
  bool _overflowed = false;

  /// Bumped by every [releaseAll].
  ///
  /// A commit is a synchronous freeze followed by a durable write, and the
  /// write is where the time goes. The round can be abandoned during it — a
  /// peer aborts, the coordinator dies, the freeze deadline expires — and the
  /// page unfreezes this tab immediately. Without this counter the flush would
  /// then land, report success, and hand back a tab that believes it is frozen
  /// and safe to move for a round that no longer exists.
  int _releaseGeneration = 0;

  /// The commit-window input lock. True from the synchronous start of
  /// [commit] until [releaseAll] — or until the navigation destroys the
  /// document, whichever comes first.
  ///
  /// Individual participants can only vouch for the state they had when the
  /// commit snapshot was taken. Several seconds pass between this tab
  /// reporting `done` and the coordinator sending `go`, and during that window
  /// a verified-empty field is still an editable field, and a newly opened
  /// editor was never in the snapshot at all. The app shell watches this and
  /// blocks every pointer and keyboard interaction while it is true (see
  /// `WebHandoffFreeze`), so nothing losable can appear after the snapshot.
  ///
  /// Bounded: the page releases or moves this tab within seconds, and its
  /// lock deadline unfreezes unconditionally after that.
  final ValueNotifier<bool> frozen = ValueNotifier<bool>(false);

  /// Installs the browser-side hooks, or removes them. Set by the web bridge.
  static void Function(WebHandoffParticipants? registry)? installHook;

  /// Tells the page this tab may have become movable. Set by the web bridge.
  ///
  /// Without it a tab that deferred while the user was typing would wait out
  /// the retry cadence after they stop, instead of updating as soon as it can.
  static void Function()? readinessHook;

  /// Registered surfaces, for tests and diagnosis.
  @visibleForTesting
  int get participantCount => _participants.length;

  /// Frozen surfaces, for tests and diagnosis.
  @visibleForTesting
  int get lockedCount => _locked.length;

  /// Registers [participant] until the returned callback is invoked.
  VoidCallback register(WebHandoffParticipant participant) {
    if (_participants.length >= maxParticipants) {
      // Untracked editors are the hazard this whole registry exists to remove,
      // so an overflow makes the tab permanently unmovable rather than
      // pretending the surface is not there.
      _overflowed = true;
      return () {};
    }
    _participants.add(participant);
    if (_participants.length == 1) installHook?.call(this);
    var released = false;
    return () {
      if (released) return;
      released = true;
      _participants.remove(participant);
      _locked.remove(participant);
      if (_participants.isEmpty) installHook?.call(null);
      // A closed editor is the most common way a deferred tab becomes movable.
      readinessHook?.call();
    };
  }

  /// Registers a non-durable editor that defers for as long as it is open.
  ///
  /// For deliberately-opened editors whose value lives only in widget state —
  /// the new-session sheet, the schedule sheets. There is nowhere to flush them
  /// to, and returning to the underlying route after a handoff would discard
  /// every field silently, so they hold it off entirely until they close.
  /// Bounded by the coordinator's own retry budget, and closing one signals
  /// readiness immediately through [readinessHook].
  VoidCallback hold() => holdWhile(() => true);

  /// Registers a non-durable editor that defers only while it holds content.
  ///
  /// For fields that live on an ordinary page rather than in an editor the user
  /// opened — the broker token field sits on Settings for as long as Settings
  /// is open, and blocking every update for that would be a bad trade for a
  /// field that is usually empty. An empty field has nothing to lose.
  ///
  /// [hasContent] is re-asked at commit time, so text typed between agreeing to
  /// move and actually moving aborts the round instead of being discarded. That
  /// check alone is not what makes the field safe: it runs once, and the tab
  /// then stays movable for several more seconds. What keeps a keystroke from
  /// landing in an empty-but-verified field during that window is [frozen] —
  /// the commit locks input for the whole tab, not just the surfaces asked.
  VoidCallback holdWhile(bool Function() hasContent) {
    return register(
      WebHandoffParticipant(
        isBusy: hasContent,
        lock: () => !hasContent(),
        flush: () async => true,
        release: () {},
      ),
    );
  }

  /// Runs [body] while a conditional hold is registered for it.
  ///
  /// For editors that have no widget state to hang a registration on — a dialog
  /// opened from a callback with a controller created beside it. The hold is
  /// removed however [body] ends, so a thrown error cannot leave a tab
  /// permanently unmovable.
  Future<T> holdDuring<T>(
    bool Function() hasContent,
    Future<T> Function() body,
  ) async {
    final release = holdWhile(hasContent);
    try {
      return await body();
    } finally {
      release();
    }
  }

  /// Runs [body] while an unconditional hold is registered for it.
  ///
  /// The scoped sibling of [hold], for modal editors opened from a callback.
  /// An open modal defers the handoff until it closes — the documented policy
  /// already accepts that — and unconditionality is what makes it need no
  /// readiness plumbing: the only transition that matters is the dialog
  /// closing, and [register]'s release path announces that by itself.
  Future<T> holdOpen<T>(Future<T> Function() body) =>
      holdDuring(() => true, body);

  /// Announces that this tab's readiness may have changed.
  ///
  /// Called when an editor closes or stops being actively edited. Purely a
  /// hint: the coordinator re-verifies everything before acting on it.
  void notifyReadinessChanged() => readinessHook?.call();

  /// Removes every participant. Test seam only.
  @visibleForTesting
  void reset() {
    final wasEmpty = _participants.isEmpty;
    _participants.clear();
    _locked.clear();
    _overflowed = false;
    _releaseGeneration += 1;
    frozen.value = false;
    if (!wasEmpty) installHook?.call(null);
  }

  /// Whether this tab is willing to be moved (phase one).
  ///
  /// Busy first, and without flushing anything: an actively edited surface is
  /// not going anywhere, so persisting a half-typed value on its way out would
  /// be a write with no reader.
  ///
  /// Every flush then runs, and every result is awaited even after the first
  /// failure. A participant that is asked to flush and then abandoned would
  /// have an in-flight write racing the navigation that is about to destroy
  /// the document.
  Future<bool> prepare() async {
    if (_overflowed) return false;
    final participants = List<WebHandoffParticipant>.of(_participants);
    for (final participant in participants) {
      try {
        if (participant.isBusy()) return false;
      } on Object {
        // A surface that cannot answer is not a surface that may be moved.
        return false;
      }
    }
    return _flushAll(participants);
  }

  /// Freezes this tab and makes its final value durable (phase two).
  ///
  /// The lock runs BEFORE the first `await`, so it completes synchronously
  /// within the caller's own turn of the event loop. That is the whole point:
  /// between phase one and here the user may have kept typing, and only a
  /// synchronous freeze can guarantee that what is flushed below is what is on
  /// screen when the tab leaves.
  ///
  /// A refusal releases whatever was frozen, so a tab is never left unable to
  /// type because a peer aborted the round.
  ///
  /// A [releaseAll] that arrives while the flush is still in flight cancels the
  /// commit outright: it returns false and leaves nothing frozen, because the
  /// only thing worse than deferring an update is a composer that silently
  /// refuses to type for a round nobody is running.
  Future<bool> commit() async {
    if (_overflowed) return false;
    final generation = _releaseGeneration;
    // Before the first await and before any participant is asked: the whole
    // tab stops accepting input, not just the surfaces in the snapshot.
    frozen.value = true;
    final participants = List<WebHandoffParticipant>.of(_participants);
    for (final participant in participants) {
      var locked = false;
      try {
        locked = participant.lock();
      } on Object {
        locked = false;
      }
      if (!locked) {
        releaseAll();
        return false;
      }
      _locked.add(participant);
    }
    final durable = await _flushAll(participants);
    if (_releaseGeneration != generation) {
      // Already unfrozen by whoever abandoned the round; releasing again is a
      // no-op and keeps this path identical to every other refusal.
      releaseAll();
      return false;
    }
    if (!durable) releaseAll();
    return durable;
  }

  /// Unfreezes every frozen surface. Safe to call when nothing is frozen.
  void releaseAll() {
    _releaseGeneration += 1;
    frozen.value = false;
    for (final participant in List<WebHandoffParticipant>.of(_locked)) {
      try {
        participant.release();
      } on Object {
        // Best effort: one surface that cannot unfreeze must not strand the
        // rest, and the document is about to be rebuilt or replaced anyway.
      }
    }
    _locked.clear();
  }

  Future<bool> _flushAll(List<WebHandoffParticipant> participants) async {
    final results = await Future.wait(
      participants.map((participant) async {
        try {
          return await participant.flush().timeout(flushTimeout);
        } on Object {
          return false;
        }
      }),
    );
    return results.every((durable) => durable);
  }
}
