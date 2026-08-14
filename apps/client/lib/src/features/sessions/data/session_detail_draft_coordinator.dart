// Same-library coordinators intentionally access Notifier-owned state.
// ignore_for_file: invalid_use_of_protected_member
// ignore_for_file: invalid_use_of_visible_for_testing_member
part of 'session_detail_controller.dart';

/// How long a versioned publish waits for its broker echo before the dirty row
/// retries. The broker answers every accepted/duplicate/rejected write, so this
/// only fires on a dropped frame or a broker that could not durably store the
/// mutation. It is a bounded recovery, not a poll: [_maxDraftPublishRetries]
/// caps the attempts for one unchanged value, and any new edit or reconnect
/// starts a fresh, already-justified attempt.
const Duration _draftPublishAckTimeout = Duration(seconds: 10);

/// Attempts spent republishing one unchanged local value that went
/// unacknowledged.
const int _maxDraftPublishRetries = 2;

/// How many of this device's recent update tokens stay recognizable after their
/// publish slot is released. Only in-flight frames can still be echoed, and at
/// most one publish is outstanding at a time, so a handful is ample.
const int _maxRememberedDraftPublishIds = 8;

/// Maximum accepted database-write versions retained for delayed Drift echoes.
///
/// A session serializes its writes, so only a short tail can still be queued.
const int _maxRememberedLocalMutationVersions = 16;

/// One versioned draft publish awaiting its broker acknowledgement (DR1).
///
/// Nothing converges on the socket write alone: the shared copy is only known
/// to hold this value when the broker echoes the matching `updateId`.
final class _PendingDraftPublish {
  const _PendingDraftPublish({
    required this.updateId,
    required this.text,
    required this.localRevision,
    required this.baseRevision,
  });

  /// Idempotency token the broker echoes back on acceptance.
  final String updateId;

  /// Exact text this publish carried.
  final String text;

  /// Local row revision it was taken from.
  final int localRevision;

  /// Shared revision it was based on.
  final int baseRevision;
}

/// One send handoff's snapshot of the draft it is carrying (DR1).
///
/// [text] and [localRevision] identify the exact row, so the binding can refuse
/// a row a foreign draft frame replaced while the prompt was being persisted.
/// [revision] and [updateId] are the ownership pair the prompt reports, which
/// the durable outbox payload also stores verbatim so a replay reproduces the
/// identical frame.
final class _DraftHandoff {
  const _DraftHandoff({
    required this.text,
    required this.localRevision,
    required this.revision,
    required this.updateId,
  });

  /// Text of the local draft row at send time, or null when there is none.
  final String? text;

  /// Local revision of that row.
  final int? localRevision;

  /// Shared revision this device had adopted.
  final int? revision;

  /// Token of a draft write not yet acknowledged.
  final String? updateId;
}

/// Thrown inside a serialized draft mutation when the profile scope it was
/// accepted under disappeared during an await. `_serializeDraftMutation`
/// converts it into the mutation's `whenStale` result, so no code after the
/// throwing await runs — not a publish, not a composer surface, not a row
/// write.
final class _StaleDraftScope implements Exception {
  const _StaleDraftScope();
}

/// Thrown when a durable draft write was refused because another writer — a
/// second tab sharing the database, or a maintenance pass — changed the row
/// first. The cache has already been reloaded by the time a handler sees this,
/// so a bounded retry (`_withDraftRowRetry`) re-derives from current state;
/// anything computed from the pre-refusal row must not run.
final class _StaleDraftRow implements Exception {
  const _StaleDraftRow();
}

/// Device-local persistence outcome for one exact composer value.
///
/// Broker publication is intentionally absent: navigation cares whether text
/// crossed the durable repository boundary, not whether this window currently
/// has authority to mutate the shared broker draft.
enum SessionDraftPersistenceResult {
  /// The value was accepted by the durable repository.
  persisted,

  /// The exact value was already durable, including an empty initial draft.
  alreadyPersisted,

  /// No exact broker source was available for a safe write.
  sourceUnavailable,

  /// The complete value exceeds the bounded durable row.
  tooLarge,

  /// The repository refused or failed the write.
  failed;

  /// Whether navigation may safely release the mounted composer.
  bool get isDurable =>
      this == SessionDraftPersistenceResult.persisted ||
      this == SessionDraftPersistenceResult.alreadyPersisted;
}

/// The profile scope one serialized draft mutation runs under.
///
/// A generation check only at the start of a mutation cannot cancel one that
/// is already awaiting when the profile switches: everything after that await
/// — row writes, publishes, composer surfaces, conflict state — would still
/// run against the new profile. Every await inside a mutation therefore goes
/// through [guard], which re-validates the scope the moment the awaited work
/// resolves and unwinds the whole mutation when it is gone.
final class _DraftScope {
  _DraftScope(this._controller, this._generation);

  final SessionDetailController _controller;
  final int _generation;

  /// Whether the profile scope this mutation was accepted under is gone, so
  /// its remaining effects must not run.
  bool get lost =>
      _controller._disposed || _controller._draftCacheGeneration != _generation;

  /// Awaits [future], then fails the mutation if the scope died meanwhile.
  Future<T> guard<T>(Future<T> future) async {
    final value = await future;
    if (lost) throw const _StaleDraftScope();
    return value;
  }
}

/// Durable, versioned two-copy composer drafts (DR1).
///
/// The device-local Drift row (via [SessionDraftRepository]) protects the
/// current device's unsent text; the broker's versioned shared record
/// coordinates clients. Ordering uses broker revisions and idempotency
/// `updateId`s, never client wall clocks. A dirty local value is retried once
/// per (re)connect without another keystroke, a newer shared revision never
/// silently overwrites unsynchronized local text, and independent edits on
/// both sides preserve both versions until the user resolves them.
///
/// Publishing is acknowledgement-driven, not socket-send-driven: at most one
/// publish is outstanding, and the next one is issued from the broker's answer,
/// so a trailing edit is never sent against a base revision the echo is about
/// to supersede (which the broker would reject as stale, leaving the shared
/// copy permanently one edit behind).
///
/// Public so the session detail page (a different library) can call the
/// draft-facing controller API.
extension SessionDetailDrafts on SessionDetailController {
  /// Whether the attached broker speaks durable versioned drafts (contract
  /// revision 3), or null while the current socket's hello has not arrived.
  ///
  /// The tri-state matters: an unknown broker must NOT be assumed legacy. The
  /// legacy relay is unversioned last-writer-wins, so publishing under that
  /// assumption can overwrite a newer shared draft with no conflict detection
  /// at all. Publishing waits for the answer instead — the hello frame arrives
  /// on the same attach and re-triggers the retry.
  ///
  /// This deliberately reads ONLY the field negotiated by the live socket.
  /// `state.hello` is the event projection, which survives a reconnect and
  /// would happily answer for a broker that is no longer on the other end —
  /// the exact staleness this gate exists to prevent.
  bool? get _brokerVersionedDraftSupport {
    final revision = _brokerContractRevision;
    return revision == null ? null : revision >= 3;
  }

  /// Drops the negotiated draft capability so the next handshake decides it
  /// again.
  ///
  /// Capability belongs to ONE socket generation, never to the controller. A
  /// broker can be rolled back, replaced, or swapped for another profile
  /// between two connects, so any answer from a previous socket — including a
  /// plain network reconnect — is worthless. Carrying a revision-3 answer into
  /// a revision-2 broker would publish versioned drafts that it applies as
  /// legacy last-writer-wins. Called on every teardown AND on every
  /// non-connected transport transition.
  void _forgetNegotiatedContract() {
    _brokerContractRevision = null;
    _abandonDraftPublish();
  }

  SessionDraftRepository get _draftRepository =>
      ref.read(sessionDraftRepositoryProvider);

  /// The cached draft row, so a test can assert what a late-resolving database
  /// operation did (or did not) leave behind.
  @visibleForTesting
  SessionLocalDraft? get cachedLocalDraft => _localDraft;

  /// Runs one draft-row mutation with no other mutation interleaved.
  ///
  /// [_saveLocalDraft] replaces the cached row only after its database write
  /// resolves, so every mutation here is a `read → await → write-whole-row`.
  /// Two of them overlapping both read the pre-write row, and whichever writes
  /// last silently discards the other's field changes. That is not theoretical:
  /// a send binding its draft and another device's draft frame arriving during
  /// that write is one keystroke apart from the normal case, and the losing
  /// write is the binding — which leaves the sent prompt to be republished as
  /// everyone's shared draft.
  ///
  /// Serializing is enough because a mutation never awaits another mutation:
  /// the publish path they trigger reads the row but does not rewrite it.
  Future<T> _serializeDraftMutation<T>(
    Future<T> Function(_DraftScope scope) mutation, {
    required T whenStale,
  }) {
    // Bound to the profile generation the work was ACCEPTED under. A queued
    // operation can wait behind others while the controller switches brokers,
    // and running it afterwards would apply one profile's draft — or a draft
    // frame from a socket that is already gone — to another profile's session.
    // The scope travels INTO the mutation so the same check re-runs after
    // every await, not only here at the start.
    final scope = _DraftScope(this, _draftCacheGeneration);
    final result = _draftMutations.then<T>((_) async {
      if (scope.lost) return whenStale;
      try {
        return await mutation(scope);
      } on _StaleDraftScope {
        return whenStale;
      } on _StaleDraftRow {
        // Defense in depth: a refusal that escapes its handler's bounded
        // retry aborts the mutation's remaining effects instead of surfacing
        // as an error.
        return whenStale;
      }
    });
    // The tail absorbs failures so one rejected mutation cannot poison the
    // chain for every later one.
    _draftMutations = result.then((_) {}, onError: (Object _) {});
    return result;
  }

