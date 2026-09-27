import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:flutter_test/flutter_test.dart';

const requestId = 'codex:aq:pending';

AgentMessage question({required bool readOnly}) => AgentMessage.fromJson({
  'type': 'question-request',
  'requestId': requestId,
  'blocking': false,
  if (readOnly) 'readOnly': true,
  'questions': [
    {
      'question': 'Which branch?',
      'options': [
        {'label': 'main'},
        {'label': 'dev'},
      ],
    },
  ],
});

AgentMessage resolution() => AgentMessage.fromJson({
  'type': 'question-resolved',
  'requestId': requestId,
});

TranscriptHistoryWindow initialWindow() => TranscriptHistoryWindow.fromHistory(
  HistoryWireEvent(
    messages: [question(readOnly: true)],
    reset: true,
    cursor: 'initial',
    olderCursor: 'older',
    hasEarlier: true,
  ),
);

/// The reader keeps the card on screen: live growth may release anything
/// but the page holding it.
final String? readingCard = stableTranscriptMessageKey(
  question(readOnly: false),
);

TranscriptHistoryWindow evictTail(
  TranscriptHistoryWindow initial, {
  String? reading,
}) {
  var window = initial;
  // Enough live rows to push everything unprotected out of the budget.
  for (var i = 0; i < kMaxActiveTranscriptMessages; i++) {
    window = window.applyLiveMessage(
      AgentMessage.fromJson({
        'type': 'model-output',
        'key': 'message-$i',
        'text': 'Still working: $i',
        'final': true,
      }),
      protectedKey: reading,
    );
  }
  return window;
}

TranscriptHistoryWindow pageQuestion(TranscriptHistoryWindow window) {
  final mutation = window.prependPage(
    HistoryPageWireEvent(
      messages: [question(readOnly: true)],
      hasMore: false,
      endOfHistory: true,
    ),
    requestedCursor: 'older',
  );
  expect(mutation.accepted, isTrue);
  return mutation.window;
}

void expectReadOnly(TranscriptHistoryWindow window, {required bool readOnly}) {
  final card = window.canonicalMessages.singleWhere(
    (m) => m.type == AgentMessageType.questionRequest,
  );
  expect(card.requestIsReadOnly, readOnly);
  // The production renderer uses cached page/run projections, not canonicalMessages.
  final rendered = window
      .transcriptConversationSegmentsWith(
        const [],
        const {},
        mode: ToolDisplayMode.responsive,
      )
      .expand((s) => s.turns)
      .expand((t) => t.content)
      .whereType<MessageTranscriptDisplayEntry>()
      .map((entry) => entry.message)
      .where((m) => m.type == AgentMessageType.questionRequest);
  expect(rendered, isNotEmpty);
  expect(rendered.map((m) => m.requestIsReadOnly), everyElement(readOnly));
}

void main() {
  test(
    'unanswered async card is never evicted, and stays actionable through '
    'paging',
    () {
      final live = initialWindow().applyLiveMessage(question(readOnly: false));
      final evicted = evictTail(live);
      // Live growth releases the rows after it instead: it is the only place
      // the reader can answer it.
      expectReadOnly(evicted, readOnly: false);
      expect(evicted.pages.last.headReleased, isTrue);
      expectReadOnly(pageQuestion(evicted), readOnly: false);
      // Immutable prior snapshots do not acquire the newer live authority.
      expectReadOnly(initialWindow(), readOnly: true);
    },
  );

  test(
    'read-only reconnect delta cannot revoke pending question authority',
    () {
      var window = initialWindow().applyLiveMessage(question(readOnly: false));
      window = evictTail(window).applyHistory(
        HistoryWireEvent(
          messages: [question(readOnly: true)],
          cursor: 'later',
        ),
      );
      expectReadOnly(window, readOnly: false);
    },
  );

  test('pending replay updates an already loaded browsing page', () {
    var window = pageQuestion(evictTail(initialWindow()));
    expectReadOnly(
      window,
      readOnly: true,
    ); // Prime the production page/run caches.
    window = window.applyLiveMessage(question(readOnly: false));
    window = evictTail(window, reading: readingCard);
    expectReadOnly(window, readOnly: false);
  });

  test('settlement survives eviction and disables an already loaded card', () {
    var window = pageQuestion(
      evictTail(
        initialWindow().applyLiveMessage(question(readOnly: false)),
      ),
    );
    expectReadOnly(window, readOnly: false);
    window = evictTail(
      window.applyLiveMessage(resolution(), protectedKey: readingCard),
      reading: readingCard,
    );
    expectReadOnly(window, readOnly: true);
    expect(window.resolvedRequestDecisions.containsKey(requestId), isTrue);
    // A duplicate live item cannot reopen a settled card.
    expectReadOnly(
      window.applyLiveMessage(question(readOnly: false)),
      readOnly: true,
    );
  });

  test('answer received while card is evicted prevents revival on paging', () {
    var window = evictTail(
      initialWindow().applyLiveMessage(question(readOnly: false)),
    );
    window = evictTail(window.applyLiveMessage(resolution()));
    expectReadOnly(pageQuestion(window), readOnly: true);
    expect(window.resolvedRequestDecisions.containsKey(requestId), isTrue);
  });

  test('reset clears old authority, including a protected browsing page', () {
    final old = pageQuestion(
      evictTail(
        initialWindow().applyLiveMessage(question(readOnly: false)),
      ),
    );
    final key = stableTranscriptMessageKey(question(readOnly: false))!;
    final reset = old.applyHistory(
      HistoryWireEvent(
        reset: true,
        cursor: 'replacement',
        messages: [
          AgentMessage.fromJson({
            'type': 'model-output',
            'key': 'replacement',
            'text': 'New connection',
          }),
        ],
      ),
      preserveMessageKey: key,
    );
    expectReadOnly(reset, readOnly: true);
    expectReadOnly(
      reset.applyLiveMessage(question(readOnly: false)),
      readOnly: false,
    );
    // The old immutable window keeps its own authority.
    expectReadOnly(old, readOnly: false);
    final fresh = old.applyHistory(
      const HistoryWireEvent(
        reset: true,
        cursor: 'replacement',
        olderCursor: 'older',
        messages: [],
      ),
    );
    expectReadOnly(pageQuestion(fresh), readOnly: true);
  });
}
