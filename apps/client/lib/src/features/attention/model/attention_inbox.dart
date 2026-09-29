import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';

/// One durable attention event together with its broker profile.
final class AttentionInboxEntry {
  /// Creates a profile-scoped inbox entry.
  const AttentionInboxEntry({required this.profile, required this.event});

  /// Broker that owns the event and accepts its action/ack routes.
  final BrokerProfile profile;

  /// Durable event view merged with this device's local state.
  final AttentionEventView event;

  /// Whether this event has not been read locally or on the broker.
  ///
  /// Initial baseline rows remain visible history but are born read; see
  /// `docs/architecture/client-ui.md`.
  bool get isUnread => !event.historicalBaseline && event.readAt == null;
}

/// Priority sections used by the Attention destination.
final class AttentionInboxSections {
  /// Creates immutable inbox sections.
  AttentionInboxSections({
    required List<AttentionInboxEntry> actionRequired,
    required List<AttentionInboxEntry> maintenance,
    required List<AttentionInboxEntry> resolved,
  }) : actionRequired = List.unmodifiable(actionRequired),
       maintenance = List.unmodifiable(maintenance),
       resolved = List.unmodifiable(resolved);

  /// Groups visible entries into the reviewed priority order.
  factory AttentionInboxSections.fromEntries(
    Iterable<AttentionInboxEntry> entries,
  ) {
    final actionRequired = <AttentionInboxEntry>[];
    final maintenance = <AttentionInboxEntry>[];
    final resolved = <AttentionInboxEntry>[];
    final candidates = entries.toList(growable: false);
    final latestOutcomes = _latestSessionOutcomes(candidates);

    for (final entry in candidates) {
      final event = entry.event;
      if (_isSupersededOutcome(entry, latestOutcomes)) continue;
      if (event.dismissedAt != null) continue;
      if (event.resolvedAt != null || event.state != 'active') {
        resolved.add(entry);
      } else if (_isActionRequired(event)) {
        actionRequired.add(entry);
      } else {
        // Maintenance is deliberately the forward-compatible active bucket:
        // an unknown future kind remains visible instead of being dropped.
        maintenance.add(entry);
      }
    }

    for (final section in [actionRequired, maintenance, resolved]) {
      section.sort(
        (left, right) => right.event.updatedAt.compareTo(left.event.updatedAt),
      );
    }
    return AttentionInboxSections(
      actionRequired: actionRequired,
      maintenance: maintenance,
      resolved: resolved,
    );
  }

  /// Active events requiring a response or immediate inspection.
  final List<AttentionInboxEntry> actionRequired;

  /// Active maintenance, informational, and unknown future events.
  final List<AttentionInboxEntry> maintenance;

  /// Recently resolved informational history.
  final List<AttentionInboxEntry> resolved;

  /// All visible entries in presentation priority order.
  List<AttentionInboxEntry> get all => List.unmodifiable([
    ...actionRequired,
    ...maintenance,
    ...resolved,
  ]);

  /// Number of visible entries that have not been read.
  int get unreadCount => all.where((entry) => entry.isUnread).length;

  /// The newest turn or goal outcome of each session, keyed by profile and
  /// the notification slot the outcomes share.
  ///
  /// A session that finishes again replaces its earlier outcome, as it does
  /// in the notification center, so the inbox never lists one session several
  /// times. The newest counts even when dismissed: clearing it must not bring
  /// back the outcome it replaced.
  static Map<String, AttentionInboxEntry> _latestSessionOutcomes(
    Iterable<AttentionInboxEntry> entries,
  ) {
    final latest = <String, AttentionInboxEntry>{};
    for (final entry in entries) {
      final slot = _outcomeSlot(entry);
      if (slot == null) continue;
      final current = latest[slot];
      if (current == null || _isNewer(entry.event, current.event)) {
        latest[slot] = entry;
      }
    }
    return latest;
  }

  static bool _isSupersededOutcome(
    AttentionInboxEntry entry,
    Map<String, AttentionInboxEntry> latestOutcomes,
  ) {
    final slot = _outcomeSlot(entry);
    return slot != null && !identical(latestOutcomes[slot], entry);
  }

  static String? _outcomeSlot(AttentionInboxEntry entry) {
    final type = attentionNotificationTypeOf(entry.event);
    if (type == null || !type.isSessionOutcome) return null;
    final slot = attentionNotificationCollapseKey(entry.event, type);
    // Only a session-scoped slot collapses; an outcome without a session
    // keeps its own row.
    if (!slot.startsWith('session-outcome:')) return null;
    return '${entry.profile.id}\n$slot';
  }

  static bool _isNewer(AttentionEvent candidate, AttentionEvent current) {
    if (candidate.createdAt != current.createdAt) {
      return candidate.createdAt > current.createdAt;
    }
    // Same millisecond: any fixed order keeps the choice stable.
    return candidate.id.compareTo(current.id) > 0;
  }

  static bool _isActionRequired(AttentionEvent event) {
    return event.isPermissionRequired ||
        event.isQuestionRequired ||
        event.isRunFailed ||
        event.severity == 'action-required' ||
        // The current broker emits `action-required`; retain `critical` as a
        // safe forward-compatible synonym. See
        // docs/architecture/client-ui.md
        event.severity == 'critical';
  }
}
