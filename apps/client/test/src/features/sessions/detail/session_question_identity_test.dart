import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:flutter_test/flutter_test.dart';

/// One Claude question, two copies under one id: the transcript's (Claude's
/// own `tool_use` id, read-only) and the card a synced terminal holds for the
/// app (the same id, answerable). The app must show one card.
const toolUseId = 'toolu_01QuestionIdentity';

AgentMessage transcriptCopy() => AgentMessage.fromJson({
  'type': 'question-request',
  'requestId': toolUseId,
  'readOnly': true,
  'questions': [
    {
      'question': 'Which colour?',
      'header': 'Colour',
      'multiple': false,
      'options': [
        {'label': 'Amber'},
        {'label': 'Teal'},
      ],
    },
  ],
});

AgentMessage heldCopy() => AgentMessage.fromJson({
  'type': 'question-request',
  'requestId': toolUseId,
  'questions': [
    {
      'question': 'Which colour?',
      'header': 'Colour',
      'options': [
        {'label': 'Amber'},
        {'label': 'Teal'},
      ],
      'multiple': false,
    },
  ],
});

AgentMessage resolved() => AgentMessage.fromJson({
  'type': 'question-resolved',
  'requestId': toolUseId,
});

TranscriptHistoryWindow attached(List<AgentMessage> history) =>
    TranscriptHistoryWindow.fromHistory(
      HistoryWireEvent(
        messages: [
          AgentMessage.fromJson({
            'type': 'user-message',
            'key': 'u-q',
            'text': 'ask me a colour',
          }),
          ...history,
        ],
        reset: true,
        cursor: 'attach',
      ),
    );

/// A reconnect's reset frame, the way the broker sends it: history first, then
/// every card still waiting.
TranscriptHistoryWindow reset(
  TranscriptHistoryWindow window,
  List<AgentMessage> history, {
  List<AgentMessage> stillWaiting = const [],
}) {
  var next = window.applyHistory(
    HistoryWireEvent(
      messages: [
        AgentMessage.fromJson({
          'type': 'user-message',
          'key': 'u-q',
          'text': 'ask me a colour',
        }),
        ...history,
      ],
      reset: true,
      cursor: 'reset',
    ),
  );
  for (final message in stillWaiting) {
    next = next.applyLiveMessage(message);
  }
  return next;
}

/// The question cards the transcript draws, as the production renderer reads
/// them.
List<AgentMessage> drawnCards(TranscriptHistoryWindow window) => window
    .transcriptConversationSegmentsWith(
      const [],
      const {},
      mode: ToolDisplayMode.responsive,
    )
    .expand((s) => s.turns)
    .expand((t) => t.content)
    .whereType<MessageTranscriptDisplayEntry>()
    .map((entry) => entry.message)
    .where((m) => m.type == AgentMessageType.questionRequest)
    .toList();

void expectOneCard(
  TranscriptHistoryWindow window, {
  required bool answerable,
  required bool settled,
}) {
  final cards = drawnCards(window);
  expect(cards, hasLength(1), reason: 'one question, one card');
  expect(cards.single.raw['requestId'], toolUseId);
  expect(cards.single.requestIsReadOnly, !answerable);
  expect(window.resolvedRequestDecisions.containsKey(toolUseId), settled);
}

void main() {
  test("the transcript's copy first, then the held card: one card, answerable, "
      'then one settled card, through a history reset', () {
    var window = attached(const []).applyLiveMessage(transcriptCopy());
    window = window.applyLiveMessage(heldCopy());
    expectOneCard(window, answerable: true, settled: false);

    window = window.applyLiveMessage(resolved());
    expectOneCard(window, answerable: false, settled: true);

    window = reset(window, [transcriptCopy(), resolved()]);
    expectOneCard(window, answerable: false, settled: true);
  });

  test("the held card first, then the transcript's copy in a history reset: "
      'one card, answerable, then one settled card', () {
    var window = attached(const []).applyLiveMessage(heldCopy());
    expectOneCard(window, answerable: true, settled: false);

    // A reconnect while it is open: history carries the transcript's copy,
    // and the broker sends the card it is still holding after it.
    window = reset(window, [transcriptCopy()], stillWaiting: [heldCopy()]);
    expectOneCard(window, answerable: true, settled: false);

    window = window.applyLiveMessage(resolved());
    expectOneCard(window, answerable: false, settled: true);

    window = reset(window, [transcriptCopy(), resolved()]);
    expectOneCard(window, answerable: false, settled: true);
  });
}
