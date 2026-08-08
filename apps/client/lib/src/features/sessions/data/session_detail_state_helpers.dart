// Same-library coordinators intentionally access Notifier-owned state.
// ignore_for_file: invalid_use_of_protected_member
// ignore_for_file: invalid_use_of_visible_for_testing_member
part of 'session_detail_controller.dart';

extension _SessionDetailStateHelpers on SessionDetailController {
  SessionCurrentModel? _decodeModel(Object? value) {
    if (value is! Map) {
      return null;
    }
    try {
      return SessionCurrentModel.fromJson(value.cast<String, dynamic>());
    } on Object {
      return null;
    }
  }

  String _nextClientMessageId() {
    final now = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
    final sequence = (_clientMessageCounter++).toRadixString(36);
    return 'ca.$now.$sequence';
  }

  void _removeOptimisticPrompt(String clientMessageId) {
    state = state.copyWith(
      optimisticPrompts: state.optimisticPrompts
          .where((prompt) => prompt.clientMessageId != clientMessageId)
          .toList(growable: false),
    );
  }

  ({List<SessionOptimisticPrompt> prompts, Map<String, String> clientKeys})
  _optimisticPromptsAfterEvent(
    List<SessionOptimisticPrompt> current,
    Map<String, String> currentClientKeys,
    WireEvent event,
  ) {
    if (current.isEmpty && currentClientKeys.isEmpty) {
      return (prompts: current, clientKeys: currentClientKeys);
    }
    if (event case MessageWireEvent(
      message: AgentMessage(type: AgentMessageType.historyReset),
    )) {
      // The conversation itself was cleared; a pending prompt has nothing to
      // converge into and every decorated echo row is gone.
      return (prompts: const [], clientKeys: const {});
    }
    // Copy-on-write recorder for legacy (unstamped) deliveries, bounded and
    // insertion-ordered so display identity survives holder retirement.
    Map<String, String>? updatedKeys;
    void recordLegacyDelivery(String echoKey, String clientMessageId) {
      final map = (updatedKeys ??= Map.of(currentClientKeys))
        ..remove(echoKey)
        ..[echoKey] = clientMessageId;
      while (map.length > kMaxRetainedTranscriptClientKeys) {
        map.remove(map.keys.first);
      }
    }

    switch (event) {
      case MessageWireEvent(:final message):
        final reconciled = _reconcileOptimisticEchoes(
          current,
          [message],
          recordLegacyDelivery,
        );
        return (
          prompts: identical(reconciled, current)
              ? current
              : List.unmodifiable(reconciled),
          clientKeys: updatedKeys ?? currentClientKeys,
        );
      case HistoryWireEvent(:final messages, :final reset):
        final reconciled = _reconcileOptimisticEchoes(
          current,
          messages,
          recordLegacyDelivery,
        );
        if (!reset) {
          return (
            prompts: identical(reconciled, current)
                ? current
                : List.unmodifiable(reconciled),
            clientKeys: updatedKeys ?? currentClientKeys,
          );
        }
        // The replay replaced the transcript. A delivered holder's job is
        // done — the replay carries its echo in authoritative native order —
        // while a still-pending prompt survives with its anchor re-pinned to
        // the replay tail: visibly pending, newest, and in front of the
        // answer that will stream in next. Its echo (live or in the next
        // replay) still converges it by id. Identity decorations survive for
        // exactly the echoes the authoritative replay still carries.
        final replayKeys = <String>{
          for (final message in messages)
            if (stableTranscriptMessageKey(message) case final String key) key,
        };
        final keys = updatedKeys ?? currentClientKeys;
        final tailKey = latestTranscriptAnchorKey(messages);
        return (
          prompts: List.unmodifiable([
            for (final prompt in reconciled)
              if (!prompt.isDelivered) prompt.reAnchoredTo(tailKey),
          ]),
          clientKeys: {
            for (final entry in keys.entries)
              if (replayKeys.contains(entry.key)) entry.key: entry.value,
          },
        );
      case _:
        return (prompts: current, clientKeys: currentClientKeys);
    }
  }

