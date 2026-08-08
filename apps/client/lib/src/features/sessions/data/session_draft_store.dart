import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_draft_keepalive.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

// The keepalive and the durable row are one mechanism: this file is where a
// record is adopted and retired, so the library that owns the draft store also
// carries the synchronous recording hook its coordinator calls.
export 'package:cosyncing_client/src/features/sessions/data/session_draft_keepalive.dart'
    show
        SessionDraftKeepalive,
        SessionDraftKeepaliveRecord,
        recordSessionDraftKeepalive,
        sessionDraftKeepaliveProvider;

/// Abandoned local draft rows expire after 30 days without an edit.
///
/// Drafts are composer prompts; measured session usage keeps them far below
/// this. A dirty row younger than the TTL is never touched, so recovery of
/// unsent text is never lost to routine cleanup.
const Duration localDraftRetention = Duration(days: 30);

/// Maximum local draft rows retained per broker profile (LRU by update time).
///
/// Mirrors the transcript cache's 100-session bound so draft storage stays
/// proportional to the sessions a profile actually uses.
const int maxRetainedLocalDraftsPerProfile = 100;

/// Maximum characters persisted for one draft.
///
/// The durable row is a recovery copy for prompts, not transcripts; one
/// pathological composer value can never dominate local storage. Longer text
/// is NOT truncated to fit — a stored prefix would present a malformed prompt
/// as if it were the real draft on the next open. Persistence is refused
/// instead: the full value stays in widget memory, the previously stored row
/// survives untouched, and the composer surfaces the reduced durability.
const int maxLocalDraftTextChars = 256 * 1024;

/// Whether mounted controllers should subscribe to Drift's cross-window row
/// stream.
///
/// Browser windows share the Drift worker and receive invalidations. Native
/// databases don't provide a cross-process worker; avoiding a useless query
/// subscription there also keeps lifecycle teardown exact.
final sessionDraftCrossWindowObservationEnabledProvider = Provider<bool>(
  (_) => kIsWeb,
);

/// One durable device-local composer draft (DR1).
///
/// At most one row exists per exact broker profile/tool/session. Ordering
/// across devices uses broker draft revisions only — never client wall clocks.
@immutable
final class SessionLocalDraft {
  /// Creates a local draft record.
  const SessionLocalDraft({
    required this.brokerProfileId,
    required this.sessionKey,
    required this.text,
    required this.localRevision,
    required this.baseBrokerRevision,
    required this.dirty,
    required this.updatedAt,
    this.mutationVersion = 0,
    this.submittedClientMessageId,
    this.pendingClearRevision,
    this.conflictText,
    this.conflictBrokerRevision,
  });

  /// Creates a first local edit record for a session.
  factory SessionLocalDraft.create({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
    required String text,
  }) {
    return SessionLocalDraft(
      brokerProfileId: brokerProfileId,
      sessionKey: sessionKey,
      text: text,
      localRevision: 1,
      baseBrokerRevision: 0,
      dirty: true,
      updatedAt: DateTime.now(),
    );
  }

  /// Broker scope key (`RosterSource.storageKey`) of the broker this draft
  /// was composed against. Profile AND endpoint: a draft is conversation
  /// content for one exact broker's session, so an endpoint edit leaves it
  /// unreadable instead of surfacing it in the new machine's composer.
  final String brokerProfileId;

  /// Tool/session identity within [brokerProfileId].
  final SessionDetailKey sessionKey;

  /// Current local draft text ('' is a pending clear).
  final String text;

  /// Local monotone revision, incremented per coalesced edit flush.
  final int localRevision;

  /// Broker draft revision this local value is based on.
  final int baseBrokerRevision;

  /// Whether the broker has not acknowledged the local value.
  final bool dirty;

  /// Monotone version of the stored row this value was read from.
  ///
  /// Writes are conditional on it, so a concurrent writer that shares the
  /// database but not this process — a second browser tab — cannot have its
  /// change silently replaced by a whole-row overwrite.
  final int mutationVersion;

  /// Outbox handoff association while a send awaits broker delivery.
  final String? submittedClientMessageId;

