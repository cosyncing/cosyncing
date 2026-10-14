import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  Future<void> showRefusal(
    WidgetTester tester, {
    required String code,
    required String reason,
    required Locale locale,
  }) async {
    final connection = ScriptedSessionDetailConnection(
      events: [
        SessionWireEvent(
          info: SessionInfo.fromJson(const {
            'id': 'session-1',
            'tool': 'codex',
            'title': 'Drive refusal feedback',
            'status': 'idle',
            'attachMode': 'observe',
            'control': {
              'drive': {'state': 'observing', 'supported': true},
              'terminalSync': {
                'supported': true,
                'syncAvailable': true,
                'active': false,
                'action': 'join',
                'command': 'codex resume --remote socket thread',
              },
            },
          }),
        ),
      ],
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(
        events: const [],
        tool: 'codex',
        connection: connection,
        locale: locale,
      ),
    );
    await tester.pumpAndSettle();

    connection
      ..emitEvent(
        AttachConflictWireEvent(
          requestedMode: 'resume',
          reason: reason,
          code: code,
          message: 'Drive attach refused safely.',
        ),
      )
      ..emitSessionControl(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': true,
          'syncAvailable': true,
          'active': false,
          'action': 'join',
          'command': 'codex resume --remote socket thread',
        },
      });
    await tester.pumpAndSettle();
    await openSessionDetailTestTab(tester, 'session-detail-tab-status');
  }

  testWidgets('ownership unknown does not imply a confirmed competing writer', (
    tester,
  ) async {
    await showRefusal(
      tester,
      code: 'DRIVE_OWNERSHIP_UNKNOWN',
      reason: 'app-restore',
      locale: const Locale('en'),
    );

    expect(
      find.text(
        'Drive was not restored because Codex daemon ownership could not be '
        'verified. The session remains read-only; you can retry Take over.',
      ),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('session-detail-take-over-button')),
      findsOneWidget,
    );
  });

  final nativeRefusalScenarios =
      <
        ({
          Locale locale,
          String localeName,
          String reason,
          String reasonName,
          String expected,
          String unexpected,
        })
      >[
        (
          locale: const Locale('en'),
          localeName: 'English',
          reason: 'app-restore',
          reasonName: 'automatic restoration',
          expected:
              'Codex could not resume this session to restore Drive '
              'automatically. It stays in Observe.',
          unexpected:
              'Codex could not resume this session for Take over. It stays in '
              'Observe.',
        ),
        (
          locale: const Locale('en'),
          localeName: 'English',
          reason: 'takeover',
          reasonName: 'manual takeover',
          expected:
              'Codex could not resume this session for Take over. It stays in '
              'Observe.',
          unexpected:
              'Codex could not resume this session to restore Drive '
              'automatically. It stays in Observe.',
        ),
        (
          locale: const Locale('zh'),
          localeName: 'Chinese',
          reason: 'app-restore',
          reasonName: 'automatic restoration',
          expected: 'Codex 无法恢复此会话，因此未能自动恢复驾驶。会话将保持观察状态。',
          unexpected: 'Codex 无法恢复此会话以供接管。会话将保持观察状态。',
        ),
        (
          locale: const Locale('zh'),
          localeName: 'Chinese',
          reason: 'takeover',
          reasonName: 'manual takeover',
          expected: 'Codex 无法恢复此会话以供接管。会话将保持观察状态。',
          unexpected: 'Codex 无法恢复此会话，因此未能自动恢复驾驶。会话将保持观察状态。',
        ),
      ];

  for (final scenario in nativeRefusalScenarios) {
    testWidgets(
      'native unresumable uses ${scenario.reasonName} wording in '
      '${scenario.localeName}',
      (tester) async {
        await showRefusal(
          tester,
          code: 'DRIVE_NATIVE_SESSION_UNRESUMABLE',
          reason: scenario.reason,
          locale: scenario.locale,
        );

        expect(find.text(scenario.expected), findsOneWidget);
        expect(find.text(scenario.unexpected), findsNothing);
        expect(
          find.byKey(const Key('session-detail-take-over-button')),
          findsOneWidget,
        );
      },
    );
  }
}