  /// Runs [attempt], retrying once when a durable write inside it was refused
  /// by a concurrent writer.
  ///
  /// [_saveLocalDraft] and [_deleteLocalDraft] reload the cache before their
  /// refusal surfaces, so the second run derives from what the other writer
  /// actually left behind rather than from a guess. Two writers ping-ponging
  /// indefinitely is not worth chasing: after the bounded retry the mutation
  /// gives up, re-syncs the conflict banner to whatever row survived, and
  /// returns [whenRefused] — with NONE of the attempt's dependent effects run.
  Future<T> _withDraftRowRetry<T>(
    Future<T> Function() attempt, {
    required T whenRefused,
  }) async {
    for (var tries = 0; tries < 2; tries++) {
      try {
        return await attempt();
      } on _StaleDraftRow {
        // The cache was reloaded where the refusal was raised.
      }
    }
    _syncDraftConflictBannerToRow();
    return whenRefused;
  }

  /// Re-projects the conflict banner from the row that survived a lost race.
  ///
  /// After a mutation gives up to a concurrent writer, the surviving row is
  /// that writer's. A banner left up unchanged can be wrong two ways: it can
  /// offer a resolution whose preserved version no longer exists, or — when
  /// the surviving row preserves a DIFFERENT second version — it can show
  /// stale resolution text, so the user's choice applies to values they were
  /// never shown. The banner is a projection of the row; rebuild it from the
  /// row.
  void _syncDraftConflictBannerToRow() {
    if (_disposed) return;
    final banner = state.draftConflict;
    if (banner == null) return;
    // A recovered-prompt offer is backed by a failed outbox row, not by this
    // draft row, so no draft-row race can invalidate it.
    if (banner.recoveredPromptId != null) return;
    final row = _localDraft;
    final preserved = row?.conflictText;
    if (preserved == null) {
      state = state.copyWith(clearDraftConflict: true);
      return;
    }
    final projected = _projectDraftConflict(row!);
    if (banner.sharedText != projected.sharedText ||
        banner.localText != projected.localText ||
        banner.sharedRevision != projected.sharedRevision) {
      state = state.copyWith(draftConflict: projected);
    }
  }

  /// Projects a durable two-version row from THIS mounted window's point of
  /// view.
  ///
  /// The row is shared by browser windows, so `row.text` means "the writer
  /// that won the CAS", not "this window". If this composer's staged value is
  /// the preserved side, swapping the presentation is essential: Keep local
  /// must retain what this user can still see in this composer.
  SessionDraftConflict _projectDraftConflict(SessionLocalDraft row) {
    final preserved = row.conflictText!;
    final staged = _stagedLocalDraftText;
    final localIsPreserved =
        staged != null && staged == preserved && staged != row.text;
    return SessionDraftConflict(
      localText: localIsPreserved ? preserved : row.text,
      sharedText: localIsPreserved ? row.text : preserved,
      sharedRevision: row.conflictBrokerRevision,
      kind: row.conflictBrokerRevision == null
          ? SessionDraftConflictKind.unsentPrompt
          : SessionDraftConflictKind.sharedDivergence,
    );
  }

  /// Loads and caches the local draft row for [profileId] once per profile.
  Future<void> _ensureLocalDraftLoadedFor(
    String profileId,
    _DraftScope scope,
  ) async {
    if (_loadedDraftScopeKey == profileId) {
      _observeLocalDraftFor(profileId);
      return;
    }
    try {
      final row = await scope.guard(
        _draftRepository.load(brokerProfileId: profileId, sessionKey: arg),
      );
      _localDraft = row;
      _loadedDraftScopeKey = profileId;
      _observeLocalDraftFor(profileId);
    } on _StaleDraftScope {
      rethrow;
    } on Object {
      // Durability must never block the session; the next trigger retries.
    }
  }

  /// Starts one exact-row database observation for the mounted session.
  ///
  /// Drift's shared web worker propagates accepted writes across windows. This
  /// is event-driven (no timer/poll) and the auto-disposed controller owns only
  /// its current session subscription.
  void _observeLocalDraftFor(String profileId) {
    if (_observedDraftScopeKey == profileId) return;
    if (!ref.read(sessionDraftCrossWindowObservationEnabledProvider)) return;
    final repository = _draftRepository;
    if (repository is! ObservableSessionDraftRepository) return;
    _observedDraftScopeKey = profileId;
    unawaited(_localDraftSubscription?.cancel());
    _localDraftSubscription = repository
        .watch(brokerProfileId: profileId, sessionKey: arg)
        .listen((row) {
          unawaited(
            _serializeDraftMutation<void>(
              (scope) => _acceptObservedLocalDraft(profileId, row, scope),
              whenStale: null,
            ),
          );
        });
  }

  /// Records the live composer value before the 300 ms durable debounce, and
  /// writes the DR1b keepalive record synchronously in the same turn — so a
  /// cross-window write AND a destroyed document both preserve it.
  void stageLocalDraft(String text) {
    if (_disposed) return;
    _stagedLocalDraftText = text;
    _lastLocalDraftEditAt = DateTime.now();
    if (text.isNotEmpty) _composerHeldContentGeneration = _composerGeneration;
    recordSessionDraftKeepalive(
      ref,
      _brokerScopeKey,
      arg,
      text,
      _localDraft?.mutationVersion,
    );
  }

  /// Re-offers the durable row to a composer that has just been built (DR1b).
  ///
  /// Hydration runs on connected TRANSITIONS, which is the only moment DR1
  /// offers the row. An open session is resident (OS1): leaving it and coming
  /// back — and returning to a route inside a document that is already
  /// attached — builds a new, empty composer against a controller that never
  /// disconnected, so nothing offers it anything and a durable value sits
  /// invisible while the user believes it is lost.
  ///
  /// Deliberately [SessionDraftSurfaceKind.restoreIfEmpty]: this re-offer is
  /// the weakest possible claim on the composer. It fills an empty one and
  /// leaves a composer with content — including one the user is mid-sentence
  /// in — completely alone. A row still bound to a live send is skipped for
  /// the same reason hydration skips it: that text was already sent.
  /// Loads the row itself rather than reading the cache: a composer mounting
  /// on a cold route has no cached row yet, and the connected transition that
  /// would have loaded one may already have happened (or be about to be
  /// missed). Asking the repository directly makes the offer independent of
  /// whether hydration ran at all.
  Future<void> offerDurableDraftToComposer() {
    // Synchronous, before the mutation is queued: this is the composer's
    // announcement, and everything the PREVIOUS one earned stops applying at
    // exactly this point rather than whenever the queue gets around to it.
    _composerGeneration++;
    // The announcement is true the moment the offer is CALLED — a composer
    // exists — independent of whether the load below succeeds. Recording it
    // only after a successful load left a window where a transient durability
    // hiccup (or a not-yet-resolved profile) kept connected hydration on the
    // stronger `replace`, free to overwrite newer unfocused typing.
    _composerAnnouncedThisAttach = true;
    return _serializeDraftMutation(
      _offerDurableDraftToComposerLocked,
      whenStale: null,
    );
  }

  Future<void> _offerDurableDraftToComposerLocked(_DraftScope scope) async {
    if (_disposed) return;
    final profileId =
        _brokerScopeKey ??
        RosterSource.of(ref.read(activeBrokerProfileProvider))?.storageKey;
    if (profileId == null) return; // no broker yet; hydration still covers it
    try {
      await _ensureLocalDraftLoadedFor(profileId, scope);
    } on _StaleDraftScope {
      rethrow;
    } on Object {
      return; // a durability hiccup must never break opening a session
    }
    if (_disposed || _loadedDraftScopeKey != profileId) return;
    final row = _localDraft;
    if (row == null ||
        row.text.isEmpty ||
        row.submittedClientMessageId != null ||
        state.draftConflict != null) {
      return;
    }
    // This IS this attach's composer surface; hydration must not emit another.
    _draftHydrated = true;
    _surfaceDraft(row.text, kind: SessionDraftSurfaceKind.restoreIfEmpty);
  }

  Future<void> _acceptObservedLocalDraft(
    String profileId,
    SessionLocalDraft? observed,
    _DraftScope scope,
  ) async {
    if (_loadedDraftScopeKey != profileId) return;
    final cached = _localDraft;
    if (observed?.mutationVersion == cached?.mutationVersion) return;
    final observedVersion = observed?.mutationVersion;
    final cachedVersion = cached?.mutationVersion;
    if (observedVersion != null &&
        cachedVersion != null &&
        observedVersion < cachedVersion) {
      // A query snapshot can already be queued when this controller commits a
      // newer CAS write. Row mutation versions are monotone, so applying that
      // delayed snapshot would roll the composer and its surface backwards.
      return;
    }
    if (observedVersion != null &&
        _ownedDraftMutationVersions.remove(observedVersion)) {
      return;
    }
    if (observed == null && _ownedDraftDeletesAwaitingObservation > 0) {
      _ownedDraftDeletesAwaitingObservation--;
      return;
    }

    final staged = _stagedLocalDraftText;
    if (observed == null) {
      _localDraft = null;
      if (staged == null || staged.isEmpty) {
        _stagedLocalDraftText = '';
        _surfaceDraft('', kind: SessionDraftSurfaceKind.replace);
        if (state.draftConflict != null) {
          state = state.copyWith(clearDraftConflict: true);
        }
        return;
      }
      // Another window cleared/sent the shared row while this window already
      // contains new local text. Recreate only this staged value; an empty
      // tombstone is not a competing text version.
      try {
        final stored = await _saveLocalDraft(
          SessionLocalDraft.create(
            brokerProfileId: profileId,
            sessionKey: arg,
            text: staged,
          ),
          scope,
        );
        _localDraft = stored;
      } on _StaleDraftRow {
        // A newer observation will re-derive from the row that won.
      }
      return;
    }

    if (staged != null && staged != observed.text) {
      // If the durable row already carries an unresolved second version, keep
      // that bounded pair intact. The staged text remains in the mounted
      // composer and the existing explicit choice must resolve before another
      // shared publication can occur.
      if (observed.conflictText != null) {
        _localDraft = observed;
        _restorePreservedDraftConflict(observed);
        return;
      }
      final preserved = observed.text;
      try {
        final stored = await _saveLocalDraft(
          observed.copyWith(
            text: staged,
            localRevision: observed.localRevision + 1,
            dirty: true,
            clearSubmitted: true,
            clearPendingClear: true,
            conflictText: preserved.isEmpty ? null : preserved,
            updatedAt: DateTime.now(),
          ),
          scope,
        );
        if (preserved.isNotEmpty && !_disposed) {
          state = state.copyWith(
            draftConflict: SessionDraftConflict(
              localText: staged,
              sharedText: preserved,
              kind: SessionDraftConflictKind.unsentPrompt,
            ),
          );
        }
        _localDraft = stored;
      } on _StaleDraftRow {
        // Bounded CAS retry happens on the next accepted row emission.
      }
      return;
    }

    _localDraft = observed;
    _stagedLocalDraftText = observed.text;
    if (observed.conflictText != null) {
      _restorePreservedDraftConflict(observed);
      return;
    }
    if (state.draftConflict != null) {
      state = state.copyWith(clearDraftConflict: true);
    }
    _surfaceDraft(observed.text, kind: SessionDraftSurfaceKind.replace);
  }

