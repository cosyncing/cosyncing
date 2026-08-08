import 'dart:js_interop';

import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';

@JS('cosyncingHandoffPrepare')
external set _prepareHook(JSFunction? value);

@JS('cosyncingHandoffCommit')
external set _commitHook(JSFunction? value);

@JS('cosyncingHandoffRelease')
external set _releaseHook(JSFunction? value);

@JS('cosyncingHandoffReadyHint')
external JSFunction? get _readyHint;

/// Connects the handoff participant registry to `web/index.html` (N3b).
///
/// Three hooks, matching the page's two-phase commit:
///
/// * `cosyncingHandoffPrepare()` — would this tab be willing to move?
/// * `cosyncingHandoffCommit()` — freeze and make the final value durable. The
///   freeze happens synchronously inside this call, so nothing the user types
///   after it can be lost between here and the navigation.
/// * `cosyncingHandoffRelease()` — the round was abandoned; unfreeze.
///
/// They exist ONLY while at least one surface owns losable state: the
/// coordinator reads their absence as "nothing to lose here" and moves
/// immediately, which is the correct answer for a page that has not booted or
/// has no editor open.
///
/// In the other direction, the registry calls `cosyncingHandoffReadyHint()`
/// when an editor closes, so a tab that deferred while the user was typing
/// updates as soon as they stop rather than waiting out the retry cadence.
///
/// Nothing here touches worker lifecycle, caches or navigation.
void installWebHandoffBridge() {
  WebHandoffParticipants.readinessHook = () {
    try {
      _readyHint?.callAsFunction();
    } on Object {
      // A hint the page cannot take is not a failure; the retry cadence still
      // covers it.
    }
  };
  WebHandoffParticipants.installHook = (registry) {
    if (registry == null) {
      _prepareHook = null;
      _commitHook = null;
      _releaseHook = null;
      return;
    }
    JSPromise<JSBoolean> prepare() =>
        registry.prepare().then((ready) => ready.toJS).toJS;
    JSPromise<JSBoolean> commit() =>
        registry.commit().then((ready) => ready.toJS).toJS;
    void release() => registry.releaseAll();
    _prepareHook = prepare.toJS;
    _commitHook = commit.toJS;
    _releaseHook = release.toJS;
  };
}
