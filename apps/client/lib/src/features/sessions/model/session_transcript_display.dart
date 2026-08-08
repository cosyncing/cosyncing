import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/model/tool_display_mode.dart';

/// One projected row in the session transcript.
sealed class SessionTranscriptDisplayEntry {
  const SessionTranscriptDisplayEntry({required this.sourceIndices});

  /// Indices in the canonical message list represented by this row.
  final List<int> sourceIndices;
}

/// A canonical non-tool message row.
final class MessageTranscriptDisplayEntry
    extends SessionTranscriptDisplayEntry {
  /// Creates a message row.
  MessageTranscriptDisplayEntry({
    required this.message,
    required this.sourceIndex,
  }) : super(sourceIndices: List<int>.unmodifiable([sourceIndex]));

  /// Canonical broker message.
  final AgentMessage message;

  /// Index in the canonical message list.
  final int sourceIndex;
}

/// One tool call, optionally paired with its result.
final class ToolTranscriptDisplayEntry extends SessionTranscriptDisplayEntry {
  /// Creates a normalized tool card.
  const ToolTranscriptDisplayEntry({
    required this.call,
    required this.result,
    required super.sourceIndices,
  });

  /// Tool-call frame, when available.
  final AgentMessage? call;

  /// Tool-result frame, when available.
  final AgentMessage? result;

  /// Adapter-owned class, preferring the result's current metadata.
  ToolDisplayClass? get displayClass =>
      result?.toolDisplayClass ?? call?.toolDisplayClass;

  /// Stable call id, when the adapter supplied one.
  String? get callId => result?.toolCallId ?? call?.toolCallId;

  /// Best message to use for compact result metadata.
  AgentMessage get primaryMessage => result ?? call!;
}

/// Two or more consecutive lookup tool cards.
final class LookupGroupTranscriptDisplayEntry
    extends SessionTranscriptDisplayEntry {
  /// Creates a collapsed lookup run.
  LookupGroupTranscriptDisplayEntry({required this.tools})
    : super(
        sourceIndices: List<int>.unmodifiable(
          tools.expand((tool) => tool.sourceIndices),
        ),
      );

  /// Lookup cards in canonical transcript order.
  final List<ToolTranscriptDisplayEntry> tools;
}

/// Projects canonical messages into D9 display rows.
///
/// The canonical list remains untouched. Final-only selection and lookup
/// grouping are display policy, not protocol decoding.
List<SessionTranscriptDisplayEntry> buildSessionTranscriptDisplayEntries({
  required List<AgentMessage> messages,
  required ToolDisplayMode mode,
}) {
  if (mode == ToolDisplayMode.finalMessagesOnly) {
    return _buildFinalOnlyEntries(messages);
  }

  final pairing = _ToolPairing.fromMessages(messages);

  final entries = <SessionTranscriptDisplayEntry>[];
  var index = 0;
  while (index < messages.length) {
    final message = messages[index];
    // `permission-resolved` / `question-resolved` are request-state
    // transitions, not standalone Chat content: the matching request card
    // (deactivated by canonical request id) shows the compact outcome, and an
    // orphan resolution — an older broker or a replayed cache — must be
    // invisible here. The canonical list is untouched, so Debug/persistence/
    // attention still see every frame (CR2).
    if (_isRequestResolutionMessage(message)) {
      index += 1;
      continue;
    }
    if (!_isToolMessage(message)) {
      entries.add(
        MessageTranscriptDisplayEntry(
          message: message,
          sourceIndex: index,
        ),
      );
      index += 1;
      continue;
    }

    // A result already folded into an earlier call's card must not render a
    // second time.
    if (pairing.isClaimedResult(index)) {
      index += 1;
      continue;
    }

    final first = _consumeToolCard(messages, index, pairing);
    if (first.entry.displayClass != ToolDisplayClass.lookup) {
      entries.add(first.entry);
      index = first.nextIndex;
      continue;
    }

    final run = <ToolTranscriptDisplayEntry>[first.entry];
    index = first.nextIndex;
    while (index < messages.length && _isToolMessage(messages[index])) {
      if (pairing.isClaimedResult(index)) {
        index += 1;
        continue;
      }
      final next = _consumeToolCard(messages, index, pairing);
      if (next.entry.displayClass != ToolDisplayClass.lookup) break;
      run.add(next.entry);
      index = next.nextIndex;
    }

    if (run.length >= 2) {
      entries.add(
        LookupGroupTranscriptDisplayEntry(
          tools: List<ToolTranscriptDisplayEntry>.unmodifiable(run),
        ),
      );
    } else {
      entries.add(run.single);
    }
  }

  return List<SessionTranscriptDisplayEntry>.unmodifiable(entries);
}

List<SessionTranscriptDisplayEntry> _buildFinalOnlyEntries(
  List<AgentMessage> messages,
) {
  final lastAssistantByTurn = <int, int>{};
  var turn = -1;
  for (var index = 0; index < messages.length; index++) {
    final message = messages[index];
    if (_isDeliveredUserMessage(message)) {
      turn += 1;
    } else if (message.type == AgentMessageType.modelOutput && turn >= 0) {
      lastAssistantByTurn[turn] = index;
    }
  }
  final finalAssistantIndices = lastAssistantByTurn.values.toSet();

  return List<SessionTranscriptDisplayEntry>.unmodifiable([
    for (var index = 0; index < messages.length; index++)
      if (_isFinalOnlyAlwaysVisible(messages[index]) ||
          finalAssistantIndices.contains(index))
        MessageTranscriptDisplayEntry(
          message: messages[index],
          sourceIndex: index,
        ),
  ]);
}

