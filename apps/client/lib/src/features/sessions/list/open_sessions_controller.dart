import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_controller.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The opened-sessions working set: an ordered tab list plus the active tab.
@immutable
class OpenSessionsState {
  /// Creates an opened-sessions state.
  const OpenSessionsState({this.refs = const [], this.activeKey});

  /// The ordered open sessions (the tab strip, left to right).
  final List<SessionRef> refs;

  /// The [SessionRef.key] of the active tab, or null when none is open.
  final String? activeKey;

  /// Whether no session is open.
  bool get isEmpty => refs.isEmpty;

  /// The number of open sessions.
  int get length => refs.length;

  /// The active [SessionRef], or null if none matches [activeKey].
  SessionRef? get active {
    for (final ref in refs) {
      if (ref.key == activeKey) {
        return ref;
      }
    }
    return null;
  }
}

/// Durable, per-broker-profile opened-sessions working set (VS Code-style open
/// editors). Persists across restarts and width changes.
///
/// See `docs/architecture/client-ui.md`.
final openSessionsControllerProvider =
    AsyncNotifierProvider<OpenSessionsController, OpenSessionsState>(
      OpenSessionsController.new,
    );

/// Owns the opened-sessions working set for the active broker profile.
///
/// Rebuilds (and reloads) when the active profile changes; every mutation
/// persists asynchronously. Closing a tab removes it from the working set,
/// never from the broker.
class OpenSessionsController extends AsyncNotifier<OpenSessionsState> {
  String? _sourceKey;
  String? _legacyProfileId;
  StreamSubscription<List<SessionRef>>? _membershipSubscription;
  Future<void> _operationTail = Future<void>.value();
  int _membershipGeneration = 0;

  OpenSessionsStore get _store => ref.read(openSessionsStoreProvider);

  @override
  Future<OpenSessionsState> build() async {
    final profile = ref.watch(activeBrokerProfileProvider);
    final source = RosterSource.of(profile);
    _sourceKey = source?.storageKey;
    _legacyProfileId = profile?.id;
    final sourceKey = _sourceKey;
    if (sourceKey == null) {
      return const OpenSessionsState();
    }
    final generation = ++_membershipGeneration;
    await _membershipSubscription?.cancel();
    final store = _store;
    final snapshot = store is LosslessOpenSessionsStore
        ? await store.loadLossless(
            sourceKey,
            legacyProfileId: _legacyProfileId,
          )
        : await store.load(_legacyProfileId!);
    if (generation != _membershipGeneration) {
      return const OpenSessionsState();
    }
    if (store is LosslessOpenSessionsStore) {
      _membershipSubscription = store
          .watchMembership(sourceKey)
          .listen((refs) => _acceptObservedMembership(generation, refs));
      ref.onDispose(() {
        _membershipGeneration++;
        unawaited(_membershipSubscription?.cancel());
      });
    }
    return OpenSessionsState(
      refs: snapshot.refs,
      activeKey:
          snapshot.activeKey ??
          (snapshot.refs.isEmpty ? null : snapshot.refs.first.key),
    );
  }

  OpenSessionsState get _current =>
      state.valueOrNull ?? const OpenSessionsState();

  void _commitLegacy(OpenSessionsState next) {
    state = AsyncData(next);
    final profileId = _legacyProfileId;
    if (profileId != null) {
      unawaited(
        _store.save(
          profileId,
          OpenSessionsSnapshot(refs: next.refs, activeKey: next.activeKey),
        ),
      );
    }
  }

  void _setLocal(OpenSessionsState next) {
    state = AsyncData(next);
  }

  void _acceptObservedMembership(int generation, List<SessionRef> refs) {
    if (generation != _membershipGeneration || _sourceKey == null) return;
    final current = _current;
    var activeKey = current.activeKey;
    if (activeKey != null && !refs.any((ref) => ref.key == activeKey)) {
      activeKey = refs.isEmpty ? null : refs.first.key;
    }
    _setLocal(OpenSessionsState(refs: refs, activeKey: activeKey));
  }

  void _runLosslessOperation(
    Future<void> Function(LosslessOpenSessionsStore store, String sourceKey)
    operation,
  ) {
    final store = _store;
    final sourceKey = _sourceKey;
    if (store is! LosslessOpenSessionsStore || sourceKey == null) return;
    final generation = _membershipGeneration;
    _operationTail = _operationTail
        .then((_) async {
          if (generation != _membershipGeneration || _sourceKey != sourceKey) {
            return;
          }
          await operation(store, sourceKey);
        })
        .catchError((Object _) {
          // Working-set persistence cannot make navigation unusable. The
          // Drift watch or the next operation re-establishes durable truth.
        });
  }

  void _saveActiveHint(String? activeKey) {
    final store = _store;
    final sourceKey = _sourceKey;
    if (store is LosslessOpenSessionsStore && sourceKey != null) {
      _runLosslessOperation(
        (store, sourceKey) => store.saveActiveHint(sourceKey, activeKey),
      );
    }
  }