  /// Writes the row conditionally and installs the stored result in the cache.
  ///
  /// Returns the row AS STORED — its mutation version advanced — and every
  /// effect derived from the write must use that value, not the argument. A
  /// refused write reloads the cache and throws [_StaleDraftRow]: the row the
  /// caller reasoned from no longer exists, so nothing computed from it (a
  /// publish, a surface, a conflict dismissal, a handoff or receipt
  /// completion) may run.
  Future<SessionLocalDraft> _saveLocalDraft(
    SessionLocalDraft draft,
    _DraftScope scope,
  ) async {
    final stored = await scope.guard(_draftRepository.save(draft));
    if (stored == null) {
      await _reloadLocalDraft(scope);
      throw const _StaleDraftRow();
    }
    _localDraft = stored;
    _ownedDraftMutationVersions.add(stored.mutationVersion);
    while (_ownedDraftMutationVersions.length >
        _maxRememberedLocalMutationVersions) {
      _ownedDraftMutationVersions.remove(_ownedDraftMutationVersions.first);
    }
    return stored;
  }

  /// Re-reads the stored row into the cache after a write lost its race.
  Future<void> _reloadLocalDraft(_DraftScope scope) async {
    final profileId = _loadedDraftScopeKey;
    if (profileId == null) return;
    try {
      _localDraft = await scope.guard(
        _draftRepository.load(brokerProfileId: profileId, sessionKey: arg),
      );
    } on _StaleDraftScope {
      rethrow;
    } on Object {
      // The next trigger reloads; a stale cache is not worth failing a session.
    }
  }

  /// Durably deletes the row FIRST, then drops the cache and any conflict
  /// banner. The reverse order has a crash-shaped hole: memory and UI would
  /// claim the draft is gone while the row survives a failed delete.
  ///
  /// Conditional on the cached row's version like every other mutation — a
  /// delete decided against a stale premise must not destroy the newer row
  /// another tab just wrote. A refusal reloads and throws [_StaleDraftRow].
  Future<void> _deleteLocalDraft(_DraftScope scope) async {
    final profileId = _loadedDraftScopeKey;
    final row = _localDraft;
    if (profileId != null && row != null) {
      final deleted = await scope.guard(
        _draftRepository.delete(
          brokerProfileId: profileId,
          sessionKey: arg,
          expectedMutationVersion: row.mutationVersion,
        ),
      );
      if (!deleted) {
        await _reloadLocalDraft(scope);
        throw const _StaleDraftRow();
      }
      _ownedDraftDeletesAwaitingObservation++;
    }
    _localDraft = null;
    // A conflict banner is a projection of this row's preserved second version.
    // Once the row is gone there is nothing left to resolve, and leaving the
    // banner up is not cosmetic: "keep mine" needs a row and becomes a dead
    // button, while every publish path refuses to run under an unresolved
    // conflict — so a send made while the banner was up would silently stop
    // this device from ever relaying another draft.
    if (!_disposed && state.draftConflict != null) {
      state = state.copyWith(clearDraftConflict: true);
    }
  }

  void _surfaceDraft(String text, {required SessionDraftSurfaceKind kind}) {
    if (_disposed) return;
    _draftSurfaceToken++;
    if (text.isNotEmpty) {
      _nonEmptySurfaceTokens[_draftSurfaceToken] = _composerGeneration;
      while (_nonEmptySurfaceTokens.length >
          _maxRememberedLocalMutationVersions) {
        _nonEmptySurfaceTokens.remove(_nonEmptySurfaceTokens.keys.first);
      }
    }
    state = state.copyWith(
      draftSurface: SessionDraftSurface(
        text: text,
        token: _draftSurfaceToken,
        kind: kind,
      ),
    );
  }

  /// Persists one coalesced local edit (online or offline) and relays it when
  /// the session transport is connected. Returns whether a broker publish was
  /// attempted and accepted by the transport.
  Future<bool> recordLocalDraft(String text) async {
    final result = await _serializeDraftMutation(
      (scope) => _recordLocalDraftLocked(text, scope),
      whenStale: (
        persistence: SessionDraftPersistenceResult.failed,
        published: false,
      ),
    );
    return result.published;
  }

  Future<({SessionDraftPersistenceResult persistence, bool published})>
  _recordLocalDraftLocked(String text, _DraftScope scope) async {
    _stagedLocalDraftText = text;
    SessionLocalDraft? next;
    try {
      final profileId =
          _brokerScopeKey ??
          RosterSource.of(ref.read(activeBrokerProfileProvider))?.storageKey;
      if (profileId == null) {
        // There is no broker-bound value to lose when this controller has
        // never loaded a row and the composer is empty. This occurs on a cold
        // deep link before profile hydration; blocking Back cannot make an
        // empty, unowned value more durable.
        if (text.isEmpty && _localDraft == null) {
          return (
            persistence: SessionDraftPersistenceResult.alreadyPersisted,
            published: false,
          );
        }
        return (
          persistence: SessionDraftPersistenceResult.sourceUnavailable,
          published: false,
        );
      }
      await _ensureLocalDraftLoadedFor(profileId, scope);
      if (_loadedDraftScopeKey != profileId) {
        return (
          persistence: SessionDraftPersistenceResult.failed,
          published: false,
        );
      }
      if (_localDraft == null && text.isEmpty) {
        return (
          persistence: SessionDraftPersistenceResult.alreadyPersisted,
          published: false,
        );
      }
      if (text.length > maxLocalDraftTextChars) {
        // Neither durable copy accepts text this long (the broker shares the
        // same cap), and storing a prefix would present a malformed prompt as
        // the draft on the next open. The full value stays in composer memory,
        // the previously stored row survives as the last recoverable value,
        // and the composer surfaces the reduced durability itself.
        return (
          persistence: SessionDraftPersistenceResult.tooLarge,
          published: false,
        );
      }
      next = await _storeLocalEdit(profileId, text, scope);
      if (next == null) {
        return (
          persistence: SessionDraftPersistenceResult.failed,
          published: false,
        );
      }
    } on _StaleDraftScope {
      rethrow;
    } on Object {
      // A durability hiccup must never break typing or block the relay; the
      // next edit or lifecycle flush retries the local write.
      return (
        persistence: SessionDraftPersistenceResult.failed,
        published: false,
      );
    }
    if (!next.dirty) {
      return (
        persistence: SessionDraftPersistenceResult.alreadyPersisted,
        published: false,
      );
    }
    if (_disposed ||
        state.draftConflict != null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      return (
        persistence: SessionDraftPersistenceResult.persisted,
        published: false,
      );
    }
    return (
      persistence: SessionDraftPersistenceResult.persisted,
      published: await _publishLocalDraft(next),
    );
  }

  /// Stores one coalesced edit at most twice: once on this controller's own
  /// lineage, and once more after a refusal — carrying the concurrent
  /// writer's value forward instead of overwriting it.
  ///
  /// The first attempt builds on the cached row, which this controller last
  /// wrote or loaded, so the edit legitimately supersedes it. A refusal means
  /// the row now belongs to ANOTHER writer (a second tab, a maintenance
  /// restore). Winning the retry by rewriting the same edit would admit this
  /// tab's version by silently discarding theirs — the lost update the
  /// version column exists to prevent — so the retry preserves the foreign
  /// text as the row's second version and surfaces the choice. This tab's
  /// live typing owns the row itself: its next coalesced flush would
  /// otherwise refight the identical race on every keystroke.
  Future<SessionLocalDraft?> _storeLocalEdit(
    String profileId,
    String text,
    _DraftScope scope,
  ) async {
    SessionLocalDraft edited(SessionLocalDraft? base) =>
        (base ??
                SessionLocalDraft.create(
                  brokerProfileId: profileId,
                  sessionKey: arg,
                  text: text,
                ))
            .copyWith(
              text: text,
              localRevision: (base?.localRevision ?? 0) + 1,
              dirty: true,
              clearSubmitted: true,
              // A new local value retires any unfinished post-send clear:
              // publishing this text over the same base revision replaces
              // the sent text just as the clear would have.
              clearPendingClear: true,
              updatedAt: DateTime.now(),
            );
    final existing = _localDraft;
    // DR1b: an empty composer that has never held this session's content is an
    // UNHYDRATED one, not a user clearing a draft. Every ordinary lifecycle
    // flush — focus loss, app hidden, route disposal — would otherwise write
    // its emptiness over a durable row the user was never shown, and publish
    // that clear to every other device. A real clear still propagates: the
    // user must have had the text on screen to delete it, which is exactly
    // what sets the flag (typing, or an offered surface confirmed applied).
    if (text.isEmpty &&
        existing != null &&
        existing.text.isNotEmpty &&
        _composerHeldContentGeneration != _composerGeneration) {
      return existing;
    }
    if (existing != null &&
        existing.text == text &&
        existing.submittedClientMessageId == null) {
      // The value did not change. A repeated dirty value is already owned by
      // its in-flight publish or the reconnect retry, and an unchanged CLEAN
      // value must not be re-dirtied — otherwise every lifecycle flush (focus
      // loss, route change, app hidden, pagehide, pre-Send) would write
      // SQLite and republish text the shared copy already holds.
      return existing;
    }
    _lastLocalDraftEditAt = DateTime.now();
    try {
      final stored = await _saveLocalDraft(edited(existing), scope);
      _draftPublishRetries = 0; // a new value earns a fresh attempt budget
      return stored;
    } on _StaleDraftRow {
      // The cache was reloaded; the retry below derives from the row the
      // other writer actually left, not from a guess.
    }
    final reloaded = _localDraft;
    if (reloaded != null &&
        reloaded.text == text &&
        reloaded.submittedClientMessageId == null) {
      return reloaded; // both writers arrived at the same value
    }
    final foreignText = reloaded?.text;
    final preserve =
        foreignText != null && foreignText.isNotEmpty && foreignText != text;
    try {
      final stored = await _saveLocalDraft(
        preserve
            // No broker revision rides along: the preserved value is another
            // LOCAL writer's unsent text, so the conflict resolves like a
            // recovered unsent prompt (adopting it re-publishes it).
            ? edited(reloaded)
                  .copyWith(clearConflict: true)
                  .copyWith(conflictText: foreignText)
            : edited(reloaded),
        scope,
      );
      _draftPublishRetries = 0;
      if (preserve && !_disposed && state.draftConflict == null) {
        state = state.copyWith(
          draftConflict: SessionDraftConflict(
            localText: text,
            sharedText: foreignText,
            kind: SessionDraftConflictKind.unsentPrompt,
          ),
        );
      }
      return stored;
    } on _StaleDraftRow {
      // Two refusals: give up without publishing anything; the next edit or
      // lifecycle flush re-derives from whatever survives.
      _syncDraftConflictBannerToRow();
      return null;
    }
  }

