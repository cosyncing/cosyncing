import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/schedules/controller/inline_scheduled_message_controller.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Identity of one diagnostics reading.
///
/// Source-qualified, unlike [InlineScheduledMessageKey]. Two brokers can hand
/// out the same native tool/session id, and this store OUTLIVES the controller
/// that wrote it — so a tool/session-only key would let a switched-to broker
/// display the previous one's row count and raw failure text before it has read
/// anything of its own. The qualifier is the exact `RosterSource.storageKey`,
/// not the profile id: re-pointing a profile at another machine keeps the id,
/// and an id-keyed reading would be shown as the new machine's.
@immutable
final class InlineScheduleDiagnosticsKey {
  /// Creates a source-qualified diagnostics identity.
  const InlineScheduleDiagnosticsKey({
    required this.brokerScopeKey,
    required this.tool,
    required this.sessionId,
  });

  /// `RosterSource.storageKey` of the broker the reading was taken against.
  final String brokerScopeKey;

  /// Broker tool id.
  final String tool;

  /// Broker session id.
  final String sessionId;

  @override
  bool operator ==(Object other) =>
      other is InlineScheduleDiagnosticsKey &&
      other.brokerScopeKey == brokerScopeKey &&
      other.tool == tool &&
      other.sessionId == sessionId;

  @override
  int get hashCode => Object.hash(brokerScopeKey, tool, sessionId);
}

/// A Debug-facing reading of one session's inline schedule freshness.
///
/// Deliberately a plain value, not a live view of the controller: opening Debug
/// unmounts Chat, which auto-disposes the inline schedule controller and
/// cancels its poll timer. Debug must be able to answer "were these rows
/// current?" after that teardown WITHOUT keeping the polling controller — or
/// its timer — alive off screen, which U6 explicitly forbids.
@immutable
final class InlineScheduleDiagnostics {
  /// Creates a diagnostics reading, truncating [passiveFailureDetail].
  factory InlineScheduleDiagnostics({
    required InlineScheduleFreshness freshness,
    required int scheduleCount,
    FailureKind? passiveFailureKind,
    String? passiveFailureDetail,
  }) => InlineScheduleDiagnostics._(
    freshness: freshness,
    scheduleCount: scheduleCount,
    passiveFailureKind: passiveFailureKind,
    passiveFailureDetail: _truncateDetail(passiveFailureDetail),
  );

  const InlineScheduleDiagnostics._({
    required this.freshness,
    required this.scheduleCount,
    this.passiveFailureKind,
    this.passiveFailureDetail,
  });

  /// Longest retained diagnostic text, in UTF-16 code units. A cut detail
  /// carries [truncationMarker] on top of this, so the retained string is
  /// slightly longer than the limit and never reads as complete.
  ///
  /// A broker error body is attacker- or bug-sized, and this store survives the
  /// surface that produced it. Retaining it whole would make an eight-entry cap
  /// meaningless as a memory bound.
  static const detailCharacterLimit = 512;

  /// Appended when a detail was cut, so a truncated body never reads complete.
  static const truncationMarker = '… (truncated)';

  static String? _truncateDetail(String? detail) =>
      boundedFailureDetail(detail);

  /// Provenance of the rows the session last rendered.
  final InlineScheduleFreshness freshness;

  /// How many live inline rows that session last held.
  final int scheduleCount;

  /// Classified cause of the last passive refresh failure, if any.
  ///
  /// Recorded for EVERY passive failure, including the ones Chat suppresses, so
  /// "stale" never has to stand in for an unexamined cause.
  final FailureKind? passiveFailureKind;

  /// Bounded raw diagnostic for the same failure. Debug disclosure only.
  final String? passiveFailureDetail;

  @override
  bool operator ==(Object other) =>
      other is InlineScheduleDiagnostics &&
      other.freshness == freshness &&
      other.scheduleCount == scheduleCount &&
      other.passiveFailureKind == passiveFailureKind &&
      other.passiveFailureDetail == passiveFailureDetail;

  @override
  int get hashCode => Object.hash(
    freshness,
    scheduleCount,
    passiveFailureKind,
    passiveFailureDetail,
  );
}

/// Bounds a raw broker diagnostic before anything retains it.
///
/// Applied where the failure is CONSTRUCTED, not only where it is copied into
/// the Debug store: an actionable passive failure is held in live controller
/// state — twice, when it is also promoted to the visible row — until the next
/// successful read or Chat teardown, so bounding it downstream leaves the
/// unbounded original resident for as long as the failure stands.
///
/// Idempotent: re-bounding an already-bounded detail returns it unchanged
/// rather than cutting it again and stacking a second marker.
String? boundedFailureDetail(String? detail) {
  const limit = InlineScheduleDiagnostics.detailCharacterLimit;
  const marker = InlineScheduleDiagnostics.truncationMarker;
  if (detail == null || detail.length <= limit) return detail;
  if (detail.length == limit + marker.length && detail.endsWith(marker)) {
    return detail;
  }
  return '${detail.substring(0, limit)}$marker';
}

/// Last-known inline schedule freshness per session, surviving Chat teardown.
final NotifierProvider<
  InlineScheduleDiagnosticsController,
  Map<InlineScheduleDiagnosticsKey, InlineScheduleDiagnostics>
>
inlineScheduleDiagnosticsProvider =
    NotifierProvider<
      InlineScheduleDiagnosticsController,
      Map<InlineScheduleDiagnosticsKey, InlineScheduleDiagnostics>
    >(InlineScheduleDiagnosticsController.new);

/// Holds a bounded set of per-session freshness readings for Debug.
final class InlineScheduleDiagnosticsController
    extends
        Notifier<Map<InlineScheduleDiagnosticsKey, InlineScheduleDiagnostics>> {
  /// How many sessions keep a reading. Oldest insertion is evicted first, so a
  /// long-lived app cannot accumulate one entry per session ever opened.
  static const retainedSessions = 8;

  @override
  Map<InlineScheduleDiagnosticsKey, InlineScheduleDiagnostics> build() =>
      const {};

  /// Records [diagnostics] for [key], evicting the oldest entry past the cap.
  void record(
    InlineScheduleDiagnosticsKey key,
    InlineScheduleDiagnostics diagnostics,
  ) {
    if (state[key] == diagnostics) return;
    final next = <InlineScheduleDiagnosticsKey, InlineScheduleDiagnostics>{
      ...state,
    }..[key] = diagnostics;
    while (next.length > retainedSessions) {
      next.remove(next.keys.first);
    }
    state = Map.unmodifiable(next);
  }
}
