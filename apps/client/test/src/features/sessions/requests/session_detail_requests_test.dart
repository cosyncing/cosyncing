import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('SessionDetailPage request actions', () {
    testWidgets('request actions use pointer and touch target heights', (
      tester,
    ) async {
      for (final testCase in const [
        (TargetPlatform.linux, 32.0),
        (TargetPlatform.windows, 32.0),
        (TargetPlatform.android, 40.0),
        (TargetPlatform.iOS, 40.0),
      ]) {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-target',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            theme: buildAppTheme(
              themeSpecById(kDefaultThemeId).light,
              Brightness.light,
            ).copyWith(platform: testCase.$1),
          ),
        );
        await tester.pumpAndSettle();

        final action = find.byKey(
          const Key('session-detail-permission-approve-perm-target'),
        );
        await tester.ensureVisible(action);
        expect(
          tester.getSize(action).height,
          testCase.$2,
          reason: '${testCase.$1}',
        );
      }
    });
  });
}