  /// Shared revision an unfinished post-send clear targets, when the broker
  /// accepted the prompt but could not durably clear the draft it contained.
  ///
  /// Non-null makes this empty row a *conditional* clear rather than an
  /// ordinary empty edit: it may only clear the shared record while that
  /// record is still the one this device's prompt actually sent.
  final int? pendingClearRevision;

  /// Preserved shared-draft text for an unresolved conflict.
  final String? conflictText;

  /// Broker revision of [conflictText].
  final int? conflictBrokerRevision;

  /// Last local mutation time (TTL/LRU retention).
  final DateTime updatedAt;

  /// Whether an unresolved local-vs-shared conflict is preserved on this row.
  bool get hasConflict => conflictText != null;

  /// Whether this row is an unfinished post-send clear of the shared draft.
  bool get isPendingClear => pendingClearRevision != null;

  /// Returns a copy with optional overrides.
  SessionLocalDraft copyWith({
    String? text,
    int? localRevision,
    int? baseBrokerRevision,
    bool? dirty,
    int? mutationVersion,
    String? submittedClientMessageId,
    int? pendingClearRevision,
    String? conflictText,
    int? conflictBrokerRevision,
    DateTime? updatedAt,
    bool clearSubmitted = false,
    bool clearPendingClear = false,
    bool clearConflict = false,
  }) {
    return SessionLocalDraft(
      brokerProfileId: brokerProfileId,
      sessionKey: sessionKey,
      text: text ?? this.text,
      localRevision: localRevision ?? this.localRevision,
      baseBrokerRevision: baseBrokerRevision ?? this.baseBrokerRevision,
      dirty: dirty ?? this.dirty,
      mutationVersion: mutationVersion ?? this.mutationVersion,
      submittedClientMessageId: clearSubmitted
          ? null
          : submittedClientMessageId ?? this.submittedClientMessageId,
      pendingClearRevision: clearPendingClear
          ? null
          : pendingClearRevision ?? this.pendingClearRevision,
      conflictText: clearConflict ? null : conflictText ?? this.conflictText,
      conflictBrokerRevision: clearConflict
          ? null
          : conflictBrokerRevision ?? this.conflictBrokerRevision,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }
}

/// Persistence boundary for device-local composer drafts.
abstract interface class SessionDraftRepository {
  /// Loads the current row for one profile-scoped session, if any.
  Future<SessionLocalDraft?> load({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  });

  /// Atomically replaces the row for one profile-scoped session, but only while
  /// the stored row is still at [SessionLocalDraft.mutationVersion].
  ///
  /// Returns the stored row (at its new version) on success, or null when
  /// another writer changed it first. The caller must reload before deciding
  /// what to do — its own value was computed from a row that no longer exists.
  ///
  /// Text longer than [maxLocalDraftTextChars] throws [ArgumentError]: the
  /// store never persists a silent prefix of a value it claims to hold.
  Future<SessionLocalDraft?> save(SessionLocalDraft draft);

  /// Deletes the row for one profile-scoped session, but only while it is
  /// still at [expectedMutationVersion]. Returns whether a row was deleted;
  /// false means another writer changed (or already removed) it first, so the
  /// caller's reason for deleting was computed from a row that no longer
  /// exists.
  Future<bool> delete({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
    required int expectedMutationVersion,
  });

