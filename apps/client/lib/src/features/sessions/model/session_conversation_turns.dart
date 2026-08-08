import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/model/tool_display_mode.dart';
import 'package:flutter/foundation.dart';

/// Display-only projection of canonical messages into conversation turns.
///
/// This is a presentation reduction on top of the canonical transcript. It
/// deletes no canonical frame: Debug, persistence, state folding, request
/// actions, and telemetry continue to read the untouched message list. A turn
/// is a display grouping only.
///
/// A turn opens on each *delivered* user message. A queued optimistic prompt
/// stays a visible user row inside the current turn but never opens one, so a
/// prompt typed while a turn is still running cannot steal that turn's output.
/// `status` and `run-summary` frames leave Chat here — status keeps driving the
/// header/roster/Status surfaces and a completed run summary is attached to its
/// turn as [ConversationTurn.runSummary] rather than rendered as a row.

/// Canonical completion status of a turn's run summary.
enum ConversationRunStatus {
  /// The turn is still running; it never renders a chat footer.
  running('running'),

  /// The turn completed normally.
  done('done'),

  /// The turn ended in an error.
  error('error'),

  /// The turn was cancelled/interrupted.
  cancelled('cancelled'),

  /// A missing or future status value.
  unknown('unknown');

  const ConversationRunStatus(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Parses a current or future broker value without throwing.
  static ConversationRunStatus fromWire(String? value) => switch (value) {
    'running' => ConversationRunStatus.running,
    'done' => ConversationRunStatus.done,
    'error' => ConversationRunStatus.error,
    'cancelled' => ConversationRunStatus.cancelled,
    _ => ConversationRunStatus.unknown,
  };
}

/// One reported child run (subagent/workflow/job) inside a turn's run summary.
@immutable
final class ConversationRunChild {
  /// Creates a typed child run.
  const ConversationRunChild({
    required this.id,
    this.title,
    this.kind,
    this.status,
    this.runtimeMs,
    this.tokenTotal,
  });

  /// Native child identity.
  final String id;

  /// User-facing child label, when reported.
  final String? title;

  /// Child kind (`subagent`, `workflow`, `job`), when reported.
  final String? kind;

  /// Child completion status, when reported.
  final String? status;

  /// Child runtime in milliseconds, when reported.
  final int? runtimeMs;

  /// Sum of the child's token buckets, when any were reported.
  final int? tokenTotal;
}

/// Typed per-turn telemetry projected from the associated `run-summary` frame.
///
/// This is a completed snapshot only: a running summary feeds live status and
/// is never attached here. Fields the adapter did not report stay `null`; the
/// UI shows only attributable values and never substitutes a session total.
@immutable
final class ConversationTurnRunSummary {
  /// Creates a typed run-summary snapshot.
  const ConversationTurnRunSummary({
    required this.status,
    this.startedAt,
    this.completedAt,
    this.totalRuntimeMs,
    this.agentRuntimeMs,
    this.executionRuntimeMs,
    this.inputTokens,
    this.outputTokens,
    this.cacheReadTokens,
    this.cacheWriteTokens,
    this.cost,
    this.children = const [],
  });

  /// Decodes a `run-summary` message, returning `null` for another type.
  static ConversationTurnRunSummary? fromMessage(AgentMessage message) {
    if (message.type != AgentMessageType.runSummary) return null;
    final tokens = _asMap(message.raw['tokens']);
    return ConversationTurnRunSummary(
      status: ConversationRunStatus.fromWire(
        _stringField(message.raw['status']),
      ),
      startedAt: _nonNegativeInt(message.raw['startedAt']),
      completedAt: _nonNegativeInt(message.raw['completedAt']),
      totalRuntimeMs: _nonNegativeInt(message.raw['totalRuntimeMs']),
      agentRuntimeMs: _nonNegativeInt(message.raw['agentRuntimeMs']),
      executionRuntimeMs: _nonNegativeInt(message.raw['executionRuntimeMs']),
      inputTokens: _nonNegativeInt(tokens['input']),
      outputTokens: _nonNegativeInt(tokens['output']),
      cacheReadTokens: _nonNegativeInt(tokens['cacheRead']),
      cacheWriteTokens: _nonNegativeInt(tokens['cacheWrite']),
      cost:
          _positiveDouble(tokens['cost']) ??
          _positiveDouble(message.raw['cost']),
      children: _parseChildren(message.raw['children']),
    );
  }

