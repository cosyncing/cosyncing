import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Window-local identity of one open session's transcript viewport.
///
/// [sourceKey] is the exact [RosterSource.storageKey], so endpoint edits and
/// delete/re-add incarnations cannot inherit a retired broker's reading
/// position.
@immutable
final class SessionViewportKey {
  /// Creates a viewport key.
  const SessionViewportKey({
    required this.sourceKey,
    required this.tool,
    required this.sessionId,
  });

  /// Creates a key for [source].
  factory SessionViewportKey.forSource({
    required RosterSource source,
    required String tool,
    required String sessionId,
  }) => SessionViewportKey(
    sourceKey: source.storageKey,
    tool: tool,
    sessionId: sessionId,
  );

  /// Exact broker source key.
  final String sourceKey;

  /// Agent tool id.
  final String tool;

  /// Session id within [tool].
  final String sessionId;

  @override
  bool operator ==(Object other) =>
      other is SessionViewportKey &&
      other.sourceKey == sourceKey &&
      other.tool == tool &&
      other.sessionId == sessionId;

  @override
  int get hashCode => Object.hash(sourceKey, tool, sessionId);
}

/// Payload-free semantic transcript viewport.
@immutable
final class SessionViewportRecord {
  /// Creates a semantic viewport record.
  const SessionViewportRecord({
    required this.followTail,
    required this.anchorMessageKey,
    required this.anchorViewportTop,
    required this.membershipGeneration,
  });

  /// Whether the transcript was following the settled tail.
  final bool followTail;

  /// Canonical stable key of the first useful visible message.
  final String? anchorMessageKey;

  /// The anchor row's top relative to the transcript viewport.
  final double? anchorViewportTop;

  /// Open-membership generation that admitted this capture.
  ///
  /// Closing and reopening the same session intentionally creates a new view.
  /// This generation makes a late dispose/capture from the retired page inert.
  final int membershipGeneration;

  @override
  bool operator ==(Object other) =>
      other is SessionViewportRecord &&
      other.followTail == followTail &&
      other.anchorMessageKey == anchorMessageKey &&
      other.anchorViewportTop == anchorViewportTop &&
      other.membershipGeneration == membershipGeneration;

  @override
  int get hashCode => Object.hash(
    followTail,
    anchorMessageKey,
    anchorViewportTop,
    membershipGeneration,
  );
}

/// One in-memory viewport registry per Riverpod container (app window).
final sessionViewportRegistryProvider =
    NotifierProvider<
      SessionViewportRegistry,
      Map<SessionViewportKey, SessionViewportRecord>
    >(SessionViewportRegistry.new);

/// Owns semantic viewport records for the exact current open-session set.
class SessionViewportRegistry
    extends Notifier<Map<SessionViewportKey, SessionViewportRecord>> {
  final Map<SessionViewportKey, int> _membershipGenerations = {};
  var _nextMembershipGeneration = 0;

  @override
  Map<SessionViewportKey, SessionViewportRecord> build() => const {};

  /// Reconciles admission to [keys], retiring removed tabs immediately.
  void synchronize(Set<SessionViewportKey> keys) {
    final removed = _membershipGenerations.keys
        .where((key) => !keys.contains(key))
        .toList(growable: false);
    for (final key in removed) {
      _membershipGenerations.remove(key);
    }
    for (final key in keys) {
      _membershipGenerations.putIfAbsent(
        key,
        () => ++_nextMembershipGeneration,
      );
    }
    if (removed.isEmpty) return;
    state = Map.unmodifiable({
      for (final entry in state.entries)
        if (keys.contains(entry.key)) entry.key: entry.value,
    });
  }

  /// Retires every source, membership generation, and viewport record.
  void clear() {
    _membershipGenerations.clear();
    if (state.isNotEmpty) state = const {};
  }

  /// Current admission generation for [key], or null when the tab is closed.
  int? membershipGenerationFor(SessionViewportKey key) =>
      _membershipGenerations[key];

  /// Current semantic record for [key].
  SessionViewportRecord? recordFor(SessionViewportKey key) => state[key];

  /// Stores a semantic capture if its open-membership lease is still current.
  void capture({
    required SessionViewportKey key,
    required int membershipGeneration,
    required bool followTail,
    String? anchorMessageKey,
    double? anchorViewportTop,
  }) {
    if (_membershipGenerations[key] != membershipGeneration) return;
    final record = SessionViewportRecord(
      followTail: followTail,
      anchorMessageKey: followTail ? null : anchorMessageKey,
      anchorViewportTop: followTail ? null : anchorViewportTop,
      membershipGeneration: membershipGeneration,
    );
    if (state[key] == record) return;
    state = Map.unmodifiable({...state, key: record});
  }

  /// Clears a disappeared semantic anchor without retiring the open tab.
  void clearRecord({
    required SessionViewportKey key,
    required int membershipGeneration,
  }) {
    if (_membershipGenerations[key] != membershipGeneration ||
        !state.containsKey(key)) {
      return;
    }
    final next = Map<SessionViewportKey, SessionViewportRecord>.of(state)
      ..remove(key);
    state = Map.unmodifiable(next);
  }
}
