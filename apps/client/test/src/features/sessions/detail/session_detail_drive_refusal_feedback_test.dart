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

  testWidgets('ownership unknown uses the ownership-conflict feedback', (
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
        'Drive was not restored automatically because another owner may be '
        'active. You can still choose Take over.',
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

  final manualOwnershipScenarios = [
    (
      locale: const Locale('en'),
      localeName: 'English',
      expected:
          'Couldn’t take over because Codex Desktop or another Codex client '
          'may still control this session. It remains read-only in Cosyncing.',
    ),
    (
      locale: const Locale('zh'),
      localeName: 'Chinese',
      expected:
          '无法接管，因为 Codex Desktop 或其他 Codex 客户端可能仍在控制此会话。它将在 Cosyncing 中保持只读。',
    ),
  ];

  for (final scenario in manualOwnershipScenarios) {
    testWidgets(
      'manual active-writer refusal persists in Chat in '
      '${scenario.localeName}',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: [
            SessionWireEvent(
              info: SessionInfo.fromJson(const {
                'id': 'session-1',
                'tool': 'codex',
                'title': 'Manual Drive refusal',
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
          reattachEvents: [
            const AttachConflictWireEvent(
              requestedMode: 'resume',
              reason: 'takeover',
              code: 'DRIVE_OWNERSHIP_CONFLICT',
              message: 'The native session already has an active writer.',
            ),
            SessionWireEvent(
              info: SessionInfo.fromJson(const {
                'id': 'session-1',
                'tool': 'codex',
                'title': 'Manual Drive refusal',
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
            locale: scenario.locale,
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(const Key('session-detail-composer-take-over-button')),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('session-detail-take-over-dialog')),
          findsOneWidget,
        );
        await tester.tap(
          find.byKey(const Key('session-detail-take-over-confirm')),
        );
        await tester.pumpAndSettle();

        expect(connection.reattachModes, ['resume']);
        expect(connection.reattachReasons, ['takeover']);
        expect(
          find.byKey(const Key('session-detail-observe-composer-bar')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-composer-take-over-button')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-take-over-refusal')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-observe-composer-refusal')),
          findsOneWidget,
        );
        expect(
          tester
              .widget<Text>(
                find.byKey(const Key('session-detail-take-over-refusal')),
              )
              .data,
          scenario.expected,
        );
        expect(
          tester
              .widget<Text>(
                find.byKey(
                  const Key('session-detail-observe-composer-refusal'),
                ),
              )
              .data,
          scenario.expected,
        );
        expect(
          find.text(
            scenario.locale.languageCode == 'zh'
                ? '终端尚未同步：'
                : 'Terminal not synced:',
          ),
          findsNothing,
        );
        expect(
          find.byKey(const Key('session-detail-tab-panel-chat')).hitTestable(),
          findsOneWidget,
        );
      },
    );
  }
}