  /// Marks every prompt whose canonical echo is in [messages] as delivered.
  ///
  /// Correlation is by `clientKey` — the broker-controlled app-send token the
  /// adapters stamp on the exact echo — never by comparing text between two
  /// arbitrary messages. The narrow legacy fallback below exists only for an
  /// unstamped echo meeting a pending local send, and claims at most the
  /// oldest matching row. A stamped echo that matches no local row (another
  /// client's send) claims nothing.
  ///
  /// A matched row becomes a position holder for its echo instead of being
  /// removed: the projection renders the canonical echo at the row's anchored
  /// boundary, so an echo arriving after its own answer cannot display behind
  /// it. A keyless legacy echo cannot be held that way; its row is removed and
  /// the echo renders at its arrival position.
  List<SessionOptimisticPrompt> _reconcileOptimisticEchoes(
    List<SessionOptimisticPrompt> current,
    List<AgentMessage> messages,
    void Function(String echoKey, String clientMessageId) onLegacyDelivery,
  ) {
    var reconciled = current;
    for (final message in messages) {
      if (message.type != AgentMessageType.userMessage) continue;
      final echoKey = stableTranscriptMessageKey(message);
      // A re-emit of an echo some holder already claimed (streamed update,
      // replayed frame) must not claim a second row.
      if (echoKey != null &&
          reconciled.any((p) => p.deliveredMessageKey == echoKey)) {
        continue;
      }
      final clientKey = message.userMessageClientKey;
      final int index;
      if (clientKey != null) {
        index = reconciled.indexWhere(
          (prompt) =>
              !prompt.isDelivered && prompt.clientMessageId == clientKey,
        );
      } else {
        final rawText = message.raw['text'];
        if (rawText is! String) continue;
        // Legacy no-id echo: exact text, or the adapter-appended attachment
        // note after the exact text on its own line. Oldest pending row only.
        index = reconciled.indexWhere(
          (prompt) =>
              !prompt.isDelivered &&
              (rawText == prompt.text ||
                  rawText.startsWith('${prompt.text}\n')),
        );
      }
      if (index < 0) continue;
      if (clientKey == null && echoKey != null) {
        // The association exists only in this reconcile; record it so the
        // canonical row keeps its display identity after the holder retires.
        onLegacyDelivery(echoKey, reconciled[index].clientMessageId);
      }
      reconciled = [
        for (var i = 0; i < reconciled.length; i++)
          if (i != index)
            reconciled[i]
          else if (echoKey != null)
            reconciled[i].deliveredBy(echoKey),
      ];
    }
    return reconciled;
  }

  bool _eventCompletesCommandProgress(WireEvent event) {
    if (state.commandProgress == null) return false;
    return switch (event) {
      ErrorWireEvent() || EndedWireEvent() => true,
      HistoryWireEvent(reset: true) => true,
      MessageWireEvent(:final message) =>
        message.type == AgentMessageType.historyReset ||
            message.type == AgentMessageType.error,
      _ => false,
    };
  }

  void _startCommandProgress(String name) {
    _commandProgressTimer?.cancel();
    final progress = SessionCommandProgress(
      name: name,
      startedAt: DateTime.now().millisecondsSinceEpoch,
    );
    state = state.copyWith(commandProgress: progress);
    _commandProgressTimer = Timer(const Duration(minutes: 5), () {
      _commandProgressTimer = null;
      if (state.commandProgress?.startedAt == progress.startedAt) {
        state = state.copyWith(clearCommandProgress: true);
      }
    });
  }

  void _clearCommandProgress() {
    _commandProgressTimer?.cancel();
    _commandProgressTimer = null;
    state = state.copyWith(clearCommandProgress: true);
  }

  List<List<String>> _decodeAnswers(Object? raw) {
    if (raw is! List) {
      return const [];
    }
    return [
      for (final answer in raw)
        if (answer is List)
          [
            for (final item in answer)
              if (item is String) item,
          ],
    ];
  }
}

const _unavailableAgentActions = SessionAgentActions(
  canRenameNative: false,
  canFork: false,
  canClone: false,
  canTranscriptExport: false,
  canAttachFiles: false,
  loaded: false,
);