  /// Deletes every draft row owned by a broker profile (profile removal).
  Future<void> deleteForProfile(String brokerProfileId);
}

/// Draft repository that can observe accepted writes from another app window.
///
/// This refines the legacy repository interface so existing focused fakes do
/// not need to synthesize streams. Production Drift repositories implement it;
/// a mounted Session Detail observes exactly one profile/tool/session row.
abstract interface class ObservableSessionDraftRepository
    implements SessionDraftRepository {
  /// Watches one exact broker-scoped session row.
  Stream<SessionLocalDraft?> watch({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  });
}

/// Drift-backed device-local draft repository.
final class DriftSessionDraftRepository
    implements ObservableSessionDraftRepository {
  /// Creates a repository backed by [database].
  ///
  /// [keepalive] is the synchronous DR1b write-ahead record. Given one, this
  /// repository is the single place where it and the durable row meet: a
  /// record left by a previous document is adopted on the first load of its
  /// session, and a record is dropped the moment the row holds its value.
  const DriftSessionDraftRepository(this.database, {this.keepalive});

  /// App-local durable database.
  final AppDatabase database;

  /// Synchronous pre-durability record, or null where there is none (focused
  /// tests, and the maintenance pass, which must never adopt).
  final SessionDraftKeepalive? keepalive;

  @override
  Future<SessionLocalDraft?> load({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) async {
    final row = await _selectRow(brokerProfileId, sessionKey);
    return _adoptKeepalive(
      brokerProfileId,
      sessionKey,
      row == null ? null : _fromRow(row),
    );
  }

  /// Adopts what a destroyed document recorded but could not persist (DR1b).
  ///
  /// Runs at hydration, which is where a composer's value comes from, so a
  /// refresh that outran the 300 ms debounce reopens on the text that was on
  /// screen rather than the last debounced one.
  ///
  /// A record is newer than the row only within the TAB that wrote it. The row
  /// is shared: another tab can advance it while this one is gone, and then the
  /// record describes a row that no longer exists. Adoption is therefore
  /// conditional on lineage — [SessionDraftKeepaliveRecord.baseMutationVersion]
  /// names the exact row the composer was editing. Nobody touched it since:
  /// adopt as an ordinary local edit, dirty and publishable. Somebody did: the
  /// newer row stays, and the record's text is preserved as the row's second
  /// version so DR1's existing Keep-device/Use-shared choice can offer it —
  /// unsent text is never dropped just because it lost a race.
  Future<SessionLocalDraft?> _adoptKeepalive(
    String brokerProfileId,
    SessionDetailKey sessionKey,
    SessionLocalDraft? current,
  ) async {
    final pending = keepalive;
    if (pending == null) return current;
    // Bounded retry: losing a CAS below means another writer advanced the row
    // inside this very window, and returning the pre-race row would hand the
    // controller a stale value it then caches as loaded. One re-read against
    // the winner settles every ordering this method can lose; a second loss
    // returns the freshest row with the record left inherited.
    var row = current;
    for (var attempt = 0; ; attempt++) {
      final record = pending.inheritedFor(
        brokerProfileId: brokerProfileId,
        sessionKey: sessionKey,
      );
      if (record == null) return row;
      if (record.text.isEmpty ||
          record.text.length > maxLocalDraftTextChars ||
          row?.text == record.text) {
        // Nothing to recover, unstorable, or already exactly what the row
        // holds.
        pending.discardInherited(record);
        return row;
      }

      // Lineage: null base means "there was no row"; anything else names one.
      // A vanished base (row null, base non-null) is NOT a mismatch to hold
      // on: the row this record was typed over was sent or deleted by another
      // tab, but the record's text itself never landed anywhere. It is unsent
      // typing, and leaving it inherited would keep it invisible forever —
      // recreate it as an ordinary dirty draft. If the deletion reflected a
      // delivered send of this very text, the shared model's clear reconciles
      // through the ordinary non-destructive conflict choice.
      final existing = row;
      SessionLocalDraft? written;
      if (existing != null &&
          existing.mutationVersion != record.baseMutationVersion) {
        // The row moved on. Never overwrite it, and never discard the
        // record's text silently either.
        if (existing.conflictText != null) {
          // A row already holding an unresolved second version has nowhere to
          // put a third. Leave the record inherited so a later load can
          // re-derive once the user has resolved what is there.
          return existing;
        }
        written = await save(
          existing.copyWith(
            conflictText: record.text,
            updatedAt: DateTime.now(),
          ),
        );
      } else {
        written = await save(
          (existing ??
                  SessionLocalDraft.create(
                    brokerProfileId: brokerProfileId,
                    sessionKey: sessionKey,
                    text: record.text,
                  ))
              .copyWith(
                text: record.text,
                localRevision: (existing?.localRevision ?? 0) + 1,
                dirty: true,
                clearSubmitted: true,
                clearPendingClear: true,
                updatedAt: DateTime.now(),
              ),
        );
      }
      if (written != null) {
        pending.discardInherited(record);
        return written;
      }
      // Lost the CAS: re-read the winner and re-derive against it.
      final winner = await _selectRow(brokerProfileId, sessionKey);
      row = winner == null ? null : _fromRow(winner);
      if (attempt >= 1) return row;
    }
  }

  @override
  Stream<SessionLocalDraft?> watch({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) {
    final query = database.select(database.sessionDraftRows)
      ..where(
        (candidate) =>
            candidate.brokerProfileId.equals(brokerProfileId) &
            candidate.tool.equals(sessionKey.tool) &
            candidate.sessionId.equals(sessionKey.sessionId),
      );
    return query.watchSingleOrNull().map(
      (row) => row == null ? null : _fromRow(row),
    );
  }

  @override
  Future<SessionLocalDraft?> save(SessionLocalDraft draft) async {
    if (draft.text.length > maxLocalDraftTextChars) {
      throw ArgumentError.value(
        draft.text.length,
        'draft.text.length',
        'exceeds maxLocalDraftTextChars; a truncated prefix must never be '
            'persisted as though it were the draft',
      );
    }
    final stored = draft.copyWith(mutationVersion: draft.mutationVersion + 1);
    // ONE conditional statement, not read-then-write. Another tab holds its own
    // connection, and even inside a transaction a SELECT takes only a read
    // lock: two writers can both read version N and then upsert in turn, the
    // second silently discarding the first's text, submission association,
    // pending clear, or conflict state. `UPDATE … WHERE mutation_version = ?`
    // checks and writes under the same write lock, so exactly one wins and the
    // loser learns it from the affected-row count.
    final updated =
        await (database.update(database.sessionDraftRows)..where(
              (row) =>
                  row.brokerProfileId.equals(draft.brokerProfileId) &
                  row.tool.equals(draft.sessionKey.tool) &
                  row.sessionId.equals(draft.sessionKey.sessionId) &
                  row.mutationVersion.equals(draft.mutationVersion),
            ))
            .write(_toCompanion(stored));
    if (updated > 0) {
      _settleKeepalive(draft, stored);
      return stored;
    }
    // Version 0 with no matching row means the caller read "no row yet" (a row
    // migrated from before versioning matches the UPDATE above instead). Create
    // it — unless another writer created one first, which the insert's conflict
    // clause reports as a refusal rather than resolving as an overwrite.
    if (draft.mutationVersion != 0) return null;
    final inserted = await database
        .into(database.sessionDraftRows)
        .insertReturningOrNull(
          _toCompanion(stored),
          mode: InsertMode.insertOrIgnore,
        );
    if (inserted == null) return null;
    // The insert SUCCEEDING is the proof that no row existed: a record whose
    // base is null was typed over the same nothing, so it is this tab's own
    // lineage and must be carried forward rather than disputed.
    _settleKeepalive(draft, stored, fromNoRow: true);
    return stored;
  }

  /// Retires or rebases the synchronous record after a successful save.
  ///
  /// Retirement is value-conditional: a record newer than what was just
  /// written is precisely what must survive, and dropping it here would reopen
  /// the gap this closes. A SURVIVING record whose base names the version this
  /// save just replaced is then rebased onto the new one: it was typed on top
  /// of this tab's own linear history, not a competing writer's, and without
  /// the rebase the next start would read it against the advanced row and
  /// manufacture a cross-tab conflict out of one tab's own typing.
  void _settleKeepalive(
    SessionLocalDraft draft,
    SessionLocalDraft stored, {
    bool fromNoRow = false,
  }) {
    keepalive
      ?..discardDurable(
        brokerProfileId: stored.brokerProfileId,
        sessionKey: stored.sessionKey,
        text: stored.text,
      )
      ..rebaseDurable(
        brokerProfileId: stored.brokerProfileId,
        sessionKey: stored.sessionKey,
        fromVersion: draft.mutationVersion,
        toVersion: stored.mutationVersion,
        fromNoRow: fromNoRow,
      );
  }

  Future<SessionDraftRow?> _selectRow(
    String brokerProfileId,
    SessionDetailKey sessionKey,
  ) {
    return (database.select(database.sessionDraftRows)..where(
          (candidate) =>
              candidate.brokerProfileId.equals(brokerProfileId) &
              candidate.tool.equals(sessionKey.tool) &
              candidate.sessionId.equals(sessionKey.sessionId),
        ))
        .getSingleOrNull();
  }

  @override
  Future<bool> delete({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
    required int expectedMutationVersion,
  }) async {
    // Conditional for the same reason save is: a delete decided against a stale
    // row would destroy whatever another tab just wrote there.
    final deleted =
        await (database.delete(database.sessionDraftRows)..where(
              (row) =>
                  row.brokerProfileId.equals(brokerProfileId) &
                  row.tool.equals(sessionKey.tool) &
                  row.sessionId.equals(sessionKey.sessionId) &
                  row.mutationVersion.equals(expectedMutationVersion),
            ))
            .go();
    if (deleted > 0) {
      // The row is gone on purpose (a delivered send). Leaving a record would
      // let the next start resurrect the prompt that was already sent.
      keepalive?.discardSession(
        brokerProfileId: brokerProfileId,
        sessionKey: sessionKey,
      );
    }
    return deleted > 0;
  }

  @override
  Future<void> deleteForProfile(String brokerProfileId) async {
    keepalive?.discardProfile(brokerProfileId);
    // Rows are keyed by the broker SCOPE (`RosterSource.storageKey`), and the
    // deleted profile may have pointed at several endpoints over its life.
    // Resolve the matching scopes in Dart — the encoded key can contain SQL
    // LIKE wildcards, so a pattern match would over-delete.
    final query = database.selectOnly(
      database.sessionDraftRows,
      distinct: true,
    )..addColumns([database.sessionDraftRows.brokerProfileId]);
    final rows = await query
        .map((row) => row.read(database.sessionDraftRows.brokerProfileId))
        .get();
    final owned = rows
        .whereType<String>()
        .where(
          (scope) =>
              RosterSource.storageKeyBelongsToProfile(scope, brokerProfileId),
        )
        .toList(growable: false);
    if (owned.isEmpty) return;
    await (database.delete(
      database.sessionDraftRows,
    )..where((row) => row.brokerProfileId.isIn(owned))).go();
  }

  SessionLocalDraft _fromRow(SessionDraftRow row) {
    return SessionLocalDraft(
      brokerProfileId: row.brokerProfileId,
      sessionKey: SessionDetailKey(tool: row.tool, sessionId: row.sessionId),
      text: row.draftText,
      localRevision: row.localRevision,
      baseBrokerRevision: row.baseBrokerRevision,
      dirty: row.dirty,
      mutationVersion: row.mutationVersion,
      submittedClientMessageId: row.submittedClientMessageId,
      pendingClearRevision: row.pendingClearRevision,
      conflictText: row.conflictText,
      conflictBrokerRevision: row.conflictBrokerRevision,
      updatedAt: row.updatedAt,
    );
  }

  SessionDraftRowsCompanion _toCompanion(SessionLocalDraft draft) {
    return SessionDraftRowsCompanion.insert(
      brokerProfileId: draft.brokerProfileId,
      tool: draft.sessionKey.tool,
      sessionId: draft.sessionKey.sessionId,
      draftText: draft.text,
      localRevision: Value(draft.localRevision),
      baseBrokerRevision: Value(draft.baseBrokerRevision),
      dirty: Value(draft.dirty),
      mutationVersion: Value(draft.mutationVersion),
      submittedClientMessageId: Value(draft.submittedClientMessageId),
      pendingClearRevision: Value(draft.pendingClearRevision),
      conflictText: Value(draft.conflictText),
      conflictBrokerRevision: Value(draft.conflictBrokerRevision),
      updatedAt: draft.updatedAt,
    );
  }
}

/// Profile-scoped device-local draft repository.
final sessionDraftRepositoryProvider = Provider<SessionDraftRepository>(
  (ref) => DriftSessionDraftRepository(
    ref.watch(appDatabaseProvider),
    keepalive: ref.watch(sessionDraftKeepaliveProvider),
  ),
);
