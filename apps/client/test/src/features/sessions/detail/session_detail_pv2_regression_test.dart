import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

Finder _promptEditable() => find.descendant(
  of: find.byKey(const Key('session-detail-prompt-input')),
  matching: find.byType(EditableText),
);

void _useViewport(WidgetTester tester, Size size) {
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  tester.view
    ..physicalSize = size
    ..devicePixelRatio = 1;
}

void main() {
  testWidgets(
    'composer EditableText survives ten compact-height crossings '
    'with IME state',
    (tester) async {
      _useViewport(tester, const Size(800, 900));
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
        ),
      );
      await tester.pumpAndSettle();

      final editable = _promptEditable();
      final initialState = tester.state<EditableTextState>(editable);
      final field = tester.widget<EditableText>(editable);
      field.controller.value = const TextEditingValue(
        text: 'compose',
        selection: TextSelection(baseOffset: 2, extentOffset: 5),
        composing: TextRange(start: 1, end: 6),
      );
      field.focusNode.requestFocus();
      await tester.pump();
      expect(field.focusNode, same(FocusManager.instance.primaryFocus));

      for (var crossing = 0; crossing < 10; crossing++) {
        tester.view.physicalSize = crossing.isEven
            ? const Size(800, 460)
            : const Size(800, 900);
        if (crossing == 4) {
          connection.emitState(SessionDetailConnectionStatus.reconnecting);
          await tester.pump();
          expect(
            tester.state<EditableTextState>(_promptEditable()),
            same(initialState),
          );
          expect(field.focusNode, same(FocusManager.instance.primaryFocus));
          expect(
            field.controller.value.composing,
            const TextRange(start: 1, end: 6),
          );
          connection.emitState(SessionDetailConnectionStatus.connected);
        }
        connection
          ..emitEvent(
            MessageWireEvent(
              seq: 100 + crossing,
              message: AgentMessage.fromJson({
                'type': 'status',
                'status': crossing.isEven ? 'running' : 'idle',
              }),
            ),
          )
          ..emitEvent(DraftWireEvent(text: 'compose', at: 100 + crossing));
        await tester.pump();
        await tester.pump();

        expect(
          find.byKey(const Key('session-detail-chat-compact-scroll')),
          crossing.isEven ? findsOneWidget : findsNothing,
        );
        final current = tester.widget<EditableText>(_promptEditable());
        expect(
          tester.state<EditableTextState>(_promptEditable()),
          same(initialState),
        );
        expect(current.focusNode, same(FocusManager.instance.primaryFocus));
        expect(current.controller.text, 'compose');
        expect(
          current.controller.selection,
          const TextSelection(baseOffset: 2, extentOffset: 5),
        );
        expect(
          current.controller.value.composing,
          const TextRange(start: 1, end: 6),
        );
      }
    },
  );

  testWidgets(
    'one transcript SelectionArea owns the lazy list and two viewport cache',
    (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                id: 'pv2-selection-a',
                type: AgentMessageType.modelOutput,
                raw: {'type': 'model-output', 'text': 'Alpha transcript row'},
              ),
            ),
            MessageWireEvent(
              seq: 2,
              message: AgentMessage(
                id: 'pv2-selection-b',
                type: AgentMessageType.modelOutput,
                raw: {'type': 'model-output', 'text': 'Beta transcript row'},
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      final list = find.byKey(const Key('session-detail-chat-scroll'));
      expect(
        find.ancestor(of: list, matching: find.byType(SelectionArea)),
        findsOneWidget,
      );
      expect(
        tester.widget<ListView>(list).scrollCacheExtent,
        const ScrollCacheExtent.viewport(2),
      );
      final selectionOwner = find.byKey(
        const Key('session-history-shortcut-focus'),
      );
      expect(tester.widget<SelectionArea>(selectionOwner).focusNode, isNotNull);
      expect(
        find.descendant(
          of: selectionOwner,
          matching: find.byWidgetPredicate(
            (widget) => widget is Focus && widget.autofocus,
          ),
        ),
        findsNothing,
      );
      expect(
        find.descendant(
          of: find.byKey(
            const ValueKey('session-message-context-pv2-selection-a'),
          ),
          matching: find.byType(SelectionArea),
        ),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-selection-retained')),
        findsNothing,
      );
    },
  );

  testWidgets(
    'completed transcript tap dismisses editor focus',
    (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                id: 'tap-away-message',
                type: AgentMessageType.modelOutput,
                raw: {
                  'type': 'model-output',
                  'text': 'Transcript tap target',
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      final editable = tester.widget<EditableText>(_promptEditable());
      editable.focusNode.requestFocus();
      await tester.pump();
      expect(editable.focusNode.hasFocus, isTrue);

      await tester.tap(find.text('Transcript tap target'));
      await tester.pump();
      expect(editable.focusNode.hasFocus, isFalse);
      expect(
        tester
            .widget<SelectionArea>(
              find.byKey(const Key('session-history-shortcut-focus')),
            )
            .focusNode
            ?.hasFocus,
        isTrue,
      );
    },
  );

  testWidgets('cross-message copy crosses notices and expanded tool output', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    String? copiedText;
    final speechOutput = RecordingSpeechOutput();
    addTearDown(speechOutput.close);
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copiedText =
              (call.arguments as Map<Object?, Object?>)['text'] as String?;
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
    await tester.pumpWidget(
      buildSessionDetailTestPage(
        speechOutput: speechOutput,
        events: const [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              id: 'cross-selection-a',
              type: AgentMessageType.userMessage,
              raw: {
                'type': 'user-message',
                'text': 'Alpha visual range',
              },
            ),
          ),
          MessageWireEvent(
            seq: 2,
            message: AgentMessage(
              id: 'cross-selection-notice',
              type: AgentMessageType.notice,
              raw: {
                'type': 'notice',
                'message': 'Notice inside visual range',
              },
            ),
          ),
          MessageWireEvent(
            seq: 3,
            message: AgentMessage(
              id: 'cross-selection-tool',
              type: AgentMessageType.toolResult,
              raw: {
                'type': 'tool-result',
                'callId': 'pv2-tool',
                'toolClass': 'execute',
                'result': 'Tool output inside visual range',
              },
            ),
          ),
          MessageWireEvent(
            seq: 4,
            message: AgentMessage(
              id: 'cross-selection-b',
              type: AgentMessageType.modelOutput,
              raw: {
                'type': 'model-output',
                'text': 'Beta visual range',
              },
            ),
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tool-pv2-tool-details')));
    await tester.pumpAndSettle();

    final transcript = find.byKey(const Key('session-detail-chat-scroll'));
    expect(
      find.descendant(of: transcript, matching: find.byType(SelectableText)),
      findsNothing,
      reason: 'transcript children must register with the outer SelectionArea',
    );

    final start =
        tester.getTopLeft(find.text('Alpha visual range')) + const Offset(2, 8);
    final end =
        tester.getBottomRight(find.text('Beta visual range')) -
        const Offset(2, 8);

    Future<void> selectAcrossMessages() async {
      final gesture = await tester.startGesture(
        start,
        kind: PointerDeviceKind.mouse,
      );
      await gesture.moveTo(end);
      await gesture.up();
      await tester.pumpAndSettle();
      await tester.tapAt(end, buttons: kSecondaryMouseButton);
      await tester.pumpAndSettle();
    }

    await selectAcrossMessages();
    expect(find.text('Select all'), findsNothing);
    expect(find.text('Fork from here'), findsNothing);
    expect(find.text('Details'), findsNothing);
    await tester.tap(find.text('Copy'));
    await tester.pumpAndSettle();

    expect(copiedText, isNotNull);
    expect(copiedText, contains('Alpha visual range'));
    expect(copiedText, contains('Notice inside visual range'));
    expect(copiedText, contains('Tool output inside visual range'));
    expect(copiedText, contains('Beta visual range'));
    expect(
      copiedText!.indexOf('Alpha visual range'),
      lessThan(copiedText!.indexOf('Notice inside visual range')),
    );
    expect(
      copiedText!.indexOf('Notice inside visual range'),
      lessThan(copiedText!.indexOf('Tool output inside visual range')),
    );
    expect(
      copiedText!.indexOf('Tool output inside visual range'),
      lessThan(copiedText!.indexOf('Beta visual range')),
    );

    await selectAcrossMessages();
    await tester.tap(find.text('Read aloud'));
    await tester.pump();
    expect(speechOutput.spokenTexts, [copiedText]);
  });

  testWidgets('live OpenCode retry detail renders once and replacement wins', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    final connection = ScriptedSessionDetailConnection(events: const []);
    await tester.pumpWidget(
      buildSessionDetailTestPage(
        tool: 'opencode',
        events: const [],
        connection: connection,
      ),
    );
    await tester.pumpAndSettle();

    connection
      ..emitEvent(
        SessionWireEvent(
          info: SessionInfo.fromJson(const {
            'id': 'session-1',
            'tool': 'opencode',
            'title': 'Retry test',
            'status': 'working',
            'attachMode': 'observe',
          }),
        ),
      )
      ..emitEvent(
        MessageWireEvent(
          seq: 1,
          message: AgentMessage.fromJson(const {
            'type': 'status',
            'status': 'running',
            'detail': 'retry A',
          }),
        ),
      );
    await tester.pumpAndSettle();

    final container = ProviderScope.containerOf(
      tester.element(find.byType(SessionDetailPage)),
    );
    expect(
      container
          .read(
            sessionDetailControllerProvider(
              const SessionDetailKey(
                tool: 'opencode',
                sessionId: 'session-1',
              ),
            ),
          )
          .transientRetryStatus
          ?.providerDetail,
      'retry A',
    );
    expect(find.text('OpenCode is retrying.'), findsOneWidget);
    expect(find.text('Provider detail: retry A'), findsOneWidget);

    connection.emitEvent(
      MessageWireEvent(
        seq: 2,
        message: AgentMessage.fromJson(const {
          'type': 'status',
          'status': 'running',
          'detail': 'retry B',
        }),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Provider detail: retry A'), findsNothing);
    expect(find.text('Provider detail: retry B'), findsOneWidget);
    expect(
      find.byKey(const Key('session-opencode-retry-status')),
      findsOneWidget,
    );

    connection.emitEvent(
      const HistoryWireEvent(
        messages: [
          AgentMessage(
            id: 'older-history-row',
            type: AgentMessageType.userMessage,
            raw: {'type': 'user-message', 'text': 'older history'},
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Provider detail: retry B'), findsOneWidget);

    connection.emitEvent(
      SessionWireEvent(
        info: SessionInfo.fromJson(const {
          'id': 'session-1',
          'tool': 'opencode',
          'title': 'Updated retry metadata',
          'status': 'working',
          'attachMode': 'observe',
        }),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Provider detail: retry B'), findsOneWidget);

    connection.emitEvent(
      const HistoryWireEvent(
        reset: true,
        messages: [
          AgentMessage(
            type: AgentMessageType.status,
            raw: {
              'type': 'status',
              'status': 'running',
              'detail': 'replayed retry must not survive',
            },
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('session-opencode-retry-status')),
      findsNothing,
    );

    connection.emitEvent(
      MessageWireEvent(
        seq: 3,
        message: AgentMessage.fromJson(const {
          'type': 'status',
          'status': 'running',
          'detail': 'retry C',
        }),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Provider detail: retry C'), findsOneWidget);

    connection.emitEvent(
      MessageWireEvent(
        seq: 4,
        message: AgentMessage.fromJson(const {
          'type': 'model-output',
          'text': 'progress resumed',
        }),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('session-opencode-retry-status')),
      findsNothing,
    );

    connection.emitEvent(
      MessageWireEvent(
        seq: 5,
        message: AgentMessage.fromJson(const {
          'type': 'status',
          'status': 'running',
          'detail': 'retry D',
        }),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Provider detail: retry D'), findsOneWidget);
    connection.emitState(SessionDetailConnectionStatus.reconnecting);
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('session-opencode-retry-status')),
      findsNothing,
    );
  });

  testWidgets('retry band is exact, selectable, live, and localized', (
    tester,
  ) async {
    _useViewport(tester, const Size(800, 560));
    const source = RosterSource(
      profileId: 'local',
      endpoint: 'http://127.0.0.1:7734',
    );
    const retry = SessionTransientRetryStatus(
      providerDetail: '供应商原文',
      source: source,
      sessionId: 'session-1',
      attachGeneration: 4,
      eventSequence: 1,
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(
        tool: 'opencode',
        locale: const Locale('zh'),
        textScale: 2,
        theme: ThemeData(
          brightness: Brightness.dark,
          extensions: [themeSpecById(kDefaultThemeId).dark],
        ),
        events: const [],
        seededController: SeededSessionDetailController(
          const SessionDetailState(
            tool: 'opencode',
            sessionId: 'session-1',
            source: source,
            connectionStatus: SessionDetailConnectionStatus.connected,
            bootstrapState: SessionDetailBootstrapState(
              readiness: SessionDetailBootstrapReadiness.ready,
              attempt: 4,
            ),
            transientRetryStatus: retry,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final band = find.byKey(const Key('session-opencode-retry-status'));
    expect(find.text('OpenCode 正在重试。'), findsOneWidget);
    expect(find.text('提供商详情：供应商原文'), findsOneWidget);
    expect(
      find.descendant(of: band, matching: find.byType(SelectionArea)),
      findsOneWidget,
    );
    final semantics = tester.getSemantics(band);
    expect(semantics.label, 'OpenCode 正在重试。\n提供商详情：供应商原文');
    expect(semantics.flagsCollection.isLiveRegion, isTrue);
  });
}