  /// Immediate durable flush for lifecycle boundaries (focus loss, route or
  /// app backgrounding, pre-Send). Shares [recordLocalDraft]'s coalescing, so
  /// an unchanged value is a true no-op: no SQLite write, no relay.
  Future<SessionDraftPersistenceResult> flushLocalDraft(String text) async {
    final result = await _serializeDraftMutation(
      (scope) => _recordLocalDraftLocked(text, scope),
      whenStale: (
        persistence: SessionDraftPersistenceResult.failed,
        published: false,
      ),
    );
    return result.persistence;
  }

  /// Backwards-compatible draft relay: persists locally, then publishes when
  /// connected. Supersedes the old widget-memory-only relay.
  Future<bool> _sendDraftCoordinated(String text) => recordLocalDraft(text);

  /// Publishes the current dirty value. A reconnect retry, a debounced edit,
  /// and a conflict resolution all share this single path; the relay stays
  /// proportional to actual edits.
  ///
  /// Only ONE versioned publish is outstanding at a time. A value that arrives
  /// while one is in flight is not sent immediately — it would still carry the
  /// pre-echo base revision and be rejected as stale — it is published from
  /// [_settleDraftPublish] once the broker's answer has moved the base.
  Future<bool> _publishLocalDraft(SessionLocalDraft draft) async {
    final control = SessionControlView.fromSessionDetailState(state);
    if (state.compatibilityReadOnly || !control.canPrompt) {
      // Observing/reconnecting windows keep the row dirty and durable, but
      // shared-draft publication is a broker mutation. It resumes only after
      // an authoritative control frame grants prompt authority.
      return false;
    }
    if (_draftHandoffInFlight) {
      // A send is capturing this draft's ownership tokens. Publishing now would
      // move the shared record under a token the prompt cannot report, so the
      // broker would refuse to recognize the send's own draft. The freeze lifts
      // as soon as the binding settles, which republishes anything still dirty.
      return false;
    }
    final versioned = _brokerVersionedDraftSupport;
    if (versioned == null) {
      // The contract is still being negotiated. Publishing now would fall back
      // to the legacy unversioned relay and could overwrite a newer shared
      // draft; the hello frame republishes this row instead.
      return false;
    }
    final connection = _connection;
    if (connection == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      return false;
    }
    if (versioned) {
      if (_pendingDraftPublish != null) return false;
      final updateId = _nextClientMessageId();
      _pendingDraftPublish = _PendingDraftPublish(
        updateId: updateId,
        text: draft.text,
        localRevision: draft.localRevision,
        baseRevision: draft.baseBrokerRevision,
      );
      _rememberDraftPublishId(updateId);
      _armDraftPublishAckTimer();
      try {
        await connection.sendDraft(
          draft.text,
          updateId: updateId,
          baseRevision: draft.baseBrokerRevision,
        );
        return true;
      } on Object {
        // The frame never left; settle immediately so the row can retry rather
        // than wait out the acknowledgement timeout. This attempt still spends
        // retry budget — settling cancels the ack timer, which is otherwise
        // the only place the counter advances, and a transport that throws on
        // every send would republish the unchanged value in an unbounded
        // microtask loop that starves the event loop out of ever delivering
        // the disconnect that breaks it.
        _draftPublishRetries++;
        _settleDraftPublish(acknowledged: false);
        return false;
      }
    }
    if (_draftPublishInFlight) return false;
    _draftPublishInFlight = true;
    try {
      // Legacy broker: unversioned last-writer-wins relay, no acknowledgement
      // to wait for.
      await connection.sendDraft(draft.text);
      return true;
    } on Object {
      return false;
    } finally {
      _draftPublishInFlight = false;
    }
  }

  /// Records an update token as this device's own, so a late echo is still
  /// recognizable after its publish slot has been released.
  ///
  /// Releasing the slot (a send's outbox handoff, a disconnect, a settle) does
  /// not un-send the frame: the broker can still echo it. Without this memory
  /// that echo looks like another device's draft, and its superseded text would
  /// be adopted and surfaced back into the composer.
  void _rememberDraftPublishId(String updateId) {
    _recentDraftPublishIds.add(updateId);
    while (_recentDraftPublishIds.length > _maxRememberedDraftPublishIds) {
      _recentDraftPublishIds.remove(_recentDraftPublishIds.first);
    }
  }

  void _armDraftPublishAckTimer() {
    _draftPublishAckTimer?.cancel();
    _draftPublishAckTimer = Timer(_draftPublishAckTimeout, () {
      if (_disposed) return;
      _draftPublishRetries++;
      _settleDraftPublish(acknowledged: false);
    });
  }

  /// Ends the outstanding publish and issues the next one when the local row is
  /// still unsynchronized.
  ///
  /// A follow-up is only justified when something actually changed — the value
  /// moved on, or the broker's answer advanced our base so a previously stale
  /// write can now apply. An unchanged, unacknowledged value retries at most
  /// [_maxDraftPublishRetries] times, so this can never become a poll.
  void _settleDraftPublish({required bool acknowledged}) {
    _draftPublishAckTimer?.cancel();
    _draftPublishAckTimer = null;
    final pending = _pendingDraftPublish;
    _pendingDraftPublish = null;
    if (acknowledged) _draftPublishRetries = 0;
    if (_disposed || pending == null) return;
    final latest = _localDraft;
    if (latest == null || !latest.dirty) return;
    if (state.draftConflict != null) return;
    if (state.connectionStatus != SessionDetailConnectionStatus.connected) {
      return;
    }
    final changed =
        latest.localRevision != pending.localRevision ||
        latest.text != pending.text ||
        latest.baseBrokerRevision != pending.baseRevision;
    if (!changed && _draftPublishRetries > _maxDraftPublishRetries) return;
    unawaited(_publishLocalDraft(latest));
  }

  /// Drops any outstanding publish when the transport is no longer usable. The
  /// row stays dirty and the next connect retries it.
  void _abandonDraftPublish() {
    _draftPublishAckTimer?.cancel();
    _draftPublishAckTimer = null;
    _pendingDraftPublish = null;
    _draftPublishRetries = 0;
  }

  /// The hello frame settled the contract revision. A dirty row that deferred
  /// its publish while the capability was unknown goes out now, without another
  /// keystroke.
  void _onDraftContractNegotiated() {
    if (_disposed || _brokerVersionedDraftSupport == null) return;
    final row = _localDraft;
    if (row == null || !row.dirty) return;
    if (state.draftConflict != null) return;
    if (state.connectionStatus != SessionDetailConnectionStatus.connected) {
      return;
    }
    unawaited(_publishLocalDraft(row));
  }

  /// Publishes a staged row only after an authoritative control transition.
  void _onDraftMutationAuthorityGained() {
    if (_disposed || state.draftConflict != null) return;
    final row = _localDraft;
    if (row == null || !row.dirty) return;
    unawaited(_publishLocalDraft(row));
  }

  /// (Re)hydration + reconnect retry. Runs on every connected transition:
  /// loads this profile's durable row, reconciles any outbox-submitted
  /// handoff, surfaces the local value once, re-exposes any preserved second
  /// version, and republishes one dirty value WITHOUT requiring another edit.
  Future<void> _restoreLocalDraftForConnection() => _serializeDraftMutation(
    _restoreLocalDraftForConnectionLocked,
    whenStale: null,
  );

