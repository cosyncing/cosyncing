import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';

/// Mutually exclusive presentation groups over the durable inbox snapshot.
///
/// Completion review uses the existing unread state: opening the session reads
/// its completion. This does not invent a separate persistent review queue.
final class AttentionInboxPresentation {
  /// Projects each event exactly once, before either UI filter is applied.
  AttentionInboxPresentation(AttentionInboxSections sections) {
    for (final entry in sections.all) {
      final event = entry.event;
      final active = event.state == 'active' && event.resolvedAt == null;
      if (active && (event.isQuestionRequired || event.isPermissionRequired)) {
        requests.add(entry);
      } else if (entry.isUnread &&
          (event.isRunFinished || event.isGoalFinished)) {
        completions.add(entry);
      } else if (sections.actionRequired.contains(entry)) {
        urgent.add(entry);
      } else {
        activity.add(entry);
      }
    }
    activity.sort((a, b) => b.event.updatedAt.compareTo(a.event.updatedAt));
  }

  /// Active questions and permissions, whether or not their alert was read.
  final List<AttentionInboxEntry> requests = [];

  /// Completed turns and goals that have not been read.
  final List<AttentionInboxEntry> completions = [];

  /// Failures, security alerts and future critical events retain visibility.
  final List<AttentionInboxEntry> urgent = [];

  /// All remaining maintenance and history, including unknown event kinds.
  final List<AttentionInboxEntry> activity = [];

  /// Number of events that require input or inspection.
  int get pendingCount => requests.length + completions.length + urgent.length;
}
