// What a page rebuild costs the transcript: every streamed chunk rebuilds the
// session page, and only the row the chunk lands in may rebuild with it.
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_file_link_scope.dart';
import 'package:flutter/material.dart';
import 'package:flutter/widgets.dart' as widgets;
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

MessageWireEvent _message(int seq, Map<String, Object?> raw) =>
    MessageWireEvent(seq: seq, message: AgentMessage.fromJson(raw));

/// A finished turn: a prompt, two replies, a tool call with its result, two
/// grouped lookups and the turn's run summary; then a reply still streaming
/// in.
List<WireEvent> _history() => [
  _message(1, {
    'type': 'user-message',
    'key': 'u1',
    'turnId': 't1',
    'text': 'Fix the bug.',
  }),
  _message(2, {
    'type': 'model-output',
    'key': 'done-1',
    'text': 'First finished reply, with `code` and a [link](https://x.test).',
    'final': true,
  }),
  _message(3, {
    'type': 'tool-call',
    'callId': 'c1',
    'toolName': 'bash',
    'toolClass': 'execute',
  }),
  _message(4, {
    'type': 'tool-result',
    'callId': 'c1',
    'toolName': 'bash',
    'toolClass': 'execute',
  }),
  _message(5, {
    'type': 'tool-call',
    'callId': 'r1',
    'toolName': 'Read',
    'toolClass': 'lookup',
  }),
  _message(6, {
    'type': 'tool-call',
    'callId': 'g1',
    'toolName': 'Grep',
    'toolClass': 'lookup',
  }),
  _message(7, {
    'type': 'model-output',
    'key': 'done-2',
    'text': 'Second finished reply.',
    'final': true,
  }),
  _message(8, {
    'type': 'run-summary',
    'key': 'run:t1',
    'turnId': 't1',
    'status': 'done',
    'totalRuntimeMs': 1500,
  }),
  _message(9, {'type': 'user-message', 'key': 'u2', 'text': 'And now?'}),
  _message(10, {'type': 'model-output', 'key': 'live', 'text': 'Streaming'}),
];

String _typeName(Widget widget) => widget.runtimeType.toString();

/// Counts rebuilds of already-built elements by widget type while [body]
/// runs.
Future<Map<String, int>> _rebuildsDuring(Future<void> Function() body) async {
  final built = Expando<bool>();
  final counts = <String, int>{};
  // Everything mounted now has been built once.
  void mark(Element element) {
    built[element] = true;
    element.visitChildren(mark);
  }

  WidgetsBinding.instance.rootElement!.visitChildren(mark);
  widgets.debugOnRebuildDirtyWidget = (element, _) {
    if (built[element] != true) return;
    final type = _typeName(element.widget);
    counts[type] = (counts[type] ?? 0) + 1;
    if (element.widget.key case ValueKey<String>(:final value)) {
      counts['key:$value'] = (counts['key:$value'] ?? 0) + 1;
    }
  };
  try {
    await body();
  } finally {
    widgets.debugOnRebuildDirtyWidget = null;
  }
  return counts;
}

void main() {
  testWidgets('a streamed chunk rebuilds only the row it lands in', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    final connection = ScriptedSessionDetailConnection(events: _history());
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: connection),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Second finished reply'), findsOneWidget);
    expect(
      find.byWidgetPredicate(
        (widget) => _typeName(widget) == '_ConversationTurnFooter',
      ),
      findsWidgets,
      reason: 'the finished turn shows its footer and run summary',
    );

    final rebuilds = await _rebuildsDuring(() async {
      for (var chunk = 1; chunk <= 3; chunk++) {
        connection.emitEvent(
          _message(10 + chunk, {
            'type': 'model-output',
            'key': 'live',
            'text': 'Streaming ${'more ' * chunk}',
          }),
        );
        await tester.pump(const Duration(milliseconds: 16));
      }
    });

    expect(find.textContaining('Streaming more more more'), findsOneWidget);
    expect(
      rebuilds['_ConversationModelOutput'],
      3,
      reason: 'only the streaming reply rebuilds, once per chunk: $rebuilds',
    );
    for (final row in [
      '_ConversationUserBubble',
      '_ToolMessageCard',
      '_LookupToolGroup',
      '_ConversationTurnFooter',
    ]) {
      expect(
        rebuilds[row],
        isNull,
        reason: 'an unchanged $row is the same widget as before: $rebuilds',
      );
    }
    // The overlays follow their own listenables.
    expect(rebuilds['_TranscriptReadingScrollbar'], isNull);
    expect(rebuilds['key:session-history-jump-latest'], isNull);
  });

  testWidgets('a page rebuild does not tell file links their scope changed', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    final connection = ScriptedSessionDetailConnection(events: _history());
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: connection),
    );
    await tester.pumpAndSettle();
    final scope = find.byType(SessionFileLinkScope);
    final before = tester.widget<SessionFileLinkScope>(scope);

    connection.emitEvent(
      _message(11, {
        'type': 'model-output',
        'key': 'live',
        'text': 'Streaming on',
      }),
    );
    await tester.pump(const Duration(milliseconds: 16));

    final after = tester.widget<SessionFileLinkScope>(scope);
    expect(
      identical(before, after),
      isFalse,
      reason: 'the chunk rebuilt the page',
    );
    expect(
      after.updateShouldNotify(before),
      isFalse,
      reason: 'the same callbacks and gate are no change to every link row',
    );
  });
}