  Future<void> _restoreLocalDraftForConnectionLocked(_DraftScope scope) async {
    final profileId = _brokerScopeKey;
    if (profileId == null) return;
    try {
      await _ensureLocalDraftLoadedFor(profileId, scope);
      if (_loadedDraftScopeKey != profileId) return;
      await _withDraftRowRetry<void>(() async {
        var row = _localDraft;
        if (row != null && row.submittedClientMessageId != null) {
          row = await _reconcileSubmittedDraft(row, scope);
        }
        // A row still bound to a live send holds text this device ALREADY
        // sent. Surfacing it would put the sent prompt back in the composer as
        // unsent text — visible whenever the session is reopened inside the
        // receipt round trip, and for the whole retry window when the ack is
        // lost. The terminal-failure branch above does its own restore
        // surface, and the delivered branch returns null, so only the
        // still-in-flight row is skipped here.
        if (row != null &&
            row.text.isNotEmpty &&
            row.submittedClientMessageId == null &&
            !_draftHydrated) {
          _draftHydrated = true;
          // `replace` is only safe while nothing else can be in the composer.
          // Once a composer has announced itself this attach, the user may have
          // typed since — and `replace` only protects text that is FOCUSED and
          // under 1.5 s old, so a blurred draft would be overwritten by this
          // older row. A composer that exists gets the weakest claim instead.
          _surfaceDraft(
            row.text,
            kind: _composerAnnouncedThisAttach
                ? SessionDraftSurfaceKind.restoreIfEmpty
                : SessionDraftSurfaceKind.replace,
          );
        }
        if (row != null) _restorePreservedDraftConflict(row);
        if (row != null &&
            row.dirty &&
            state.draftConflict == null &&
            state.connectionStatus == SessionDetailConnectionStatus.connected) {
          await _publishLocalDraft(row);
        }
      }, whenRefused: null);
      await _offerFailedOversizedPrompt(profileId, scope);
    } on _StaleDraftScope {
      rethrow;
    } on Object {
      // Hydration is recovery, never a blocker for the live session.
    }
  }

  /// Offers back a terminally failed prompt whose text the durable draft row
  /// cannot hold, straight from its failed outbox row.
  ///
  /// A normal-sized failed prompt is restored INTO the draft row — by the
  /// live nack handler, the maintenance expiry, or the reopen reconcile. An
  /// oversized one is refused there, so after a crash (or an expiry that ran
  /// with no live controller) its only copy is a failed outbox row that no
  /// other UI reads — and a row nothing reads is not a recovery. The offer
  /// exposes it through the ordinary conflict choice; resolving the offer
  /// removes the row (DR1 retention: resolved failed rows are deleted).
  Future<void> _offerFailedOversizedPrompt(
    String profileId,
    _DraftScope scope,
  ) async {
    if (_disposed || state.draftConflict != null) return;
    final repository = ref.read(sessionOutboxRepositoryProvider);
    final messages = await scope.guard(
      repository.loadForSession(arg, brokerProfileId: profileId),
    );
    SessionOutboxMessage? newest;
    String? newestText;
    for (final message in messages) {
      if (message.kind != SessionOutboxMessageKind.prompt) continue;
      if (message.status != SessionOutboxMessageStatus.failed) continue;
      final text = message.payload['text'];
      if (text is! String || text.length <= maxLocalDraftTextChars) continue;
      newest = message; // loadForSession answers oldest first
      newestText = text;
    }
    if (newest == null || newestText == null) return;
    if (state.draftConflict != null) return;
    state = state.copyWith(
      draftConflict: SessionDraftConflict(
        localText: _localDraft?.text ?? '',
        sharedText: newestText,
        kind: SessionDraftConflictKind.unsentPrompt,
        recoveredPromptId: newest.clientMessageId,
      ),
    );
  }

  /// Re-exposes a second draft version that was preserved on the durable row.
  ///
  /// Both an unresolved shared divergence and a terminally failed prompt kept
  /// beside newer text live in `conflictText`. Without this, that text exists
  /// only in SQLite: the user is never offered it and cannot recover it. A
  /// preserved shared draft carries `conflictBrokerRevision`; a failed prompt
  /// has none, and resolves purely locally.
  void _restorePreservedDraftConflict(SessionLocalDraft row) {
    final preserved = row.conflictText;
    if (preserved == null || state.draftConflict != null) return;
    state = state.copyWith(draftConflict: _projectDraftConflict(row));
  }

  /// Resolves a draft row still associated with an outbox send across an app
  /// restart: delivered/pruned rows clear the draft, failed rows restore it,
  /// and still-live rows keep waiting for their receipt.
  Future<SessionLocalDraft?> _reconcileSubmittedDraft(
    SessionLocalDraft row,
    _DraftScope scope,
  ) async {
    final submittedId = row.submittedClientMessageId;
    if (submittedId == null) return row;
    try {
      final repository = ref.read(sessionOutboxRepositoryProvider);
      final messages = await scope.guard(
        repository.loadForSession(arg, brokerProfileId: row.brokerProfileId),
      );
      SessionOutboxMessage? outbox;
      for (final message in messages) {
        if (message.clientMessageId == submittedId) {
          outbox = message;
          break;
        }
      }
      if (outbox == null ||
          outbox.status == SessionOutboxMessageStatus.delivered) {
        // Delivered (and possibly pruned since): the handoff completed.
        await _deleteLocalDraft(scope);
        return null;
      }
      if (outbox.status == SessionOutboxMessageStatus.failed) {
        final restored = await _saveLocalDraft(
          row.copyWith(
            dirty: true,
            localRevision: row.localRevision + 1,
            clearSubmitted: true,
            updatedAt: DateTime.now(),
          ),
          scope,
        );
        _draftHydrated = true; // the restore surface is this attach's hydration
        _surfaceDraft(
          restored.text,
          kind: SessionDraftSurfaceKind.restoreIfEmpty,
        );
        return restored;
      }
      return row; // still queued/sending/retryable: the receipt will settle it
    } on _StaleDraftScope {
      rethrow;
    } on _StaleDraftRow {
      rethrow; // the caller's bounded retry re-derives from the reloaded row
    } on Object {
      return row; // unknown is safe: the row keeps its association
    }
  }

  /// Handles one versioned broker draft frame (broadcast, late-joiner replay,
  /// clear-tombstone replay, or the unicast answer to a stale-base/duplicate
  /// write).
  Future<void> _handleSharedDraftEvent(DraftWireEvent event) =>
      _serializeDraftMutation(
        (scope) => _handleSharedDraftEventLocked(event, scope),
        whenStale: null,
      );

  Future<void> _handleSharedDraftEventLocked(
    DraftWireEvent event,
    _DraftScope scope,
  ) async {
    final revision = event.revision;
    if (revision == null) return; // legacy frames stay on the page's LWW path
    final profileId = _brokerScopeKey;
    if (profileId == null) return;
    try {
      // The frame belongs to the socket that delivered it; a profile switch
      // during ANY await below means that socket is gone and nothing it said
      // may touch the new profile's row, composer, or conflict state — which
      // is exactly what the scope guards enforce.
      await _ensureLocalDraftLoadedFor(profileId, scope);
      if (_loadedDraftScopeKey != profileId) return;
      await _withDraftRowRetry<void>(
        () => _applySharedDraftEvent(event, revision, profileId, scope),
        whenRefused: null,
      );
    } on _StaleDraftScope {
      rethrow;
    } on Object {
      // Reconciliation must never break the live event stream.
    }
  }