  /// Canonical completion status.
  final ConversationRunStatus status;

  /// Authoritative start time in epoch milliseconds.
  final int? startedAt;

  /// Authoritative completion time in epoch milliseconds.
  final int? completedAt;

  /// Total wall-clock runtime for the turn in milliseconds.
  final int? totalRuntimeMs;

  /// Agent-side runtime in milliseconds.
  final int? agentRuntimeMs;

  /// Execution-side runtime in milliseconds.
  final int? executionRuntimeMs;

  /// Prompt tokens for the turn.
  final int? inputTokens;

  /// Completion tokens for the turn.
  final int? outputTokens;

  /// Cache-read tokens for the turn.
  final int? cacheReadTokens;

  /// Cache-write tokens for the turn.
  final int? cacheWriteTokens;

  /// Reported cost in USD, when the adapter supplies one.
  final double? cost;

  /// Reported child runs for the turn.
  final List<ConversationRunChild> children;

  /// Sum of every reported token bucket, or `null` when none were reported.
  int? get totalTokens {
    final parts = [
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    ].whereType<int>();
    if (parts.isEmpty) return null;
    return parts.fold<int>(0, (sum, value) => sum + value);
  }

  /// Whether any token bucket was reported.
  bool get hasTokens => totalTokens != null;

  /// Whether a completed footer (`Ran for … · Finished at …`) can be shown.
  ///
  /// Requires at least one of the two authoritative footer fields; a bare
  /// status with no runtime and no completion time renders no footer line.
  bool get hasFooterMetadata => totalRuntimeMs != null || completedAt != null;
}

/// One projected conversation turn.
@immutable
final class ConversationTurn {
  /// Creates a projected turn.
  const ConversationTurn({
    required this.index,
    required this.turnKey,
    required this.userMessage,
    required this.content,
    required this.modelText,
    required this.distinctToolCallCount,
    required this.isPartial,
    this.runSummary,
  });

  /// Ordinal position of this turn in the transcript, from 0.
  final int index;

  /// Stable display identity for this turn.
  ///
  /// Derived from the opening user message's key/id when present, so it
  /// survives older-page prepends and live growth; a truncated leading turn
  /// falls back to its first content row's identity.
  final String turnKey;

  /// The delivered user message that opened this turn.
  ///
  /// `null` for a truncated leading turn whose opening prompt fell outside the
  /// retained history window ([isPartial] is then true).
  final AgentMessage? userMessage;

  /// Ordered display rows for the turn's model output, thinking, tools, agent
  /// activity, requests, errors, notices, artifacts, and queued user prompts.
  ///
  /// Built with the shared tool pairing/lookup grouping and filtered by the
  /// active [ToolDisplayMode]. The opening [userMessage] is not included here;
  /// queued user prompts are.
  final List<SessionTranscriptDisplayEntry> content;

  /// Every visible model-output segment for the turn, in canonical order,
  /// joined with a blank line.
  ///
  /// This is the single source for turn-level Copy and Read aloud. It excludes
  /// thinking, tool output, status, and internal metadata, and it is computed
  /// from the raw turn regardless of [ToolDisplayMode] so a model preamble that
  /// preceded a tool call is never silently dropped.
  final String modelText;

  /// Count of distinct canonical tool-call invocations assigned to this turn.
  ///
  /// Counted by stable `callId` with a message-key fallback; a result, a
  /// streamed update, and a replay duplicate are never counted as another call.
  final int distinctToolCallCount;

  /// Whether this turn's opening prompt is missing because history was
  /// truncated. Such a turn is labelled partial in telemetry.
  final bool isPartial;

  /// Completed run summary associated with this turn, or `null`.
  ///
  /// Only a non-running summary is attached, and only when it associates to
  /// this turn without guessing. A late or replayed summary updates it in
  /// place.
  final ConversationTurnRunSummary? runSummary;

