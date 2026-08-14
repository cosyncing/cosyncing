import 'dart:convert';

import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_draft_keepalive_native.dart'
    if (dart.library.js_interop) 'package:cosyncing_client/src/features/sessions/transcript/session_draft_keepalive_web.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_draft_keepalive_store.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_draft_store.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Namespace and format version of one keepalive entry.
const String sessionDraftKeepalivePrefix = 'cosyncing.draft.keepalive.1|';

/// Keepalive entries retained at once.
///
/// One per session being edited in this tab. A user working through more than
/// a handful at a time still has the durable Drift row behind every one of
/// them; the bound only limits what the synchronous backing holds.
const int maxSessionDraftKeepaliveRecords = 8;

/// One composer value written synchronously, before it is durable (DR1b).
@immutable
final class SessionDraftKeepaliveRecord {
  /// Creates a keepalive record.
  const SessionDraftKeepaliveRecord({
    required this.brokerProfileId,
    required this.sessionKey,
    required this.text,
    required this.recordedAtMs,
    this.baseMutationVersion,
  });

  /// Broker scope key (`RosterSource.storageKey`) this value belongs to.
  final String brokerProfileId;

  /// Tool/session identity within [brokerProfileId].
  final SessionDetailKey sessionKey;

  /// The exact composer value, never a prefix of it.
  final String text;

  /// Local write time. Used ONLY to order eviction inside one tab — never to
  /// order drafts against another device, which stays on broker revisions.
  final int recordedAtMs;

  /// Mutation version of the durable row this value was composed on top of,
  /// or null when the composer had no row at all.
  ///
  /// This is the record's lineage, and it is what makes adoption safe across
  /// tabs. A record lives in ONE tab's `sessionStorage`, but the row it
  /// describes is shared: another tab can advance that row while this tab is
  /// gone, and "the record is newer" — true within a tab — becomes false. The
  /// version says exactly which row the composer was editing, so adoption can
  /// tell "nobody touched it since" from "somebody did".
  final int? baseMutationVersion;
}

