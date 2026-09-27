// A row streaming in is the same row from its first chunk to its last: the
// text grows inside it, and nothing the reader did to it is undone.
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

const _user = MessageWireEvent(
  seq: 1,
  message: AgentMessage(
    type: AgentMessageType.userMessage,
    raw: {'type': 'user-message', 'key': 'u1', 'text': 'Explain the change.'},
  ),
);

/// Chunk [chunk] of a streamed [type] row keyed [key], as live frames carry
/// it: no id, a seq of its own, and the text so far.
MessageWireEvent _chunk(
  String type,
  String key,
  int chunk, {
  required int seq,
}) => MessageWireEvent(
  seq: seq,
  message: AgentMessage.fromJson({
    'type': type,
    'key': key,
    'text': [
      'First paragraph of $key.',
      for (var part = 1; part <= chunk; part++)
        'Paragraph $part of $key, and a [link](https://example.com/$part).',
    ].join('\n\n'),
  }),
);

RenderParagraph _paragraph(WidgetTester tester, String text) =>
    tester.renderObject<RenderParagraph>(
      find.byWidgetPredicate(
        (widget) =>
            widget is RichText && widget.text.toPlainText().startsWith(text),
      ),
    );

void main() {
  tearDown(() => debugTranscriptRenderWork = null);

  testWidgets('a reply streaming in grows in place, laying out only its end', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    final connection = ScriptedSessionDetailConnection(
      events: [_user, _chunk('model-output', 'r1', 0, seq: 2)],
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: connection),
    );
    await tester.pumpAndSettle();
    final first = _paragraph(tester, 'First paragraph of r1');
    final span = first.text;
    final element = tester.element(
      find.byWidgetPredicate(
        (widget) =>
            widget is RichText &&
            widget.text.toPlainText().startsWith('First paragraph of r1'),
      ),
    );

    final work = debugTranscriptRenderWork = TranscriptRenderWorkCounter();
    for (var chunk = 1; chunk <= 6; chunk++) {
      connection.emitEvent(_chunk('model-output', 'r1', chunk, seq: 2 + chunk));
      await tester.pump(const Duration(milliseconds: 33));
    }
    await tester.pumpAndSettle();

    expect(find.textContaining('Paragraph 6 of r1'), findsOneWidget);
    expect(
      identical(
        element,
        tester.element(
          find.byWidgetPredicate(
            (widget) =>
                widget is RichText &&
                widget.text.toPlainText().startsWith('First paragraph of r1'),
          ),
        ),
      ),
      isTrue,
      reason: 'the row is updated, not built again',
    );
    final after = _paragraph(tester, 'First paragraph of r1');
    expect(identical(first, after), isTrue);
    expect(
      identical(span, after.text),
      isTrue,
      reason: 'a paragraph that did not change is not laid out again',
    );
    expect(work.markdownBlocksReused, greaterThanOrEqualTo(6));
  });

  testWidgets('a thinking row opened while it streams stays open', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    final connection = ScriptedSessionDetailConnection(
      events: [_user, _chunk('thinking', 't1', 0, seq: 2)],
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: connection),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('conversation-thinking-toggle')));
    await tester.pumpAndSettle();
    expect(find.textContaining('First paragraph of t1'), findsOneWidget);

    for (var chunk = 1; chunk <= 3; chunk++) {
      connection.emitEvent(_chunk('thinking', 't1', chunk, seq: 2 + chunk));
      await tester.pump(const Duration(milliseconds: 33));
    }
    await tester.pumpAndSettle();

    expect(find.textContaining('First paragraph of t1'), findsOneWidget);
    expect(find.textContaining('Paragraph 3 of t1'), findsOneWidget);
  });
}