  /// Whether the turn produced model output eligible for Copy/Read aloud.
  bool get hasModelText => modelText.isNotEmpty;
}

/// Projects [messages] into display-only conversation turns.
///
/// The canonical list is untouched. `status` frames are dropped from Chat and
/// `run-summary` frames are attached to their turn instead of rendered.
List<ConversationTurn> buildConversationTurns({
  required List<AgentMessage> messages,
  required ToolDisplayMode mode,
}) {
  // A queued prompt delivered mid-turn is re-emitted in place at its queued
  // position; correct that here so it does not open its turn early and steal
  // the running turn's output.
  final ordered = _reorderDeliveredPrompts(messages);

  final segments = <_TurnSegment>[];
  final runSummaryMessages = <AgentMessage>[];
  _TurnSegment? current;

  _TurnSegment openTurn(AgentMessage? opener) {
    final segment = _TurnSegment(opener);
    segments.add(segment);
    return segment;
  }

  for (final message in ordered) {
    switch (message.type) {
      case AgentMessageType.status:
        // Status ticks leave Chat; live status has its own header/roster chrome.
        continue;
      case AgentMessageType.runSummary:
        // Held for by-key association; never a visible chat row.
        runSummaryMessages.add(message);
        continue;
      case AgentMessageType.userMessage when !message.userMessageQueued:
        current = openTurn(message);
      case _:
        current ??= openTurn(null);
        current.content.add(message);
    }
  }

  // Index the turns so a run summary can find its turn by key without guessing.
  final turnByAssistantKey = <String, int>{};
  final turnByUserKey = <String, int>{};
  final turnByTurnId = <String, int>{};
  for (var index = 0; index < segments.length; index++) {
    final segment = segments[index];
    final userKey = segment.opener?.userMessageKey;
    if (userKey != null) turnByUserKey[userKey] = index;
    final turnId = _stringField(segment.opener?.raw['turnId']);
    if (turnId != null) turnByTurnId[turnId] = index;
    for (final message in segment.content) {
      if (message.type != AgentMessageType.modelOutput) continue;
      final key = message.modelOutputKey;
      if (key != null && key.isNotEmpty) turnByAssistantKey[key] = index;
    }
  }

  final summaryByTurn = <int, ConversationTurnRunSummary>{};
  for (final message in runSummaryMessages) {
    final summary = ConversationTurnRunSummary.fromMessage(message);
    if (summary == null || summary.status == ConversationRunStatus.running) {
      continue;
    }
    final assistantKey = _stringField(message.raw['assistantMessageKey']);
    final userKey = _stringField(message.raw['userMessageKey']);
    final turnId = _stringField(message.raw['turnId']);
    final turnIndex =
        (assistantKey == null ? null : turnByAssistantKey[assistantKey]) ??
        (userKey == null ? null : turnByUserKey[userKey]) ??
        (turnId == null ? null : turnByTurnId[turnId]);
    // Ambiguous association is omitted rather than misattributed.
    if (turnIndex == null) continue;
    // Later frames win, so a replayed/late summary updates the same footer.
    summaryByTurn[turnIndex] = summary;
  }

  final turns = <ConversationTurn>[
    for (var index = 0; index < segments.length; index++)
      ConversationTurn(
        index: index,
        turnKey: _turnKey(segments[index], index),
        userMessage: segments[index].opener,
        content: _buildTurnContent(segments[index].content, mode),
        modelText: _modelTextAggregate(segments[index].content),
        distinctToolCallCount: _distinctToolCallCount(segments[index].content),
        isPartial:
            segments[index].opener == null &&
            segments[index].content.isNotEmpty,
        runSummary: summaryByTurn[index],
      ),
  ];
  return List<ConversationTurn>.unmodifiable(turns);
}

/// Corrects the display position of a queued prompt that was delivered
/// mid-turn.
///
/// The broker re-emits a delivered prompt in place at its queued position
/// (a deliberate state-layer behaviour), so a prompt typed while the previous
/// turn was still running can sit *before* that turn's later output.
///
/// The anchor is the *earlier* prompt's ownership, not this prompt's own
/// answer: adapters (e.g. Codex) only publish a turn's `assistantMessageKey`
/// once the run finishes, so a still-streaming answer has no owner yet. Using
/// the run summaries' `assistantMessageKey → userMessageKey` linkage, a
/// delivered prompt is moved to just after the last output owned by an
/// *earlier* prompt; a no-owner output that follows earlier-owned content is
/// treated as this prompt's own streaming answer and left in place. Two prompts
/// queued in one running turn are both handled. Display-only; the canonical
/// list is never mutated.
List<AgentMessage> _reorderDeliveredPrompts(List<AgentMessage> messages) {
  // A terminal summary can prove ownership even when the interrupted turn
  // emitted no assistant text. Repair those exact boundaries first: every
  // delivered prompt between the owning opener and its interruption arrived
  // after that opener and belongs below the marker. This is what keeps a
  // prompt/stop cycle correct live, before refresh supplies any rollout text.
  final userByTurnId = <String, String>{};
  final sourcePromptKeys = <String>{
    for (final message in messages)
      if (message.type == AgentMessageType.userMessage &&
          !message.userMessageQueued &&
          message.userMessageKey != null)
        message.userMessageKey!,
  };
  for (final message in messages) {
    if (message.type != AgentMessageType.runSummary) continue;
    final turnId = _stringField(message.raw['turnId']);
    final userKey = _stringField(message.raw['userMessageKey']);
    final assistantKey = _stringField(message.raw['assistantMessageKey']);
    if (turnId != null &&
        userKey != null &&
        assistantKey == null &&
        sourcePromptKeys.contains(userKey)) {
      userByTurnId[turnId] = userKey;
    }
  }

  final result = List<AgentMessage>.of(messages);
  for (var markerIndex = 0; markerIndex < result.length; markerIndex++) {
    final marker = result[markerIndex];
    if (marker.transcriptNoticeSemanticKind !=
        TranscriptNoticeSemanticKind.interruption) {
      continue;
    }
    final markerTurnId = marker.transcriptInterruptionTurnId;
    final ownerKey = markerTurnId == null ? null : userByTurnId[markerTurnId];
    if (ownerKey == null) continue;
    final ownerIndex = result.indexWhere(
      (message) =>
          message.type == AgentMessageType.userMessage &&
          !message.userMessageQueued &&
          message.userMessageKey == ownerKey,
    );
    if (ownerIndex < 0 || ownerIndex >= markerIndex) continue;

    final firstDisplacedIndex = result.indexWhere(
      (message) =>
          message.type == AgentMessageType.userMessage &&
          !message.userMessageQueued,
      ownerIndex + 1,
    );
    if (firstDisplacedIndex < 0 || firstDisplacedIndex >= markerIndex) continue;
    // With no assistant output owned by the interrupted turn, the later
    // prompt and everything it emitted before the late terminal marker form
    // one block. Move generic notices and prompt-triggered compaction with the
    // prompt; moving only its bubble would fix the boundary while silently
    // assigning those rows to the interrupted turn.
    final displaced = result.sublist(firstDisplacedIndex, markerIndex);
    result.removeRange(firstDisplacedIndex, markerIndex);
    markerIndex = firstDisplacedIndex;
    result.insertAll(markerIndex + 1, displaced);
  }

  final presentPromptKeys = <String>{};
  final presentAssistantKeys = <String>{};
  for (final message in result) {
    switch (message.type) {
      case AgentMessageType.userMessage when !message.userMessageQueued:
        final key = message.userMessageKey;
        if (key != null) presentPromptKeys.add(key);
      case AgentMessageType.modelOutput:
        final key = message.modelOutputKey;
        if (key != null && key.isNotEmpty) presentAssistantKeys.add(key);
      case _:
        break;
    }
  }

  final ownerByAssistantKey = <String, String>{};
  final turnByAssistantKey = <String, String?>{};
  for (final message in result) {
    if (message.type != AgentMessageType.runSummary) continue;
    final assistant = _stringField(message.raw['assistantMessageKey']);
    final user = _stringField(message.raw['userMessageKey']);
    if (assistant == null || user == null) continue;
    // Only summaries that describe output actually on screen take part; an
    // older turn whose answer fell outside the retained window cannot decide
    // where a visible prompt belongs.
    if (!presentAssistantKeys.contains(assistant)) continue;
    // Fail closed (CR4b). A summary that names an owner no rendered prompt
    // carries means the transcript and the summaries disagree about prompt
    // identity — which is exactly what a mixed live/replay Codex transcript
    // used to produce. The scan below can then never reach "this prompt's own
    // answer", so every owned answer downstream reads as an earlier turn's and
    // the prompt is dragged below its own reply. Without a coherent ownership
    // graph, move nothing.
    if (!presentPromptKeys.contains(user)) {
      return List<AgentMessage>.unmodifiable(result);
    }
    ownerByAssistantKey[assistant] = user;
    turnByAssistantKey[assistant] = _stringField(message.raw['turnId']);
  }
  if (ownerByAssistantKey.isEmpty) {
    return List<AgentMessage>.unmodifiable(result);
  }
  for (var i = 0; i < result.length; i++) {
    final prompt = result[i];
    if (prompt.type != AgentMessageType.userMessage ||
        prompt.userMessageQueued) {
      continue;
    }
    final promptKey = prompt.userMessageKey;
    if (promptKey == null) continue;
    final promptTurnId = _stringField(prompt.raw['turnId']);

    int? lastEarlierOwned;
    int? lastEarlierTerminalMarker;
    var sawEarlierOwned = false;
    String? lastEarlierTurnId;
    // A later delivered prompt is not a boundary: two prompts queued mid-turn
    // both sit before this turn's output, so scan through them to the earlier
    // turn's real end.
    for (var j = i + 1; j < result.length; j++) {
      final message = result[j];
      if (sawEarlierOwned &&
          message.transcriptNoticeSemanticKind ==
              TranscriptNoticeSemanticKind.interruption) {
        final markerTurnId = message.transcriptInterruptionTurnId;
        // A structured interruption can extend only the immediately preceding
        // owned turn. When both sides publish native ownership, it must match.
        // Generic notices and every history-reset remain ordinary content.
        if (markerTurnId == null ||
            (lastEarlierTurnId != null && markerTurnId == lastEarlierTurnId)) {
          lastEarlierTerminalMarker = j;
        }
        continue;
      }
      if (message.type != AgentMessageType.modelOutput) continue;
      final owner = ownerByAssistantKey[message.modelOutputKey];
      if (owner == promptKey) break; // this prompt's own answer begins here
      if (owner != null) {
        final ownerTurnId = turnByAssistantKey[message.modelOutputKey];
        // An exact native turn id proves this is a steer boundary inside the
        // same turn, not a queued next-turn prompt sitting above an earlier
        // answer. Preserve canonical input order verbatim. Wall-clock fields
        // never participate, and the C1R repair remains available when either
        // side lacks exact native turn identity.
        if (promptTurnId != null && ownerTurnId == promptTurnId) break;
        lastEarlierOwned = j;
        sawEarlierOwned = true;
        lastEarlierTurnId = ownerTurnId;
        lastEarlierTerminalMarker = null;
      } else if (sawEarlierOwned) {
        // A no-owner output after earlier-owned content is this prompt's own
        // still-streaming answer; stop before it (do not move past it).
        break;
      }
    }
    if (lastEarlierOwned == null) continue; // not misplaced

    // After removal, indices above `i` shift down by one, so inserting at the
    // original boundary places the prompt just after that content.
    final insertionBoundary = lastEarlierTerminalMarker ?? lastEarlierOwned;
    result
      ..removeAt(i)
      ..insert(insertionBoundary, prompt);
    // Re-examine the slot that the following message shifted into.
    i -= 1;
  }
  return List<AgentMessage>.unmodifiable(result);
}

/// Mutable per-turn accumulator used only while projecting.
class _TurnSegment {
  _TurnSegment(this.opener);