/// Synchronous write-ahead record for composer text (DR1b).
///
/// DR1 makes an edit durable through a 300 ms debounce into Drift. That is a
/// barrier the browser can outrun: a hard refresh destroys the document with
/// no promise that `pagehide`, the Flutter lifecycle callback, or `dispose()`
/// runs, and the final route-disposal write is fire-and-forget anyway. This
/// closes the window from the other side. Every composer mutation writes the
/// live value into synchronous storage **inside the keystroke's own turn of
/// the event loop**, so there is no interval in which the value exists only in
/// widget memory. Destroying a document happens between tasks; the write
/// already returned inside the task before it.
///
/// It is deliberately not a second persistence stack. A record is a recovery
/// copy with a lifetime of at most one debounce: the Drift row remains
/// authoritative, `discardDurable` drops the record the moment that row holds
/// the same text, and whatever a previous document left behind is adopted INTO
/// the Drift row on the next start, by [DriftSessionDraftRepository], and then
/// removed.
///
/// A record never carries an empty value. Clearing the composer removes the
/// entry instead of storing '', so the mechanism can only ever restore text —
/// no failure mode of it can erase a draft.
final class SessionDraftKeepalive {
  /// Creates a keepalive over one [SessionDraftKeepaliveStore].
  ///
  /// The inherited snapshot is taken here, once. That single read is what
  /// separates "written by a previous document" from "written by this one":
  /// anything recorded afterwards belongs to the live composer and must never
  /// be adopted back over it, and the snapshot cannot be clobbered by a user
  /// who starts typing before the first session hydrates.
  SessionDraftKeepalive(
    this._store, {
    bool installTerminalHook = true,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now {
    _inherited.addAll(_readInherited());
    if (installTerminalHook) {
      installSessionDraftKeepaliveTerminalHook(retryRefusedWrites);
    }
  }

  final SessionDraftKeepaliveStore _store;
  final DateTime Function() _clock;
  final Map<String, SessionDraftKeepaliveRecord> _inherited = {};
  final Map<String, String> _refused = {};

  /// Write time of every record believed to be in the backing.
  ///
  /// The backing is tab-scoped, so this document is its only writer and the
  /// index cannot go stale under it. Eviction reads THIS rather than the
  /// backing: the alternative is enumerating and decoding up to eight records
  /// — each of them up to a quarter of a megabyte — on every keystroke.
  final Map<String, int> _placedAt = {};

  /// Records a previous document left behind and this one has not adopted yet.
  List<SessionDraftKeepaliveRecord> get inherited =>
      List<SessionDraftKeepaliveRecord>.unmodifiable(_inherited.values);

  /// Writes this store refused (quota) and has not since placed.
  int get refusedWriteCount => _refused.length;

  /// The unadopted record for one exact profile-scoped session, if any.
  SessionDraftKeepaliveRecord? inheritedFor({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) => _inherited[_keyFor(brokerProfileId, sessionKey)];

  /// Makes one composer value recoverable, synchronously.
  ///
  /// Total by construction: a keepalive failure must never break typing, so
  /// every fault is contained and the debounce remains the fallback.
  void record({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
    required String text,
    int? baseMutationVersion,
  }) {
    try {
      final key = _keyFor(brokerProfileId, sessionKey);
      if (text.isEmpty) {
        // An emptied composer has nothing to recover, and storing '' would
        // give this mechanism a way to erase a draft it never wrote.
        _remove(key);
        return;
      }
      if (text.length > maxLocalDraftTextChars) {
        // The durable row refuses this length too, and a stored prefix would
        // present a malformed prompt as the draft. The previous record stays
        // as the last recoverable value, exactly like the previous row does.
        return;
      }
      final recordedAtMs = _clock().millisecondsSinceEpoch;
      _place(
        key,
        jsonEncode({
          'p': brokerProfileId,
          't': sessionKey.tool,
          's': sessionKey.sessionId,
          'x': text,
          'a': recordedAtMs,
          if (baseMutationVersion != null) 'v': baseMutationVersion,
        }),
        recordedAtMs,
      );
    } on Object {
      // Contained: the composer keeps typing, the debounce keeps persisting.
    }
  }

  /// Drops the record for one session once [text] is durable elsewhere.
  ///
  /// Conditional on the value: a record holding something newer than what was
  /// just written is exactly the case this whole mechanism exists for.
  void discardDurable({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
    required String text,
  }) {
    final key = _keyFor(brokerProfileId, sessionKey);
    final pending = _inherited[key];
    if (pending != null && pending.text == text) _inherited.remove(key);
    _discardStoredIfTextIs(key, text);
  }

  /// Carries a surviving record's lineage across THIS tab's own save.
  ///
  /// A keystroke recorded while a save was in flight names the pre-save row as
  /// its base. That base advanced by this tab's own linear history — the same
  /// composer, the same session — so the record is still "typed on top of the
  /// current row" and must say so, or the next start reads it against the
  /// advanced row and manufactures a cross-tab conflict out of one tab's own
  /// typing. Only lineage moves; the text is untouched. Off the keystroke
  /// path: this runs once per landed save, not per edit.
  /// [fromNoRow] says the save was the row's INSERT, which is the one case
  /// where a null-base record is this tab's own lineage rather than a foreign
  /// one: before an insert there was no row, so "typed over nothing" and
  /// "inserted over nothing" describe the same starting point. It is threaded
  /// from the true insert site rather than inferred from version numbers,
  /// because the UPDATE path can also carry version 0 (a row migrated from
  /// before versioning existed) — and a null-base record was NOT typed over
  /// that row, so its conflict is correct.
  void rebaseDurable({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
    required int? fromVersion,
    required int toVersion,
    bool fromNoRow = false,
  }) {
    if (fromVersion == null || fromVersion == toVersion) return;
    final key = _keyFor(brokerProfileId, sessionKey);
    bool matches(int? base) =>
        base == fromVersion || (fromNoRow && base == null);
    final pending = _inherited[key];
    if (pending != null && matches(pending.baseMutationVersion)) {
      _inherited[key] = SessionDraftKeepaliveRecord(
        brokerProfileId: pending.brokerProfileId,
        sessionKey: pending.sessionKey,
        text: pending.text,
        recordedAtMs: pending.recordedAtMs,
        baseMutationVersion: toVersion,
      );
    }
    try {
      final stored = _decode(key, _store.read(key));
      if (stored == null || !matches(stored.baseMutationVersion)) return;
      _place(
        key,
        jsonEncode({
          'p': stored.brokerProfileId,
          't': stored.sessionKey.tool,
          's': stored.sessionKey.sessionId,
          'x': stored.text,
          'a': stored.recordedAtMs,
          'v': toVersion,
        }),
        stored.recordedAtMs,
      );
    } on Object {
      // Best effort: a record that keeps its old base costs a conflict
      // surface on the next start, never lost text.
    }
  }

  /// Drops one inherited record after it was adopted into the durable row.
  void discardInherited(SessionDraftKeepaliveRecord record) {
    final key = _keyFor(record.brokerProfileId, record.sessionKey);
    _inherited.remove(key);
    _discardStoredIfTextIs(key, record.text);
  }

  /// Drops every copy for one session; its durable row is gone.
  void discardSession({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) {
    final key = _keyFor(brokerProfileId, sessionKey);
    _inherited.remove(key);
    _remove(key);
  }

  /// Drops every record owned by a removed broker profile.
  ///
  /// Records are keyed by broker SCOPE, and one profile may have pointed at
  /// several endpoints, so ownership is resolved the same way the durable
  /// rows resolve it rather than by matching the encoded key.
  void discardProfile(String brokerProfileId) {
    for (final record in [..._inherited.values]) {
      if (!RosterSource.storageKeyBelongsToProfile(
        record.brokerProfileId,
        brokerProfileId,
      )) {
        continue;
      }
      _inherited.remove(_keyFor(record.brokerProfileId, record.sessionKey));
    }
    for (final entry in _storedRecords().entries) {
      if (!RosterSource.storageKeyBelongsToProfile(
        entry.value.brokerProfileId,
        brokerProfileId,
      )) {
        continue;
      }
      _remove(entry.key);
    }
  }

  /// Re-attempts writes the backing refused, at a teardown boundary.
  void retryRefusedWrites() {
    if (_refused.isEmpty) return;
    for (final entry in [..._refused.entries]) {
      final record = _decode(entry.key, entry.value);
      if (record == null) {
        _refused.remove(entry.key);
        continue;
      }
      _place(entry.key, entry.value, record.recordedAtMs);
    }
  }

  /// Writes one encoded record, making room for it if the backing refuses.
  ///
  /// Everything on this path is O(records), never O(stored bytes): the index
  /// answers what to evict, so a keystroke never decodes another draft.
  void _place(String key, String value, int recordedAtMs) {
    _evictUntil(maxSessionDraftKeepaliveRecords - 1, except: key);
    while (true) {
      try {
        _store.write(key, value);
        _placedAt[key] = recordedAtMs;
        _refused.remove(key);
        return;
      } on Object {
        // Quota. The newest value is the one worth keeping, so older records
        // yield to it — each of them still has its durable row behind it.
        if (!_evictOldest(except: key)) break;
      }
    }
    _refused[key] = value;
  }

  /// Keys this store may delete to make room.
  ///
  /// An UNADOPTED inherited record is the one thing here that may be the only
  /// surviving copy of its text: it exists precisely because its durable write
  /// may never have completed, and its adoption has not happened yet. Deleting
  /// it to make room for a newer edit would leave it in this document's memory
  /// alone, and the next teardown would take it. Once adopted or dropped
  /// (`discardInherited`, `discardSession`, `discardProfile`) the key leaves
  /// `_inherited` and becomes evictable like any other.
  Map<String, int> _evictable({required String except}) {
    return {..._placedAt}
      ..remove(except)
      ..removeWhere((key, _) => _inherited.containsKey(key));
  }

  /// Removes records, oldest first, until at most [limit] others remain.
  void _evictUntil(int limit, {required String except}) {
    final others = _evictable(except: except);
    if (others.length <= limit) return;
    final ordered = others.entries.toList()
      ..sort((a, b) => a.value.compareTo(b.value));
    for (final entry in ordered.take(others.length - limit)) {
      _remove(entry.key);
    }
  }

  bool _evictOldest({required String except}) {
    final others = _evictable(except: except);
    if (others.isEmpty) return false;
    final oldest = others.entries.reduce(
      (a, b) => a.value <= b.value ? a : b,
    );
    _remove(oldest.key);
    return true;
  }

  void _remove(String key) {
    _refused.remove(key);
    _placedAt.remove(key);
    try {
      _store.remove(key);
    } on Object {
      // A backing that cannot remove is not worth failing a session over.
    }
  }

  void _discardStoredIfTextIs(String key, String text) {
    try {
      final stored = _decode(key, _store.read(key));
      if (stored == null || stored.text != text) return;
      _remove(key);
    } on Object {
      // Best effort; a stale record is adopted or dropped on the next start.
    }
  }

  Map<String, SessionDraftKeepaliveRecord> _readInherited() {
    final records = <String, SessionDraftKeepaliveRecord>{};
    try {
      for (final entry in _store.readAll().entries) {
        if (!entry.key.startsWith(sessionDraftKeepalivePrefix)) continue;
        final record = _decode(entry.key, entry.value);
        if (record == null || record.text.isEmpty) {
          _remove(entry.key); // malformed or empty: nothing to recover
          continue;
        }
        records[entry.key] = record;
        _placedAt[entry.key] = record.recordedAtMs;
      }
    } on Object {
      // An unreadable backing simply inherits nothing.
    }
    return records;
  }

  Map<String, SessionDraftKeepaliveRecord> _storedRecords() {
    final records = <String, SessionDraftKeepaliveRecord>{};
    try {
      for (final entry in _store.readAll().entries) {
        if (!entry.key.startsWith(sessionDraftKeepalivePrefix)) continue;
        final record = _decode(entry.key, entry.value);
        if (record != null) records[entry.key] = record;
      }
    } on Object {
      // As above.
    }
    return records;
  }

  static SessionDraftKeepaliveRecord? _decode(String key, String? value) {
    if (value == null) return null;
    try {
      final decoded = jsonDecode(value);
      if (decoded is! Map) return null;
      final profile = decoded['p'];
      final tool = decoded['t'];
      final sessionId = decoded['s'];
      final text = decoded['x'];
      final at = decoded['a'];
      final base = decoded['v'];
      if (profile is! String ||
          tool is! String ||
          sessionId is! String ||
          text is! String ||
          at is! int ||
          (base != null && base is! int)) {
        return null;
      }
      // The key is derived from the identity, so a value whose identity does
      // not reproduce it was written by something else.
      final identity = SessionDetailKey(tool: tool, sessionId: sessionId);
      if (_keyFor(profile, identity) != key) return null;
      return SessionDraftKeepaliveRecord(
        brokerProfileId: profile,
        sessionKey: identity,
        text: text,
        recordedAtMs: at,
        baseMutationVersion: base as int?,
      );
    } on Object {
      return null;
    }
  }

  static String _keyFor(String brokerProfileId, SessionDetailKey sessionKey) {
    // `|` is percent-escaped by encodeComponent, so it separates unambiguously
    // whatever a broker scope key, tool id or session id contains.
    return '$sessionDraftKeepalivePrefix'
        '${Uri.encodeComponent(brokerProfileId)}|'
        '${Uri.encodeComponent(sessionKey.tool)}|'
        '${Uri.encodeComponent(sessionKey.sessionId)}';
  }
}

/// The tab-scoped keepalive.
final sessionDraftKeepaliveProvider = Provider<SessionDraftKeepalive>(
  (ref) => SessionDraftKeepalive(openSessionDraftKeepaliveStore()),
);

/// Records one composer edit synchronously, in the caller's own turn (DR1b).
///
/// Called from the controller's staging hook — the single point every composer
/// mutation passes through — so the recorded value is written before the
/// keystroke's handler returns. [brokerScopeKey] is the live socket's scope
/// when there is one; before the first attach the active profile answers, and
/// an unowned value is not recorded at all rather than being filed under a
/// broker it does not belong to.
void recordSessionDraftKeepalive(
  Ref ref,
  String? brokerScopeKey,
  SessionDetailKey sessionKey,
  String text,
  int? baseMutationVersion,
) {
  try {
    final scope =
        brokerScopeKey ??
        RosterSource.of(ref.read(activeBrokerProfileProvider))?.storageKey;
    if (scope == null) return;
    ref
        .read(sessionDraftKeepaliveProvider)
        .record(
          brokerProfileId: scope,
          sessionKey: sessionKey,
          text: text,
          baseMutationVersion: baseMutationVersion,
        );
  } on Object {
    // Durability assistance must never break typing.
  }
}
