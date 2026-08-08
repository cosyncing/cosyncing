import 'package:broker_contract/broker_contract.dart';
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

    for (final entry in entries) {
      final event = entry.event;
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
