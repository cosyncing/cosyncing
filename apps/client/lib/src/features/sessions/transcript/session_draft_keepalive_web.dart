import 'dart:js_interop';

import 'package:cosyncing_client/src/features/sessions/transcript/session_draft_keepalive_store.dart';
import 'package:web/web.dart' as web;

/// `sessionStorage`, not `localStorage` (DR1b).
///
/// Both are synchronous, but their scope is what decides correctness here.
/// `sessionStorage` belongs to ONE tab and survives that tab's reloads —
/// including a cache-bypassing hard refresh — and the same-tab
/// `location.replace` legs of the N3b update handoff. `localStorage` is shared
/// by every tab of the origin, so two tabs editing the same session would
/// overwrite each other's keepalive records, and a tab starting up could adopt
/// (and delete) records another tab is still actively writing. Per-tab scope
/// makes multi-tab isolation structural instead of a race to reason about.
SessionDraftKeepaliveStore openSessionDraftKeepaliveStore() {
  try {
    return _SessionStorageKeepaliveStore(web.window.sessionStorage);
  } on Object {
    // Storage disabled by policy or a partitioned context that refuses it. The
    // Drift row remains the durable copy; nothing else changes.
    return MemorySessionDraftKeepaliveStore();
  }
}

/// Retries refused writes at the last moments the document is guaranteed.
///
/// Every edit already writes synchronously, so this only ever re-attempts a
/// write the backing refused (quota) — it is a second chance, not the barrier.
void installSessionDraftKeepaliveTerminalHook(void Function() retry) {
  void safeRetry() {
    try {
      retry();
    } on Object {
      // A terminal retry that cannot run must not throw inside a browser
      // teardown callback.
    }
  }

  try {
    final listener = ((web.Event _) => safeRetry()).toJS;
    web.window.addEventListener('pagehide', listener);
    web.window.addEventListener('freeze', listener);
    web.document.addEventListener(
      'visibilitychange',
      ((web.Event _) {
        if (web.document.visibilityState == 'hidden') safeRetry();
      }).toJS,
    );
  } on Object {
    // No listeners is survivable; the per-edit write is the barrier.
  }
}

final class _SessionStorageKeepaliveStore
    implements SessionDraftKeepaliveStore {
  _SessionStorageKeepaliveStore(this._storage);

  final web.Storage _storage;

  @override
  Map<String, String> readAll() {
    final entries = <String, String>{};
    for (var index = 0; index < _storage.length; index++) {
      final key = _storage.key(index);
      if (key == null) continue;
      final value = _storage.getItem(key);
      if (value != null) entries[key] = value;
    }
    return entries;
  }

  @override
  String? read(String key) => _storage.getItem(key);

  @override
  void write(String key, String value) => _storage.setItem(key, value);

  @override
  void remove(String key) => _storage.removeItem(key);
}
