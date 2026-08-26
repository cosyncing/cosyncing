import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// Every answer button the permission card rendered for [requestId].
///
/// Keyed rather than counted by type so the outcome badge and the surrounding
/// transcript chrome can never be mistaken for an answer control.
Finder _answerButtons(String requestId) => find.byWidgetPredicate((widget) {
  if (widget is! ButtonStyleButton) return false;
  final key = widget.key;
  return key is ValueKey<String> &&
      key.value.startsWith('session-detail-permission-') &&
      key.value.endsWith('-$requestId');
}, description: 'permission answer button for $requestId');

Widget _permissionPage({
  required String requestId,
  List<String>? options,
  bool readOnly = false,
}) {
  return buildSessionDetailTestPage(
    events: const [],
    connection: ScriptedSessionDetailConnection(
      events: [
        MessageWireEvent(
          seq: 1,
          message: AgentMessage(
            type: AgentMessageType.permissionRequest,
            raw: {
              'type': 'permission-request',
              'requestId': requestId,
              'title': 'Run command',
              if (readOnly) 'readOnly': true,
              if (options != null) 'options': options,
            },
          ),
        ),
      ],
    ),
  );
}

void main() {
  group('permission answer options', () {
    testWidgets('an absent options list still answers approve/reject', (
      tester,
    ) async {
      await tester.pumpWidget(_permissionPage(requestId: 'perm-default'));
      await tester.pumpAndSettle();

      expect(_answerButtons('perm-default'), findsNWidgets(2));
      expect(
        find.byKey(const Key('session-detail-permission-reject-perm-default')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-permission-approve-perm-default')),
        findsOneWidget,
      );
    });

    testWidgets('two advertised options render two buttons', (tester) async {
      await tester.pumpWidget(
        _permissionPage(
          requestId: 'perm-two',
          options: const ['approve', 'reject'],
        ),
      );
      await tester.pumpAndSettle();

      expect(_answerButtons('perm-two'), findsNWidgets(2));
      expect(
        find.byKey(const Key('session-detail-permission-reject-perm-two')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-permission-approve-perm-two')),
        findsOneWidget,
      );
      expect(
        find.byKey(
          const Key('session-detail-permission-approve-session-perm-two'),
        ),
        findsNothing,
      );
      // Settled copy: with no session option on screen, "once" would imply a
      // second choice that does not exist.
      expect(find.text('Allow'), findsOneWidget);
      expect(find.text('Allow once'), findsNothing);
    });

    testWidgets('three advertised options render three buttons', (
      tester,
    ) async {
      await tester.pumpWidget(
        _permissionPage(
          requestId: 'perm-three',
          options: const ['approve', 'approve-session', 'reject'],
        ),
      );
      await tester.pumpAndSettle();

      expect(_answerButtons('perm-three'), findsNWidgets(3));
      expect(
        find.byKey(const Key('session-detail-permission-reject-perm-three')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-permission-approve-perm-three')),
        findsOneWidget,
      );
      expect(
        find.byKey(
          const Key('session-detail-permission-approve-session-perm-three'),
        ),
        findsOneWidget,
      );
      expect(find.text('Allow once'), findsOneWidget);
      expect(find.text('Allow'), findsNothing);
    });

    testWidgets(
      'a persistent command rule renders as a distinct third choice',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          _permissionPage(
            requestId: 'perm-rule',
            options: const ['approve', 'approve-rule', 'reject'],
          ),
        );
        await tester.pumpAndSettle();

        expect(_answerButtons('perm-rule'), findsNWidgets(3));
        expect(
          find.byKey(
            const Key('session-detail-permission-approve-rule-perm-rule'),
          ),
          findsOneWidget,
        );
        expect(find.text('Allow matching commands'), findsOneWidget);
        expect(find.text('Allow once'), findsOneWidget);
        expect(find.text('Allow for session'), findsNothing);
      },
    );

    testWidgets('an option the app cannot answer is ignored, not drawn', (
      tester,
    ) async {
      await tester.pumpWidget(
        _permissionPage(
          requestId: 'perm-unknown',
          options: const [
            'approve',
            'approve-session',
            'reject',
            'reject-with-feedback',
          ],
        ),
      );
      await tester.pumpAndSettle();

      // The three answers we can send, and nothing standing in for the fourth.
      expect(_answerButtons('perm-unknown'), findsNWidgets(3));
      expect(find.textContaining('reject-with-feedback'), findsNothing);
    });

    testWidgets('an unknown option alone leaves the default two answers', (
      tester,
    ) async {
      await tester.pumpWidget(
        _permissionPage(
          requestId: 'perm-only-unknown',
          options: const ['approve', 'reject', 'escalate-to-owner'],
        ),
      );
      await tester.pumpAndSettle();

      expect(_answerButtons('perm-only-unknown'), findsNWidgets(2));
      expect(find.textContaining('escalate-to-owner'), findsNothing);
    });

    testWidgets('a read-only request renders no answer buttons at all', (
      tester,
    ) async {
      await tester.pumpWidget(
        _permissionPage(
          requestId: 'perm-observe-only',
          options: const ['approve', 'approve-session', 'reject'],
          readOnly: true,
        ),
      );
      await tester.pumpAndSettle();

      // The card itself is on screen — the absence below is not vacuous.
      expect(find.text('Run command'), findsOneWidget);
      expect(_answerButtons('perm-observe-only'), findsNothing);
    });
  });
}
