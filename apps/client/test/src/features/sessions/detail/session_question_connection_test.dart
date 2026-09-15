import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

const key = SessionDetailKey(tool: 'codex', sessionId: 'session-1');
const cursor = 'same-native-prefix';

AgentMessage question({required bool readOnly}) => AgentMessage.fromJson({
  'type': 'question-request',
  'requestId': 'codex:aq:pending',
  'blocking': false,
  'readOnly': readOnly,
  'questions': [
    {
      'question': 'Branch?',
      'options': [
        {'label': 'main'},
        {'label': 'dev'},
      ],
    },
  ],
});

SessionWireEvent session() => SessionWireEvent(
  info: SessionInfo.fromJson({
    'id': key.sessionId,
    'tool': key.tool,
    'title': 'reconnect',
    'status': 'idle',
    'attachMode': 'resume',
    'control': {
      'drive': {'state': 'driving', 'supported': true},
      'terminalSync': {
        'supported': false,
        'syncAvailable': false,
        'active': false,
      },
    },
  }),
);

void expectReadOnly(TranscriptHistoryWindow window, {required bool readOnly}) {
  expect(
    window.canonicalMessages
        .singleWhere(
          (m) => m.type == AgentMessageType.questionRequest,
        )
        .requestIsReadOnly,
    readOnly,
  );
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
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final boundary in ['reconnecting', 'closed', 'hello']) {
    test(
      'question authority ends at $boundary without a history reset',
      () async {
        final connection = FakeSessionDetailConnection();
        final container = buildControllerContainer(
          key,
          connection,
          FakeControllerAttachmentPicker(),
        );
        addTearDown(container.dispose);
        keepSessionDetailAlive(container, key);
        await container
            .read(sessionDetailControllerProvider(key).notifier)
            .attach();
        connection
          ..emitEvent(defaultControllerHello)
          ..emitEvent(session())
          ..emitEvent(
            HistoryWireEvent(
              messages: [question(readOnly: true)],
              reset: true,
              cursor: cursor,
            ),
          )
          ..emitEvent(
            MessageWireEvent(seq: 1, message: question(readOnly: false)),
          );
        await drainSessionDetailMicrotasks();
        TranscriptHistoryWindow window() => container
            .read(
              sessionDetailControllerProvider(key),
            )
            .transcriptWindow;
        final before = window();
        expectReadOnly(before, readOnly: false);
        if (boundary != 'hello') {
          connection.emitState(
            boundary == 'closed'
                ? SessionDetailConnectionStatus.closed
                : SessionDetailConnectionStatus.reconnecting,
          );
          await drainSessionDetailMicrotasks();
          expectReadOnly(window(), readOnly: true);
          connection.emitState(SessionDetailConnectionStatus.connected);
        }
        connection
          ..emitEvent(defaultControllerHello)
          ..emitEvent(session())
          ..emitEvent(
            const HistoryWireEvent(
              messages: [],
              cursor: cursor,
            ),
          );
        await drainSessionDetailMicrotasks();
        expectReadOnly(window(), readOnly: true);
        expect(window().historyCursor, cursor);
        expectReadOnly(before, readOnly: false);
        // The same adapter replays its actual pending requests.
        connection.emitEvent(
          MessageWireEvent(seq: 2, message: question(readOnly: false)),
        );
        await drainSessionDetailMicrotasks();
        expectReadOnly(window(), readOnly: false);
        // Ordinary session metadata is not a new connection epoch.
        connection.emitEvent(session());
        await drainSessionDetailMicrotasks();
        expectReadOnly(window(), readOnly: false);
      },
    );
  }

  test(
    'connection invalidation also revokes an evicted question on paging',
    () {
      var window = TranscriptHistoryWindow.fromHistory(
        HistoryWireEvent(
          messages: [question(readOnly: true)],
          cursor: cursor,
          olderCursor: 'older',
        ),
      ).applyLiveMessage(question(readOnly: false));
      for (var i = 0; i < kRetainedTranscriptTailMessages; i++) {
        window = window.applyLiveMessage(
          AgentMessage.fromJson({
            'type': 'model-output',
            'key': 'output-$i',
            'text': 'Working $i',
          }),
        );
      }
      window = window.invalidateQuestionAuthority().applyHistory(
        const HistoryWireEvent(messages: [], cursor: cursor),
      );
      final page = window.prependPage(
        HistoryPageWireEvent(
          messages: [question(readOnly: true)],
          hasMore: false,
          endOfHistory: true,
        ),
        requestedCursor: 'older',
      );
      expect(page.accepted, isTrue);
      expectReadOnly(page.window, readOnly: true);
      expect(page.window.historyCursor, cursor);
      expectReadOnly(
        page.window.applyLiveMessage(question(readOnly: false)),
        readOnly: false,
      );
    },
  );
}
