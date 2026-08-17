import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  testWidgets('permission mode sheet follows the selected app locale', (
    tester,
  ) async {
    const cases = [
      (
        locale: Locale('en'),
        fallback: 'Permission',
        title: 'Permission mode',
        body:
            'Applies to prompts and slash commands sent from this composer. '
            'If the Server publishes a different mode, that one takes over.',
        ask: 'Ask permission',
        approve: 'Approve for me',
      ),
      (
        locale: Locale('zh'),
        fallback: '权限',
        title: '权限模式',
        body:
            '适用于从此输入框发送的提示词和斜杠命令。'
            '若服务器发布了其他权限模式，则以服务器为准。',
        ask: '每次询问',
        approve: '自动批准',
      ),
    ];

    for (final testCase in cases) {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          OptionsWireEvent(
            models: [],
            agents: [],
            modes: [
              ModeOption(
                value: 'default',
                label: 'Ask each time',
                category: 'ask-permission',
              ),
              ModeOption(
                value: 'accept-edits',
                label: 'Accept edits',
                category: 'approve-for-me',
              ),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          locale: testCase.locale,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text(testCase.fallback), findsOneWidget);
      await tester.tap(
        find.byKey(const Key('session-detail-permission-selector')),
      );
      await tester.pumpAndSettle();

      expect(find.text(testCase.title), findsOneWidget);
      expect(find.text(testCase.body), findsOneWidget);
      expect(find.text(testCase.ask), findsOneWidget);
      expect(find.text(testCase.approve), findsOneWidget);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
    }
  });

  testWidgets('terminal heading follows the selected app locale', (
    tester,
  ) async {
    const cases = [
      (locale: Locale('en'), heading: 'Terminal output (2)'),
      (locale: Locale('zh'), heading: '终端输出（2）'),
    ];

    for (final testCase in cases) {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          locale: testCase.locale,
          events: [
            for (var index = 0; index < 2; index++)
              MessageWireEvent(
                seq: index + 1,
                message: AgentMessage(
                  type: AgentMessageType.terminalOutput,
                  id: 'terminal-$index',
                  raw: {
                    'type': 'terminal-output',
                    'command': 'printf $index',
                    'output': 'result $index',
                  },
                ),
              ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await openSessionDetailTestTab(
        tester,
        'session-detail-tab-terminal',
      );

      expect(find.text(testCase.heading), findsOneWidget);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
    }
  });
}
