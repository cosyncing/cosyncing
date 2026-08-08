part of 'session_detail_controller.dart';

class _TranscriptExportFailure {
  const _TranscriptExportFailure({
    required this.message,
    this.code,
  });

  final String message;
  final String? code;
}

/// One un-acked history attach ticket plus the owner it arrived on.
///
/// The connection and broker scope are captured so a coalesced commit only
/// acks (or nacks) a ticket back to the exact owner that issued it.
final class _PendingAttachTicket {
  const _PendingAttachTicket({
    required this.ticket,
    required this.connection,
    required this.brokerScopeKey,
  });

  final String ticket;
  final SessionDetailConnection connection;
  final String brokerScopeKey;
}

/// Deadline for one in-flight backward `history-page` request.
///
/// Overridable in tests so the timeout path can be exercised without a real
/// 20-second wait.
final sessionHistoryPageTimeoutProvider = Provider<Duration>(
  (ref) => const Duration(seconds: 20),
);

/// Provider for one session detail controller.
final AutoDisposeNotifierProviderFamily<
  SessionDetailController,
  SessionDetailState,
  SessionDetailKey
>
sessionDetailControllerProvider = NotifierProvider.autoDispose
    .family<SessionDetailController, SessionDetailState, SessionDetailKey>(
      SessionDetailController.new,
    );
