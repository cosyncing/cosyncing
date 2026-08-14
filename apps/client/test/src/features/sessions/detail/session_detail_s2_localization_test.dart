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
        title: 'Command permission mode',
        body:
            'Applies to slash commands sent from this composer. Regular '
            'prompts keep the permission mode published by the Server.',
        ask: 'Ask permission',
        approve: 'Approve for me',
      ),
      (
        locale: Locale('zh'),
        fallback: '权限',
        title: '命令权限模式',
        body:
            '适用于从此输入框发送的斜杠命令。普通提示词仍沿用服务器'
            '发布的权限模式。',
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