  Future<void> _applySharedDraftEvent(
    DraftWireEvent event,
    int revision,
    String profileId,
    _DraftScope scope,
  ) async {
    var row = _localDraft;

    // Own echo: the broker accepted (or idempotently replayed) our update.
    // This — not the socket write — is what marks the shared copy converged.
    // Edits typed while the publish was in flight keep the row dirty, and
    // settling here issues their publish against the NEW base revision.
    final pending = _pendingDraftPublish;
    if (pending != null &&
        event.updateId != null &&
        event.updateId == pending.updateId) {
      if (event.text.isEmpty && (row == null || row.text.isEmpty)) {
        // the clear revision was acknowledged
        await _deleteLocalDraft(scope);
      } else if (row != null && row.text == event.text) {
        await _saveLocalDraft(
          row.copyWith(
            dirty: false,
            baseBrokerRevision: revision,
            clearConflict: true,
            updatedAt: DateTime.now(),
          ),
          scope,
        );
      } else if (row != null && revision > row.baseBrokerRevision) {
        // Superseded by a newer local edit: adopt the accepted revision so
        // the follow-up publish is no longer based on a stale one.
        await _saveLocalDraft(
          row.copyWith(
            baseBrokerRevision: revision,
            updatedAt: DateTime.now(),
          ),
          scope,
        );
      }
      _settleDraftPublish(acknowledged: true);
      return;
    }

    // A late echo of one of THIS device's own publishes whose slot was
    // already released — a send's outbox handoff, a disconnect, or a settle
    // frees the slot without un-sending the frame. Its text is by definition
    // superseded (that is why the slot moved on), so it must never be adopted
    // or surfaced: doing so re-inserts an older value the user has already
    // replaced. Only the revision is taken, so later writes are not based on
    // a stale one.
    if (event.updateId != null &&
        _recentDraftPublishIds.contains(event.updateId)) {
      if (row != null &&
          revision > row.baseBrokerRevision &&
          row.text != event.text) {
        await _saveLocalDraft(
          row.copyWith(
            baseBrokerRevision: revision,
            // A pending clear targets the record holding THIS device's sent
            // text. Its own late echo moves that record forward without
            // making it another device's, so the target follows.
            pendingClearRevision: row.isPendingClear ? revision : null,
            updatedAt: DateTime.now(),
          ),
          scope,
        );
        _republishAfterBaseAdvance();
      }
      return;
    }

    // A post-send clear whose target record is gone: this frame is another
    // device's write, and it landed after the clear this device's prompt
    // could not durably complete. The sent text is therefore no longer what
    // the shared copy holds, so there is nothing left to clear. Retrying the
    // empty write here would erase the newer draft, and presenting '' against
    // it as a conflict would ask the user to arbitrate a decision they never
    // made. The clear retires and the row rejoins the ordinary adoption path.
    final pendingClearTarget = row?.pendingClearRevision;
    if (pendingClearTarget != null && revision > pendingClearTarget) {
      await _deleteLocalDraft(scope);
      // The rejected clear may still hold the publish slot: this frame is the
      // stale-base answer to it, which carries another writer's updateId and
      // so never settles it.
      _abandonDraftPublish();
      row = null;
    }

    if (row == null || !row.dirty) {
      // Clean (or outbox-submitted) rows adopt a newer shared revision.
      if (row != null && revision <= row.baseBrokerRevision) return;
      if (event.text.isEmpty) {
        // A clear tombstone. A clean row MUST adopt it, otherwise a device
        // that was offline across another client's clear/send keeps showing a
        // draft the session no longer has.
        await _deleteLocalDraft(scope);
        _surfaceDraft('', kind: SessionDraftSurfaceKind.replace);
      } else {
        // A row awaiting its send receipt keeps that association when the
        // frame is its OWN text coming back: the draft this device published
        // just before pressing Send is echoed after the outbox handoff, and
        // dropping the id there would strand the row — delivery could no
        // longer clear it and a terminal failure could no longer restore it,
        // so the already-sent prompt would rehydrate into the composer. A
        // frame carrying DIFFERENT text is genuinely another device's draft,
        // which supersedes the handoff (the outbox row still owns the
        // prompt).
        final ownSubmittedEcho =
            row?.submittedClientMessageId != null && row?.text == event.text;
        final adopted =
            (row ??
                    SessionLocalDraft.create(
                      brokerProfileId: profileId,
                      sessionKey: arg,
                      text: event.text,
                    ))
                .copyWith(
                  text: event.text,
                  localRevision: (row?.localRevision ?? 0) + 1,
                  dirty: false,
                  baseBrokerRevision: revision,
                  clearSubmitted: !ownSubmittedEcho,
                  clearConflict: true,
                  updatedAt: DateTime.now(),
                );
        await _saveLocalDraft(adopted, scope);
        _surfaceDraft(event.text, kind: SessionDraftSurfaceKind.replace);
      }
      if (state.draftConflict != null) {
        state = state.copyWith(clearDraftConflict: true);
      }
      return;
    }

    // Dirty local value: a stale shared revision NEVER overwrites it.
    if (revision <= row.baseBrokerRevision) return;
    if (event.text.isEmpty) {
      if (row.text.isEmpty) {
        await _deleteLocalDraft(scope); // both sides converged on cleared
      } else {
        // The shared draft was cleared (a client sent it). Our newer unsent
        // text is kept; adopting the clear's revision lets the pending
        // publish apply without a stale-base rejection.
        await _saveLocalDraft(
          row.copyWith(
            baseBrokerRevision: revision,
            updatedAt: DateTime.now(),
          ),
          scope,
        );
        _republishAfterBaseAdvance();
      }
      return;
    }
    if (event.text == row.text) {
      // Exact convergence only. Near-equal text is never deduplicated.
      await _saveLocalDraft(
        row.copyWith(
          dirty: false,
          baseBrokerRevision: revision,
          clearConflict: true,
          updatedAt: DateTime.now(),
        ),
        scope,
      );
      if (state.draftConflict != null) {
        state = state.copyWith(clearDraftConflict: true);
      }
      return;
    }
    final lastEdit = _lastLocalDraftEditAt;
    final recentlyEdited =
        lastEdit != null &&
        DateTime.now().difference(lastEdit) <
            const Duration(milliseconds: 1500);
    if (recentlyEdited) {
      // Live two-client typing race (existing 1.5s guard semantics): local
      // wins. Adopting the revision alone is not enough — without a publish
      // on the new base the shared copy keeps this device's text forever.
      await _saveLocalDraft(
        row.copyWith(baseBrokerRevision: revision, updatedAt: DateTime.now()),
        scope,
      );
      _republishAfterBaseAdvance();
      return;
    }
    // Both sides changed independently while apart: preserve BOTH versions
    // and ask. Nothing is chosen by wall clock or text similarity.
    await _saveLocalDraft(
      row.copyWith(
        conflictText: event.text,
        conflictBrokerRevision: revision,
        updatedAt: DateTime.now(),
      ),
      scope,
    );
    _abandonDraftPublish(); // the user's choice owns the next publish
    state = state.copyWith(
      draftConflict: SessionDraftConflict(
        localText: row.text,
        sharedText: event.text,
        sharedRevision: revision,
      ),
    );
  }

  /// The shared revision moved forward under a still-dirty row, so the local
  /// value must be republished on the new base.
  ///
  /// Call this AFTER the adopted revision is saved. When a publish is
  /// outstanding, a foreign frame carrying a revision past that publish's base
  /// proves it will never be acknowledged: frames are ordered per socket, so
  /// our own echo would have arrived first if the broker had accepted it. It
  /// was rejected as stale-base, and waiting out the acknowledgement timeout
  /// would leave the shared copy an edit behind for no reason.
  void _republishAfterBaseAdvance() {
    final pending = _pendingDraftPublish;
    if (pending != null) {
      final latest = _localDraft;
      if (latest != null && latest.baseBrokerRevision > pending.baseRevision) {
        // Settling issues the follow-up on the advanced base.
        _settleDraftPublish(acknowledged: false);
      }
      return;
    }
    final latest = _localDraft;
    if (latest == null || !latest.dirty) return;
    if (state.draftConflict != null) return;
    if (state.connectionStatus != SessionDetailConnectionStatus.connected) {
      return;
    }
    unawaited(_publishLocalDraft(latest));
  }

  /// Resolution: keep this device's draft.
  ///
  /// For a shared divergence this publishes over the preserved shared revision
  /// (the broker accepts a write based on the current one). The preserved text
  /// stays DURABLE until that publish is acknowledged — clearing it on the
  /// socket write would lose the other version if the app died in between. For
  /// a recovered unsent prompt there is nothing to publish: the choice is to
  /// discard the recovered text, which resolves locally.
  Future<void> resolveDraftConflictKeepLocal() => _serializeDraftMutation(
    _resolveDraftConflictKeepLocalLocked,
    whenStale: null,
  );

  Future<void> _resolveDraftConflictKeepLocalLocked(_DraftScope scope) async {
    try {
      await _withDraftRowRetry<void>(() async {
        final conflict = state.draftConflict;
        if (conflict == null) return;
        final recovered = conflict.recoveredPromptId;
        if (recovered != null) {
          // Keeping the current text discards the recovered failed prompt:
          // its resolved outbox row is removed so the offer does not return
          // on the next reopen (DR1 retention).
          await scope.guard(
            ref.read(sessionOutboxRepositoryProvider).remove(recovered),
          );
          if (!_disposed) {
            state = state.copyWith(clearDraftConflict: true);
          }
          return;
        }
        final row = _localDraft;
        if (row == null) return;
        if (conflict.kind == SessionDraftConflictKind.unsentPrompt) {
          await _saveLocalDraft(
            row.copyWith(
              text: conflict.localText,
              localRevision: row.localRevision + 1,
              dirty: true,
              clearSubmitted: true,
              clearPendingClear: true,
              clearConflict: true,
              updatedAt: DateTime.now(),
            ),
            scope,
          );
          _stagedLocalDraftText = conflict.localText;
          state = state.copyWith(clearDraftConflict: true);
          return;
        }
        final stored = await _saveLocalDraft(
          row.copyWith(
            text: conflict.localText,
            localRevision: row.localRevision + 1,
            baseBrokerRevision:
                conflict.sharedRevision ?? row.baseBrokerRevision,
            dirty: true,
            updatedAt: DateTime.now(),
          ),
          scope,
        );
        _stagedLocalDraftText = conflict.localText;
        state = state.copyWith(clearDraftConflict: true);
        _draftPublishRetries = 0;
        await _publishLocalDraft(stored);
      }, whenRefused: null);
    } on _StaleDraftScope {
      rethrow;
    } on Object {
      // The preserved conflict stays durable for the next attempt.
    }
  }

  /// Resolution: adopt the other version. The local value is replaced only by
  /// this explicit choice.
  ///
  /// A shared draft is adopted at its revision (already synchronized, so the
  /// row is clean). A recovered unsent prompt has no revision: it becomes the
  /// composer's dirty local text and publishes like any other edit.
  Future<void> resolveDraftConflictUseShared() => _serializeDraftMutation(
    _resolveDraftConflictUseSharedLocked,
    whenStale: null,
  );

  Future<void> _resolveDraftConflictUseSharedLocked(_DraftScope scope) async {
    try {
      await _withDraftRowRetry<void>(() async {
        final conflict = state.draftConflict;
        if (conflict == null) return;
        final recovered = conflict.recoveredPromptId;
        if (recovered != null) {
          // The recovered prompt is over the durable row's size cap, so its
          // adoption is in-memory: the composer takes the full text (the
          // too-long status explains the reduced durability). The surface is
          // a FORCED replace: the guard that protects a composer from remote
          // content must not reject the user's own explicit choice. The
          // resolved outbox row — the only durable copy — is NOT removed
          // here: the page applies surfaces in a post-frame callback, so a
          // deletion now would race an unmount or crash into destroying the
          // text before the composer ever showed it. Removal waits for the
          // page to confirm this exact surface token landed
          // ([confirmDraftSurfaceApplied]); until then every reopen simply
          // offers the row again.
          _surfaceDraft(
            conflict.sharedText,
            kind: SessionDraftSurfaceKind.forceReplace,
          );
          _pendingRecoveredPromptRemoval = (
            token: _draftSurfaceToken,
            clientMessageId: recovered,
          );
          if (!_disposed) {
            state = state.copyWith(clearDraftConflict: true);
          }
          return;
        }
        final row = _localDraft;
        final profileId = _loadedDraftScopeKey;
        if (profileId == null) return;
        final unsentPrompt =
            conflict.kind == SessionDraftConflictKind.unsentPrompt;
        final stored = await _saveLocalDraft(
          (row ??
                  SessionLocalDraft.create(
                    brokerProfileId: profileId,
                    sessionKey: arg,
                    text: conflict.sharedText,
                  ))
              .copyWith(
                text: conflict.sharedText,
                localRevision: (row?.localRevision ?? 0) + 1,
                dirty: unsentPrompt,
                baseBrokerRevision:
                    conflict.sharedRevision ?? row?.baseBrokerRevision,
                clearSubmitted: true,
                // Chosen text replaces whatever the row held, including an
                // unfinished post-send clear.
                clearPendingClear: true,
                clearConflict: true,
                updatedAt: DateTime.now(),
              ),
          scope,
        );
        _stagedLocalDraftText = conflict.sharedText;
        state = state.copyWith(clearDraftConflict: true);
        // Forced for the same reason as the recovered branch: an explicit
        // resolution is the user acting, not remote content racing them. Here
        // the durable row already holds the chosen text, so a rejected
        // surface would not lose data — it would leave the composer silently
        // contradicting the choice the user just made.
        _surfaceDraft(
          conflict.sharedText,
          kind: SessionDraftSurfaceKind.forceReplace,
        );
        if (unsentPrompt) {
          _draftPublishRetries = 0;
          await _publishLocalDraft(stored);
        }
      }, whenRefused: null);
    } on _StaleDraftScope {
      rethrow;
    } on Object {
      // The preserved conflict stays durable for the next attempt.
    }
  }