  final AgentMessage? opener;
  final List<AgentMessage> content = [];
}

List<SessionTranscriptDisplayEntry> _buildTurnContent(
  List<AgentMessage> content,
  ToolDisplayMode mode,
) {
  // Reuse the shared pairing + lookup grouping. Responsive builds the full row
  // set; final-only is applied per turn below because the shared builder's
  // turn detection keys off delivered user messages, which never appear inside
  // a single turn's content list.
  final entries = buildSessionTranscriptDisplayEntries(
    messages: content,
    mode: ToolDisplayMode.responsive,
  );
  if (mode != ToolDisplayMode.finalMessagesOnly) return entries;

  int? lastModelOutput;
  for (var index = 0; index < entries.length; index++) {
    final entry = entries[index];
    if (entry is MessageTranscriptDisplayEntry &&
        entry.message.type == AgentMessageType.modelOutput) {
      lastModelOutput = index;
    }
  }

  return List<SessionTranscriptDisplayEntry>.unmodifiable([
    for (var index = 0; index < entries.length; index++)
      if (entries[index] case final MessageTranscriptDisplayEntry entry)
        if (entry.message.type == AgentMessageType.modelOutput
            ? index == lastModelOutput
            : _isFinalOnlyAlwaysVisibleType(entry.message.type))
          entry,
  ]);
}

// `permission-resolved` / `question-resolved` are deliberately absent: a
// resolution is a request-state transition folded into its request card, never
// a standalone Chat row (CR2). The canonical list keeps every frame for
// Debug/persistence/attention.
bool _isFinalOnlyAlwaysVisibleType(AgentMessageType type) => switch (type) {
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

String _modelTextAggregate(List<AgentMessage> content) {
  final segments = <String>[];
  for (final message in content) {
    if (message.type != AgentMessageType.modelOutput) continue;
    // Only completed (`final: true`) segments are speakable/copyable — a
    // still-streaming partial would otherwise be spoken or copied and never
    // update. This is the same finality rule the read-aloud path already uses.
    if (!message.modelOutputFinal) continue;
    final text = message.modelOutputText?.trim();
    if (text == null || text.isEmpty) continue;
    segments.add(text);
  }
  return segments.join('\n\n');
}

int _distinctToolCallCount(List<AgentMessage> content) {
  final seen = <String>{};
  var anonymous = 0;
  for (final message in content) {
    if (message.type != AgentMessageType.toolCall) continue;
    final callId = message.toolCallId;
    if (callId != null) {
      seen.add('call:$callId');
      continue;
    }
    final id = message.id;
    if (id != null && id.isNotEmpty) {
      seen.add('id:$id');
      continue;
    }
    final seq = message.seq;
    if (seq != null) {
      seen.add('seq:$seq');
      continue;
    }
    anonymous++;
  }
  return seen.length + anonymous;
}

String _turnKey(_TurnSegment segment, int index) {
  final opener = segment.opener;
  if (opener != null) {
    // The send correlation token survives the optimistic → delivered swap of
    // an app-sent opener, so the turn (and its footer) keeps one identity.
    final clientKey = opener.userMessageClientKey;
    if (clientKey != null) return 'turn:user-send:$clientKey';
    final key = opener.userMessageKey ?? opener.id;
    if (key != null && key.isNotEmpty) return 'turn:user:$key';
    final seq = opener.seq;
    if (seq != null) return 'turn:user-seq:$seq';
  }
  if (segment.content.isNotEmpty) {
    final first = segment.content.first;
    final id = first.id;
    if (id != null && id.isNotEmpty) return 'turn:lead:$id';
    final seq = first.seq;
    if (seq != null) return 'turn:lead-seq:$seq';
  }
  return 'turn:ord:$index';
}

List<ConversationRunChild> _parseChildren(Object? value) {
  if (value is! Iterable) return const [];
  final children = <ConversationRunChild>[];
  for (final item in value) {
    if (item is! Map) continue;
    final id = _stringField(item['id']);
    if (id == null) continue;
    final tokens = _asMap(item['tokens']);
    final tokenParts = [
      _nonNegativeInt(tokens['input']),
      _nonNegativeInt(tokens['output']),
      _nonNegativeInt(tokens['cacheRead']),
      _nonNegativeInt(tokens['cacheWrite']),
    ].whereType<int>();
    children.add(
      ConversationRunChild(
        id: id,
        title: _stringField(item['title']),
        kind: _stringField(item['kind']),
        status: _stringField(item['status']),
        runtimeMs: _nonNegativeInt(item['runtimeMs']),
        tokenTotal: tokenParts.isEmpty
            ? null
            : tokenParts.fold<int>(0, (sum, value) => sum + value),
      ),
    );
  }
  return List<ConversationRunChild>.unmodifiable(children);
}

Map<String, dynamic> _asMap(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) {
    return <String, dynamic>{
      for (final entry in value.entries) '${entry.key}': entry.value,
    };
  }
  return const <String, dynamic>{};
}

String? _stringField(Object? value) {
  if (value is! String) return null;
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}

int? _nonNegativeInt(Object? value) {
  if (value is int) return value < 0 ? null : value;
  if (value is num) {
    if (!value.isFinite || value < 0) return null;
    return value.round();
  }
  return null;
}

double? _positiveDouble(Object? value) {
  if (value is num) {
    if (!value.isFinite || value < 0) return null;
    return value.toDouble();
  }
  return null;
}
