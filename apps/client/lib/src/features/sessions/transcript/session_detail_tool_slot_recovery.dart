// Same-library coordinators intentionally access Notifier-owned state.
// ignore_for_file: invalid_use_of_protected_member
// ignore_for_file: invalid_use_of_visible_for_testing_member
part of '../detail/session_detail_controller.dart';

/// A native tool's result position exists before it finishes. After reconnect,
/// reload pending slots still held, including slots in older pages. Ordinary
/// one-row pages update the existing identities.
extension _SessionDetailToolSlotRecovery on SessionDetailController {
  void _clearToolSlotReloads() {
    _toolSlotTimer?.cancel();
    _toolSlotTimer = null;
    _toolSlotInFlight = null;
    _toolSlotReloads.clear();
    _toolSlotsChecked.clear();
  }

  void _queueToolSlotReloads({bool recheck = false}) {
    if (!_newerHistoryOffered) return;
    if (recheck) _toolSlotsChecked.clear();
    for (final row in state.transcriptWindow.canonicalMessages) {
      final cursor = row.raw['reloadCursor'];
      final callId = row.toolCallId;
      if (row.type == AgentMessageType.toolResult &&
          row.raw['historySlot'] == true &&
          row.raw['pending'] == true &&
          cursor is String &&
          cursor.isNotEmpty &&
          callId != null &&
          !_toolSlotsChecked.contains(callId)) {
        _toolSlotReloads.putIfAbsent(
          callId,
          () => (cursor: cursor, attempts: 0),
        );
      }
    }
    _drainToolSlotReloads();
  }

  bool _stillHoldsPendingSlot(String callId) =>
      state.transcriptWindow.canonicalMessages.any(
        (row) =>
            row.type == AgentMessageType.toolResult &&
            row.toolCallId == callId &&
            row.raw['historySlot'] == true &&
            row.raw['pending'] == true,
      );

  void _drainToolSlotReloads() {
    if (_disposed ||
        _toolSlotInFlight != null ||
        _toolSlotTimer != null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected ||
        !_newerHistoryOffered) {
      return;
    }
    final connection = _connection;
    if (connection == null || connection is! SessionHistoryConnection) {
      return;
    }
    final historyConnection = connection as SessionHistoryConnection;
    while (_toolSlotReloads.isNotEmpty) {
      final callId = _toolSlotReloads.keys.first;
      if (!_stillHoldsPendingSlot(callId)) {
        _toolSlotReloads.remove(callId);
        continue;
      }
      final request = _toolSlotReloads[callId]!;
      final id = _nextHistoryNavigationId();
      _toolSlotInFlight = (id: id, callId: callId);
      _toolSlotTimer = Timer(ref.read(sessionHistoryPageTimeoutProvider), () {
        _finishToolSlotReload(id, transient: true);
      });
      unawaited(
        historyConnection
            .requestHistoryPage(
              cursor: request.cursor,
              limit: 1,
              clientMessageId: id,
            )
            .catchError((Object _) {
              _finishToolSlotReload(id, transient: true);
            }),
      );
      return;
    }
  }

  void _finishToolSlotReload(String id, {bool transient = false}) {
    final active = _toolSlotInFlight;
    if (active == null || active.id != id) return;
    _toolSlotTimer?.cancel();
    _toolSlotTimer = null;
    _toolSlotInFlight = null;
    final request = _toolSlotReloads[active.callId];
    if (transient &&
        request != null &&
        request.attempts < 4 &&
        _stillHoldsPendingSlot(active.callId)) {
      _toolSlotReloads[active.callId] = (
        cursor: request.cursor,
        attempts: request.attempts + 1,
      );
      _toolSlotTimer = Timer(
        Duration(milliseconds: 500 * (1 << request.attempts)),
        () {
          _toolSlotTimer = null;
          _drainToolSlotReloads();
        },
      );
      return;
    }
    _toolSlotReloads.remove(active.callId);
    _toolSlotsChecked.add(active.callId);
    // Bound bookkeeping even over a long-lived connection.
    if (_toolSlotsChecked.length > kMaxActiveTranscriptMessages) {
      _toolSlotsChecked.remove(_toolSlotsChecked.first);
    }
    scheduleMicrotask(_drainToolSlotReloads);
  }

  bool _handleToolSlotReply(WireEvent event) {
    final active = _toolSlotInFlight;
    if (active == null) return false;
    if (event is NackWireEvent && event.clientMessageId == active.id) {
      _finishToolSlotReload(
        active.id,
        transient: isTransientHistoryPageErrorCode(event.code),
      );
      return true;
    }
    if (event is! HistoryPageWireEvent || event.clientMessageId != active.id) {
      return false;
    }
    if (!event.isNewer && event.messages.length == 1) {
      final row = event.messages.single;
      if (row.type == AgentMessageType.toolResult &&
          row.toolCallId == active.callId &&
          row.raw['historySlot'] == true &&
          row.raw['pending'] == false &&
          _stillHoldsPendingSlot(active.callId)) {
        state = state.copyWith(
          transcriptWindow: state.transcriptWindow.applyLiveMessage(
            row,
            protectedKey: _historyViewportAnchorKey,
          ),
        );
        _enqueueTranscriptPersistence(MessageWireEvent(seq: 0, message: row));
      }
    }
    _finishToolSlotReload(active.id);
    return true;
  }
}