  /// Opens [entry]: adds it if absent (else replaces it in place) and makes it
  /// the active tab.
  ///
  /// The existing ref is REPLACED, not merged. A merge cannot express "the
  /// status is no longer known": `copyWith(status: null)` keeps the old value,
  /// so reopening a session from cached identity would silently retain a
  /// needs-input claim persisted before the last restart and present it as
  /// current. [entry] carries the whole reference — identity, title and
  /// whatever status the caller actually has — so replacing it is what makes an
  /// unknown status expressible.
  void open(SessionRef entry) {
    final current = _current;
    final refs = [...current.refs];
    final index = refs.indexWhere((ref) => ref.key == entry.key);
    if (index >= 0) {
      refs[index] = entry;
    } else {
      refs.add(entry);
    }
    final next = OpenSessionsState(refs: refs, activeKey: entry.key);
    if (_store case final LosslessOpenSessionsStore _) {
      _setLocal(next);
      _runLosslessOperation(
        (store, sourceKey) => store.openMember(sourceKey, entry),
      );
      _saveActiveHint(entry.key);
    } else {
      _commitLegacy(next);
    }
  }

  /// Activates an already-open session by [key]; a no-op if it is not open.
  void activate(String key) {
    final current = _current;
    if (current.activeKey == key) {
      return;
    }
    if (!current.refs.any((ref) => ref.key == key)) {
      return;
    }
    final next = OpenSessionsState(refs: current.refs, activeKey: key);
    if (_store case final LosslessOpenSessionsStore _) {
      _setLocal(next);
      _saveActiveHint(key);
    } else {
      _commitLegacy(next);
    }
  }

  /// Closes [key] from the working set (not the broker). If it was active,
  /// activates a neighbor.
  ///
  /// The draft-durability barrier lives HERE rather than in each caller.
  /// Closing a tab drops the resident lease `OpenSessionSyncSupervisor` holds
  /// on that session's detail controller, which auto-disposes it — and a value
  /// typed inside the 300 ms persistence debounce has not crossed Drift yet.
  /// Every close path (the compact page, the wide tab strip's button, the wide
  /// Ctrl/Cmd+W chord) therefore gets the flush by construction; a future close
  /// button cannot forget it.
  ///
  /// The returned future completes once the working set has been mutated. A
  /// session with nothing staged never awaits at all, so the tab still leaves
  /// the strip synchronously in that case.
  Future<void> close(String key) {
    final barrier = _draftDurabilityBarrier(key);
    if (barrier == null) {
      _closeNow(key);
      return Future<void>.value();
    }
    return barrier.then((_) => _closeNow(key));
  }

  /// Makes the closing session's composer value durable before the tab goes.
  ///
  /// Null when there is nothing to wait for: [key] is not open, its detail
  /// controller was never created (or has already auto-disposed), or no
  /// composer ever staged a value for it.
  ///
  /// The flush is best effort by design. A failed one still closes the tab:
  /// this notifier has no surface to report a refused write on, the DR1b
  /// keepalive record already holds the text synchronously, and a tab that
  /// silently refuses to close would be the worse failure. The compact page
  /// keeps its own barrier for exactly that reason — it CAN report, so it
  /// still aborts and shows the message. Its flush and this one coalesce:
  /// `flushLocalDraft` of an unchanged value performs no write and no relay,
  /// and draft mutations are serialized, never nested, so the second call
  /// cannot deadlock behind the first.
  Future<void>? _draftDurabilityBarrier(String key) {
    SessionRef? closing;
    for (final entry in _current.refs) {
      if (entry.key == key) {
        closing = entry;
        break;
      }
    }
    if (closing == null) return null;
    final provider = sessionDetailControllerProvider(
      SessionDetailKey(tool: closing.tool, sessionId: closing.id),
    );
    // Never `read` a detail controller into existence here: creating one to
    // close a session would build an attach-capable controller for a session
    // the user is walking away from.
    if (!ref.exists(provider)) return null;
    return ref.read(provider.notifier).flushStagedLocalDraft();
  }

  void _closeNow(String key) {
    final current = _current;
    final index = current.refs.indexWhere((ref) => ref.key == key);
    if (index < 0) {
      return;
    }
    final refs = [...current.refs]..removeAt(index);
    var nextActive = current.activeKey;
    if (current.activeKey == key) {
      if (refs.isEmpty) {
        nextActive = null;
      } else {
        final neighbor = index <= refs.length - 1 ? index : refs.length - 1;
        nextActive = refs[neighbor].key;
      }
    }
    final next = OpenSessionsState(refs: refs, activeKey: nextActive);
    if (_store case final LosslessOpenSessionsStore _) {
      _setLocal(next);
      _runLosslessOperation(
        (store, sourceKey) => store.closeMember(sourceKey, key),
      );
      _saveActiveHint(nextActive);
    } else {
      _commitLegacy(next);
    }
  }