/// Whether [message] is a request-state transition frame that must never
/// render as a standalone clean-Chat row (Responsive or Final-only alike).
bool _isRequestResolutionMessage(AgentMessage message) =>
    message.type == AgentMessageType.permissionResolved ||
    message.type == AgentMessageType.questionResolved;

bool _isFinalOnlyAlwaysVisible(AgentMessage message) => switch (message.type) {
  AgentMessageType.userMessage ||
  AgentMessageType.permissionRequest ||
  AgentMessageType.questionRequest ||
  AgentMessageType.fileArtifact ||
  AgentMessageType.notice ||
  AgentMessageType.historyReset ||
  AgentMessageType.error ||
  AgentMessageType.unknown => true,
  _ => false,
};

bool _isDeliveredUserMessage(AgentMessage message) =>
    message.type == AgentMessageType.userMessage && !message.userMessageQueued;

bool _isToolMessage(AgentMessage message) =>
    message.type == AgentMessageType.toolCall ||
    message.type == AgentMessageType.toolResult;

/// Resolves which tool-result frame belongs to which tool-call frame.
///
/// A call and its result are frequently separated by other frames (interleaved
/// thinking, model output, or concurrent tool calls), so adjacency is not a
/// usable pairing signal. Matching on `toolCallId` collapses one invocation to
/// one card. Calls with no result (still running) and results with no call
/// (truncated history) both stay renderable on their own.
final class _ToolPairing {
  const _ToolPairing._(this._resultIndexByCallIndex, this._claimedResults);

  factory _ToolPairing.fromMessages(List<AgentMessage> messages) {
    // Results keyed by call id, in arrival order, so repeated ids pair
    // first-call-to-first-result instead of collapsing onto one another.
    final resultIndicesByCallId = <String, List<int>>{};
    for (var index = 0; index < messages.length; index++) {
      final message = messages[index];
      if (message.type != AgentMessageType.toolResult) continue;
      final callId = message.toolCallId;
      if (callId == null || callId.isEmpty) continue;
      resultIndicesByCallId.putIfAbsent(callId, () => <int>[]).add(index);
    }

    final resultIndexByCallIndex = <int, int>{};
    final claimedResults = <int>{};
    final nextCandidate = <String, int>{};
    for (var index = 0; index < messages.length; index++) {
      final message = messages[index];
      if (message.type != AgentMessageType.toolCall) continue;
      final callId = message.toolCallId;
      if (callId == null || callId.isEmpty) continue;
      final candidates = resultIndicesByCallId[callId];
      if (candidates == null) continue;

      // Take the first not-yet-claimed result that arrived after this call.
      var cursor = nextCandidate[callId] ?? 0;
      while (cursor < candidates.length && candidates[cursor] < index) {
        cursor++;
      }
      if (cursor >= candidates.length) continue;
      final resultIndex = candidates[cursor];
      nextCandidate[callId] = cursor + 1;
      resultIndexByCallIndex[index] = resultIndex;
      claimedResults.add(resultIndex);
    }

    return _ToolPairing._(
      Map<int, int>.unmodifiable(resultIndexByCallIndex),
      Set<int>.unmodifiable(claimedResults),
    );
  }

  final Map<int, int> _resultIndexByCallIndex;
  final Set<int> _claimedResults;

  /// Index of the result paired with the call at [callIndex], when present.
  int? resultIndexFor(int callIndex) => _resultIndexByCallIndex[callIndex];

  /// Whether the frame at [index] is a result already folded into a call card.
  bool isClaimedResult(int index) => _claimedResults.contains(index);
}

_ConsumedToolCard _consumeToolCard(
  List<AgentMessage> messages,
  int index,
  _ToolPairing pairing,
) {
  final first = messages[index];

  // An unclaimed result: its call fell outside the retained history window.
  if (first.type != AgentMessageType.toolCall) {
    return _ConsumedToolCard(
      entry: ToolTranscriptDisplayEntry(
        call: null,
        result: first,
        sourceIndices: List<int>.unmodifiable([index]),
      ),
      nextIndex: index + 1,
    );
  }

  final resultIndex = pairing.resultIndexFor(index);
  if (resultIndex != null) {
    final sourceIndices = <int>[index, resultIndex]..sort();
    return _ConsumedToolCard(
      entry: ToolTranscriptDisplayEntry(
        call: first,
        result: messages[resultIndex],
        sourceIndices: List<int>.unmodifiable(sourceIndices),
      ),
      // Advance past the call only. A result living further down the list is
      // skipped in place by the claimed-result check.
      nextIndex: index + 1,
    );
  }

  // A call still running, or whose result never arrived.
  return _ConsumedToolCard(
    entry: ToolTranscriptDisplayEntry(
      call: first,
      result: null,
      sourceIndices: List<int>.unmodifiable([index]),
    ),
    nextIndex: index + 1,
  );
}

final class _ConsumedToolCard {
  const _ConsumedToolCard({required this.entry, required this.nextIndex});

  final ToolTranscriptDisplayEntry entry;
  final int nextIndex;
}