  /// Page acknowledgement that surface [token] actually reached the composer
  /// (it was applied, or already matched the composer's content).
  ///
  /// Completes a recovered-prompt restoration waiting on that exact token:
  /// the failed outbox row — the only durable copy of an oversized prompt —
  /// is removed once its text demonstrably reached the composer, never merely
  /// once it was scheduled to. A surface that never confirms (guard
  /// rejection, unmount, crash before the post-frame apply) leaves the row in
  /// place, and the next reopen offers it again. Tokens are unique per
  /// emission, so a confirmation can never complete a removal it does not
  /// belong to.
  Future<void> confirmDraftSurfaceApplied(int token) {
    // DR1b: this is the ONE report that the composer demonstrably holds this
    // session's durable content, which is what gives a later empty flush the
    // authority to clear it. Only a NON-EMPTY surface says that. The page also
    // confirms empty ones — empty already matches an empty composer — and
    // reading that as "holds the content" let a composer holding nothing
    // authorise erasing whatever arrived next from another tab. Typing grants
    // the authority through its own path, so nothing legitimate is lost.
    if (_nonEmptySurfaceTokens[token] == _composerGeneration) {
      _composerHeldContentGeneration = _composerGeneration;
    }
    final pending = _pendingRecoveredPromptRemoval;
    if (pending == null || pending.token != token) {
      return Future<void>.value();
    }
    return _serializeDraftMutation((scope) async {
      final current = _pendingRecoveredPromptRemoval;
      if (current == null || current.token != token) return;
      _pendingRecoveredPromptRemoval = null;
      try {
        await scope.guard(
          ref
              .read(sessionOutboxRepositoryProvider)
              .remove(current.clientMessageId),
        );
      } on _StaleDraftScope {
        rethrow;
      } on Object {
        // The row outliving a failed removal is the safe direction: the next
        // reopen offers it again.
      }
    }, whenStale: null);
  }

  /// Legacy-broker mirror: the page applied a remote draft with its
  /// last-writer-wins guard, so the durable row converges to the same value.
  Future<void> adoptLegacySharedDraft(String text) => _serializeDraftMutation(
    (scope) => _adoptLegacySharedDraftLocked(text, scope),
    whenStale: null,
  );

  Future<void> _adoptLegacySharedDraftLocked(
    String text,
    _DraftScope scope,
  ) async {
    if (_brokerVersionedDraftSupport ?? true) return;
    if (text.length > maxLocalDraftTextChars) return;
    final profileId = _brokerScopeKey;
    if (profileId == null) return;
    try {
      await _ensureLocalDraftLoadedFor(profileId, scope);
      if (_loadedDraftScopeKey != profileId) return;
      await _withDraftRowRetry<void>(() async {
        if (text.isEmpty) {
          await _deleteLocalDraft(scope);
          return;
        }
        final row = _localDraft;
        await _saveLocalDraft(
          (row ??
                  SessionLocalDraft.create(
                    brokerProfileId: profileId,
                    sessionKey: arg,
                    text: text,
                  ))
              .copyWith(
                text: text,
                localRevision: (row?.localRevision ?? 0) + 1,
                dirty: false,
                clearSubmitted: true,
                clearPendingClear: true,
                clearConflict: true,
                updatedAt: DateTime.now(),
              ),
          scope,
        );
      }, whenRefused: null);
    } on _StaleDraftScope {
      rethrow;
    } on Object {
      // Mirror-only; the page already converged its composer.
    }
  }

  /// The shared revision this device has adopted, sent with every prompt so the
  /// broker clears only the draft this send actually contained.
  ///
  /// A prompt from this device must never erase a newer shared draft another
  /// device typed in the meantime. 0 means "this device holds no shared draft",
  /// which the broker treats as "there is nothing of mine to clear".
  int get _observedSharedDraftRevision => _localDraft?.baseBrokerRevision ?? 0;

  /// Token of a draft write this device has sent but not seen acknowledged.
  ///
  /// Sent with the prompt so the broker can still recognize the shared draft as
  /// this device's own. Pressing Send during the ~300 ms debounce window is the
  /// common case, not an exotic one: the draft frame goes out, the prompt
  /// follows on the same socket, and the broker applies the draft first — so
  /// the revision the prompt reports is already one behind by the time it is
  /// read, even though the draft it advanced to is this very prompt's text.
  String? get _unacknowledgedDraftUpdateId => _pendingDraftPublish?.updateId;

  /// Opens a send handoff: captures the draft identity and ownership tokens the
  /// prompt will carry, and freezes draft publishing until [_endDraftHandoff].
  ///
  /// One synchronous snapshot, because every field has to describe the same
  /// instant. The revision alone is stale whenever a publish is outstanding;
  /// the token alone cannot name the record when none is.
  ///
  /// The freeze closes the window between this capture and the durable binding
  /// (one outbox write). Without it a foreign draft frame arriving in that
  /// window could settle the in-flight publish and issue a NEW one, leaving
  /// the shared record under an `updateId` the prompt never reported — so the
  /// broker would not recognize the draft as this sender's, and the text this
  /// prompt just sent would survive as everyone's shared draft.
  _DraftHandoff _beginDraftHandoff() {
    _draftHandoffInFlight = true;
    final row = _localDraft;
    // Reported whatever the negotiated capability is, including while it is
    // still unknown. A broker that predates the field ignores it and keeps its
    // unconditional clear exactly as before, so there is nothing to gain by
    // withholding it — whereas treating "unknown" as legacy and omitting it
    // would ask a revision-3 broker for an unconditional clear, erasing a
    // newer draft another device typed. Publishing resolves the same tri-state
    // by waiting; a send cannot wait, so it reports instead.
    return _DraftHandoff(
      text: row?.text,
      localRevision: row?.localRevision,
      revision: _observedSharedDraftRevision,
      updateId: _unacknowledgedDraftUpdateId,
    );
  }

  /// Releases the publish freeze once the handoff has settled either way.
  void _endDraftHandoff() {
    if (!_draftHandoffInFlight) return;
    _draftHandoffInFlight = false;
    // A value that changed (or failed to bind) during the freeze still owes the
    // shared copy a publish; nothing else will trigger it.
    final row = _localDraft;
    if (row != null && row.dirty) _republishAfterBaseAdvance();
  }

  /// Binds the exact draft being sent to its outbox row, BEFORE the prompt is
  /// dispatched. Returns false only when the binding could not be made
  /// durable, which means the caller must not dispatch.
  ///
  /// Ordering is the whole point. Binding after dispatch associates whatever
  /// row happens to be current when the awaits finish, and a foreign draft
  /// frame can replace it in that window: the prompt's own acknowledgement
  /// would then delete ANOTHER device's newer unsent text. The row is checked
  /// against
  /// the identity captured at send time — text and local revision — and a row
  /// that moved is left alone rather than bound. Our own echo does not move
  /// either field, so a normal in-flight publish still binds.
  ///
  /// [expectedLocalRevision] is null on replay, where the pre-crash revision is
  /// not knowable; the text match is what remains verifiable there.
  ///
  /// Synchronous through the identity check and the publish freeze, so nothing
  /// can interleave between the caller's token capture and this decision.
  Future<bool> _bindSubmittedDraft(
    String clientMessageId, {
    required String? expectedText,
    int? expectedLocalRevision,
  }) {
    return _serializeDraftMutation(
      (scope) => _bindSubmittedDraftLocked(
        clientMessageId,
        expectedText: expectedText,
        expectedLocalRevision: expectedLocalRevision,
        scope: scope,
      ),
      // A send whose profile is gone must not dispatch either.
      whenStale: false,
    );
  }

  Future<bool> _bindSubmittedDraftLocked(
    String clientMessageId, {
    required String? expectedText,
    required _DraftScope scope,
    int? expectedLocalRevision,
  }) {
    // A refused binding write re-checks identity against the row the other
    // writer left; a second refusal returns false — the prompt must not
    // dispatch on the strength of a binding that never became durable.
    return _withDraftRowRetry<bool>(() async {
      // Loading belongs INSIDE the serialized operation. A load started
      // outside it resolves whenever the database gets to it, so it can land
      // after a newer serialized write and reinstall the row that write
      // replaced.
      final profileId = _brokerScopeKey;
      if (profileId != null) {
        await _ensureLocalDraftLoadedFor(profileId, scope);
      }
      final row = _localDraft;
      // Nothing to bind, and dispatch stays correct in every one of these
      // cases: there is no local draft; the row is already bound (the replay
      // case) or owned by another in-flight send; or the row is no longer the
      // draft this prompt carried. The prompt still reports the revision it
      // observed, so the broker's conditional clear simply skips a record that
      // has moved on.
      if (row == null ||
          row.submittedClientMessageId != null ||
          expectedText == null ||
          row.text != expectedText ||
          (expectedLocalRevision != null &&
              row.localRevision != expectedLocalRevision)) {
        return true;
      }
      _abandonDraftPublish();
      try {
        await _saveLocalDraft(
          row.copyWith(
            dirty: false,
            submittedClientMessageId: clientMessageId,
            updatedAt: DateTime.now(),
          ),
          scope,
        );
        return true;
      } on _StaleDraftScope {
        rethrow;
      } on _StaleDraftRow {
        rethrow; // the bounded retry above re-derives the decision
      } on Object {
        // The prompt must not go out: an unbound row cannot be cleared on
        // delivery or restored on terminal failure, so the sent text would
        // either linger as everyone's shared draft or rehydrate into this
        // composer.
        return false;
      }
    }, whenRefused: false);
  }