  /// Closes every open session except [key].
  ///
  /// Carries the same draft-durability contract as [close], for N tabs at
  /// once: closing a tab drops the resident lease on its detail controller, so
  /// a value typed inside the 300 ms debounce dies with it — and "close
  /// others" is precisely the gesture aimed at the tabs the user is NOT
  /// looking at, where an unsaved draft is most likely to be sitting.
  ///
  /// Every closing key's barrier is gathered first and awaited together, then
  /// the working set is mutated once. Barriers must not be serialized behind
  /// each other (N debounce flushes in sequence), and the mutation must not be
  /// split per tab (each split would publish an intermediate strip).
  ///
  /// Like [close], a working set with nothing staged never awaits at all, so
  /// the tabs still leave the strip synchronously in that case.
  Future<void> closeOthers(String key) {
    final current = _current;
    final kept = current.refs.where((ref) => ref.key == key).toList();
    if (kept.isEmpty) {
      return Future<void>.value();
    }
    final barriers = <Future<void>>[];
    for (final ref in current.refs) {
      if (ref.key == key) {
        continue;
      }
      final barrier = _draftDurabilityBarrier(ref.key);
      if (barrier != null) {
        barriers.add(barrier);
      }
    }
    if (barriers.isEmpty) {
      _closeOthersNow(key);
      return Future<void>.value();
    }
    return Future.wait(barriers).then((_) => _closeOthersNow(key));
  }

  void _closeOthersNow(String key) {
    final current = _current;
    final kept = current.refs.where((ref) => ref.key == key).toList();
    if (kept.isEmpty) {
      return;
    }
    final next = OpenSessionsState(refs: kept, activeKey: key);
    if (_store case final LosslessOpenSessionsStore _) {
      _setLocal(next);
      _runLosslessOperation(
        (store, sourceKey) => store.closeOtherMembers(sourceKey, [
          for (final ref in current.refs)
            if (ref.key != key) ref.key,
        ]),
      );
      _saveActiveHint(key);
    } else {
      _commitLegacy(next);
    }
  }

  /// Moves the tab at [oldIndex] to [newIndex] (ReorderableListView semantics).
  void reorder(int oldIndex, int newIndex) {
    final current = _current;
    if (oldIndex < 0 || oldIndex >= current.refs.length) {
      return;
    }
    final refs = [...current.refs];
    final moved = refs.removeAt(oldIndex);
    var target = newIndex;
    if (target > oldIndex) {
      target -= 1;
    }
    refs.insert(target.clamp(0, refs.length), moved);
    final next = OpenSessionsState(
      refs: refs,
      activeKey: current.activeKey,
    );
    if (_store case final LosslessOpenSessionsStore _) {
      _setLocal(next);
      _runLosslessOperation(
        (store, sourceKey) =>
            store.reorderMembers(sourceKey, [for (final ref in refs) ref.key]),
      );
    } else {
      _commitLegacy(next);
    }
  }

  /// Refreshes the title/status of open tabs from a fresh roster, without adding
  /// or removing tabs, so the strip stays live as sessions change.
  void refreshMetadata(List<SessionInfo> sessions) {
    final current = _current;
    if (current.refs.isEmpty) {
      return;
    }
    final byKey = <String, SessionInfo>{
      for (final session in sessions) '${session.tool}/${session.id}': session,
    };
    var changed = false;
    final refs = <SessionRef>[];
    for (final ref in current.refs) {
      final session = byKey[ref.key];
      if (session == null) {
        refs.add(ref);
        continue;
      }
      final updated = SessionRef.fromSession(session);
      if (updated != ref) {
        changed = true;
      }
      refs.add(updated);
    }
    if (!changed) {
      return;
    }
    final next = OpenSessionsState(
      refs: refs,
      activeKey: current.activeKey,
    );
    if (_store case final LosslessOpenSessionsStore _) {
      _setLocal(next);
      _runLosslessOperation(
        (store, sourceKey) => store.refreshMemberMetadata(sourceKey, refs),
      );
    } else {
      _commitLegacy(next);
    }
  }

  /// Applies an accepted native title without disturbing live tab status.
  void renameSessionTitle(String tool, String id, String title) {
    final current = _current;
    final key = '$tool/$id';
    final index = current.refs.indexWhere((ref) => ref.key == key);
    if (index < 0) return;
    final existing = current.refs[index];
    final acceptedTitle = title.isEmpty ? id : title;
    if (existing.title == acceptedTitle) return;
    final refs = [...current.refs];
    refs[index] = SessionRef(
      tool: existing.tool,
      id: existing.id,
      title: acceptedTitle,
      status: existing.status,
    );
    final next = OpenSessionsState(refs: refs, activeKey: current.activeKey);
    if (_store case final LosslessOpenSessionsStore _) {
      _setLocal(next);
      _runLosslessOperation(
        (store, sourceKey) => store.refreshMemberMetadata(sourceKey, refs),
      );
    } else {
      _commitLegacy(next);
    }
  }
}
