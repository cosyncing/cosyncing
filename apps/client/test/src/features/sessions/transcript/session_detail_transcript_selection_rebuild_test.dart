import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// A finished reply whose markdown carries two inline links.
AgentMessage _linkedReply(int index, {String? key, bool done = true}) =>
    AgentMessage.fromJson({
      'type': 'model-output',
      'key': key ?? 'linked-$index',
      'text':
          'Linked reply $index reads [the guide](https://example.com/$index) '
          'and [the notes](https://example.com/$index/notes) before it ends.',
      'final': done,
    });

Finder _textContaining(String text) => find.textContaining(text);

/// Starts a mouse drag from the top left of [startText] to the bottom right
/// of [endText], leaving the button down.
Future<TestGesture> _dragAcross(
  WidgetTester tester,
  String startText,
  String endText,
) async {
  final start =
      tester.getTopLeft(_textContaining(startText).first) + const Offset(2, 8);
  final end =
      tester.getBottomRight(_textContaining(endText).first) -
      const Offset(2, 8);
  final gesture = await tester.startGesture(
    start,
    kind: PointerDeviceKind.mouse,
  );
  addTearDown(gesture.removePointer);
  await gesture.moveTo(end);
  await tester.pump();
  return gesture;
}

Future<String?> _copied(WidgetTester tester) async {
  String? text;
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
    SystemChannels.platform,
    (call) async {
      if (call.method == 'Clipboard.setData') {
        text = (call.arguments as Map<Object?, Object?>)['text'] as String?;
      }
      return null;
    },
  );
  addTearDown(
    () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      null,
    ),
  );
  final area = find.ancestor(
    of: find.byKey(const Key('session-detail-chat-scroll')),
    matching: find.byType(SelectionArea),
  );
  tester
      .state<SelectionAreaState>(area)
      .selectableRegion
      // No public test hook exposes the selected content.
      // ignore: deprecated_member_use
      .copySelection(SelectionChangedCause.toolbar);
  await tester.pump();
  return text;
}

void main() {
  testWidgets('a selection across linked rows survives them rebuilding', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    final connection = ScriptedSessionDetailConnection(
      events: [
        HistoryWireEvent(
          messages: [for (var i = 1; i <= 4; i++) _linkedReply(i)],
          reset: true,
          cursor: 'tail',
        ),
      ],
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: connection),
    );
    await tester.pumpAndSettle();

    final gesture = await _dragAcross(
      tester,
      'Linked reply 2',
      'Linked reply 3',
    );
    // The rows rebuild while the selection is live: a reply streams in
    // below them, and the transcript's rows are built again.
    connection.emitEvent(
      MessageWireEvent(seq: 10, message: _linkedReply(5, done: false)),
    );
    await tester.pump();
    connection.emitEvent(MessageWireEvent(seq: 11, message: _linkedReply(5)));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    final copied = await _copied(tester);
    expect(copied, contains('Linked reply 2'));
    expect(copied, contains('Linked reply 3'));
    expect(copied, contains('the guide'));
  });

  testWidgets('a selection inside a streaming linked row survives its '
      'updates', (tester) async {
    useRoomyTestViewport(tester);
    final connection = ScriptedSessionDetailConnection(
      events: [
        HistoryWireEvent(
          messages: [
            for (var i = 1; i <= 2; i++) _linkedReply(i),
            _linkedReply(3, key: 'streaming', done: false),
          ],
          reset: true,
          cursor: 'tail',
        ),
      ],
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: connection),
    );
    await tester.pumpAndSettle();

    final gesture = await _dragAcross(
      tester,
      'Linked reply 2',
      'Linked reply 3',
    );
    await gesture.up();
    await tester.pump();
    for (var chunk = 0; chunk < 3; chunk++) {
      connection.emitEvent(
        MessageWireEvent(
          seq: 20 + chunk,
          message: AgentMessage.fromJson({
            'type': 'model-output',
            'key': 'streaming',
            'text':
                'Linked reply 3 reads [the guide](https://example.com/3) '
                'and [the notes](https://example.com/3/notes) before it ends.'
                '${' More [$chunk](https://example.com/more/$chunk).' * chunk}',
            'final': chunk == 2,
          }),
        ),
      );
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(await _copied(tester), contains('Linked reply 2'));
  });
}