  /// Broker ack for a delivered prompt. Returns whether the local half of the
  /// handoff is durable, so the caller knows if the outbox row may be marked
  /// delivered.
  ///
  /// The handoff is only complete when BOTH halves landed: the prompt reached
  /// the agent and the shared draft was durably cleared. [draftCleared] is the
  /// broker's answer for the second half. When it is false the prompt still
  /// succeeded, but the shared copy still holds the sent text — deleting the
  /// local row there would leave that text to be replayed as an unsent draft by
  /// a broker restart or any other client. The row becomes a *conditional*
  /// pending clear instead, which the ordinary acknowledgement-driven publisher
  /// retries until the broker confirms the tombstone.
  ///
  /// [draftRevision] is the shared revision the failed clear left standing, and
  /// it is what makes the retry conditional: the empty write only applies while
  /// the shared record is still the one this prompt sent. This device cannot
  /// derive that revision — its own pre-send draft write may have moved the
  /// record past the revision the prompt reported — so the broker names it.
  ///
  /// Returning false is the crash-window guard: the caller must NOT mark the
  /// prompt delivered when the pending clear could not be written, because a
  /// delivered outbox row plus a still-submitted draft row reconciles on reopen
  /// by deleting the draft, which would drop the retry the failure created.
  Future<bool> _handleDraftAfterDelivered(
    String clientMessageId, {
    bool draftCleared = true,
    int? draftRevision,
  }) {
    return _serializeDraftMutation(
      (scope) => _handleDraftAfterDeliveredLocked(
        clientMessageId,
        draftCleared: draftCleared,
        draftRevision: draftRevision,
        scope: scope,
      ),
      // A scope that died mid-receipt gets the same answer as a refused
      // write: the draft transition was never persisted, so the prompt must
      // NOT be marked delivered — a delivered row beside a still-submitted
      // draft reconciles on reopen by deleting the draft, dropping the retry
      // a failed clear created. The broker's idempotent replay produces this
      // receipt again for whoever attaches next.
      whenStale: false,
    );
  }

  Future<bool> _handleDraftAfterDeliveredLocked(
    String clientMessageId, {
    required _DraftScope scope,
    bool draftCleared = true,
    int? draftRevision,
  }) {
    // A refusal means another tab transitioned the row first. The retry
    // re-checks the association: if it is gone the other tab owns the handoff
    // and marking delivered is correct; if it persists and the write still
    // cannot land, false keeps the outbox row live so the broker's idempotent
    // replay produces this receipt again.
    return _withDraftRowRetry<bool>(() async {
      final row = _localDraft;
      if (row == null || row.submittedClientMessageId != clientMessageId) {
        return true;
      }
      if (draftCleared) {
        try {
          await _deleteLocalDraft(scope);
        } on _StaleDraftScope {
          rethrow;
        } on _StaleDraftRow {
          rethrow; // the bounded retry above re-checks the association
        } on Object {
          // Safe to leave: the row is still associated with a delivered send,
          // so reopening reconciles it away. The prompt itself is complete.
        }
        return true;
      }
      final target = draftRevision ?? row.baseBrokerRevision;
      final SessionLocalDraft stored;
      try {
        stored = await _saveLocalDraft(
          row.copyWith(
            text: '',
            localRevision: row.localRevision + 1,
            baseBrokerRevision: target,
            pendingClearRevision: target,
            dirty: true,
            clearSubmitted: true,
            updatedAt: DateTime.now(),
          ),
          scope,
        );
      } on _StaleDraftScope {
        rethrow;
      } on _StaleDraftRow {
        rethrow;
      } on Object {
        return false;
      }
      _draftPublishRetries = 0;
      // Guarded like every other await: the transition above is durable, so
      // when the scope dies while this frame is in flight the receipt is
      // simply not consumed — the broker's idempotent replay re-produces it,
      // and by then the row's cleared association answers it with true.
      await scope.guard(_publishLocalDraft(stored));
      return true;
    }, whenRefused: false);
  }

  /// Terminal delivery failure: restore the exact prompt text into the draft
  /// and offer it back to the composer (never loses the unsent text).
  Future<void> _restoreDraftForFailedSend(String clientMessageId) =>
      _serializeDraftMutation(
        (scope) => _restoreDraftForFailedSendLocked(clientMessageId, scope),
        whenStale: null,
      );

  Future<void> _restoreDraftForFailedSendLocked(
    String clientMessageId,
    _DraftScope scope,
  ) async {
    final profileId = _brokerScopeKey;
    if (profileId == null) return;
    try {
      // The outbox read is scope-guarded like every other await here: a
      // profile switch while it resolves must not let the old profile's
      // failed prompt restore into — or publish from — the new profile.
      final repository = ref.read(sessionOutboxRepositoryProvider);
      final messages = await scope.guard(
        repository.loadForSession(arg, brokerProfileId: profileId),
      );
      SessionOutboxMessage? outbox;
      for (final message in messages) {
        if (message.clientMessageId == clientMessageId) {
          outbox = message;
          break;
        }
      }
      if (outbox == null || outbox.kind != SessionOutboxMessageKind.prompt) {
        return;
      }
      final text = outbox.payload['text'];
      if (text is! String || text.isEmpty) return;
      if (text.length > maxLocalDraftTextChars) {
        // The durable row refuses oversized text, so the failed outbox row
        // stays the durable copy — but a terminal nack must still RESTORE the
        // text, not merely retain it in a table no UI reads. The composer gets
        // it back in memory (only into an empty composer, like every restore),
        // where the too-long status already explains its reduced durability.
        _surfaceDraft(text, kind: SessionDraftSurfaceKind.restoreIfEmpty);
        return;
      }
      await _ensureLocalDraftLoadedFor(profileId, scope);
      // A failed load must bail like every other entry point: continuing with
      // an empty cache rebuilds from "no row", and that version-0 create can
      // blind-overwrite a row still sitting at the schema-migration default.
      if (_loadedDraftScopeKey != profileId) return;
      await _withDraftRowRetry<void>(() async {
        final row = _localDraft;
        if (row != null &&
            row.submittedClientMessageId != clientMessageId &&
            row.text.isNotEmpty &&
            row.text != text) {
          // Other text owns the row. It does not have to be a newer local
          // edit: a CLEAN row holding another device's adopted shared draft is
          // the more dangerous case, because overwriting it keeps the current
          // shared revision, so the next publish replaces that device's unsent
          // text everywhere. Preserve the failed prompt as the second version
          // instead AND surface the choice — text kept only in SQLite is text
          // the user cannot recover.
          if (row.conflictText != text) {
            await _saveLocalDraft(
              row.copyWith(conflictText: text, updatedAt: DateTime.now()),
              scope,
            );
          }
          if (state.draftConflict == null) {
            state = state.copyWith(
              draftConflict: SessionDraftConflict(
                localText: row.text,
                sharedText: text,
                kind: SessionDraftConflictKind.unsentPrompt,
              ),
            );
          }
          return;
        }
        final restored = await _saveLocalDraft(
          (row ??
                  SessionLocalDraft.create(
                    brokerProfileId: profileId,
                    sessionKey: arg,
                    text: text,
                  ))
              .copyWith(
                text: text,
                localRevision: (row?.localRevision ?? 0) + 1,
                dirty: true,
                clearSubmitted: true,
                clearPendingClear: true,
                clearConflict: true,
                updatedAt: DateTime.now(),
              ),
          scope,
        );
        _surfaceDraft(
          restored.text,
          kind: SessionDraftSurfaceKind.restoreIfEmpty,
        );
      }, whenRefused: null);
    } on _StaleDraftScope {
      rethrow;
    } on Object {
      // The failed outbox row retains the payload for a later restore.
    }
  }

  /// Profile switches isolate drafts: the cached row belongs to the previous
  /// profile, so it is dropped (the composer is cleared by the caller) and
  /// the new profile's row hydrates on the next connected transition.
  void _resetLocalDraftForProfileSwitch() {
    // Retires every in-flight mutation first — not just queued ones. Each
    // serialized mutation carries a [_DraftScope] bound to this generation and
    // re-checks it after EVERY await, so an operation that is mid-await right
    // now unwinds at its next resumption instead of running its remaining
    // effects (a row write, a publish, a composer surface) against the new
    // profile.
    _draftCacheGeneration++;
    unawaited(_localDraftSubscription?.cancel());
    _localDraftSubscription = null;
    _observedDraftScopeKey = null;
    _stagedLocalDraftText = null;
    _ownedDraftMutationVersions.clear();
    _ownedDraftDeletesAwaitingObservation = 0;
    _localDraft = null;
    _loadedDraftScopeKey = null;
    // The confirmation this waited for belongs to the previous profile's
    // page content; dropping it leaves the row in place, which the next
    // attach of THAT profile offers again — the safe direction.
    _pendingRecoveredPromptRemoval = null;
    // The new profile may be a different broker at a different contract
    // revision, so its capability must be re-negotiated, not inherited.
    _forgetNegotiatedContract();
    _draftHydrated = false;
    // The composer's authority to clear belongs to the content it was holding,
    // which was the OLD profile's. It must earn it again against the new one.
    _composerHeldContentGeneration = null;
    _composerAnnouncedThisAttach = false;
    if (state.draftConflict != null) {
      state = state.copyWith(clearDraftConflict: true);
    }
  }
}
