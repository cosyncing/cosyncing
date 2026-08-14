part of '../detail/session_detail_controller.dart';

extension _SessionDetailTranscriptPersistence on SessionDetailController {
  SessionCacheWriteAdmission _replaceTranscriptAdmission(
    String brokerProfileId,
  ) {
    final writeFence = _cacheWriteFence;
    return (writeFence..release(_pendingTranscriptAdmission)).admitTranscript(
      brokerSourceKey: brokerProfileId,
      tool: arg.tool,
      sessionId: arg.sessionId,
    );
  }

  void _drainTranscriptPersistence() {
    if (_transcriptCommitInFlight) return;
    final snapshot = _pendingTranscriptSnapshot;
    final admission = _pendingTranscriptAdmission;
    if (snapshot == null || admission == null) return;
    _pendingTranscriptSnapshot = null;
    _pendingTranscriptAdmission = null;
    final tickets = List<_PendingAttachTicket>.of(_pendingTranscriptTickets);
    _pendingTranscriptTickets.clear();
    _transcriptCommitInFlight = true;
    unawaited(
      _commitTranscriptSnapshot(
        snapshot,
        admission: admission,
        tickets: tickets,
      ).whenComplete(() {
        _transcriptCommitInFlight = false;
        // Persist whatever accumulated while this commit was in flight; the
        // single follow-up commit covers every event coalesced behind it.
        _drainTranscriptPersistence();
      }),
    );
  }
}
