// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_result.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_page.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/requests/session_command_args_codec.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener.dart';
import 'package:cosyncing_client/src/features/voice/controller/voice_input_controller.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:flutter/gestures.dart' show kSecondaryMouseButton;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_session_display_preferences_store.dart';
import '../../../../support/in_memory_session_live_state_view_store.dart';
import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('SessionDetailPage native rename', () {
    SessionWireEvent sessionEvent(String title) => SessionWireEvent(
      info: SessionInfo.fromJson({
        'id': 'session-1',
        'tool': 'claude',
        'title': title,
        'status': 'idle',
        'attachMode': 'observe',
      }),
    );

    testWidgets('renames from the capability-gated header action', (
      tester,
    ) async {
      final brokerClient = FakeBrokerClient();
      final openSessions = InMemoryOpenSessionsStore(
        snapshot: const OpenSessionsSnapshot(
          refs: [
            SessionRef(
              tool: 'claude',
              id: 'session-1',
              title: 'Before',
              status: SessionStatus.idle,
            ),
            SessionRef(
              tool: 'codex',
              id: 'other',
              title: 'Other',
              status: SessionStatus.idle,
            ),
          ],
          activeKey: 'claude/session-1',
        ),
      );
      tester.view.physicalSize = const Size(600, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [sessionEvent('Before')],
          brokerClient: brokerClient,
          openSessionsStore: openSessions,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Before'), findsNWidgets(2));
      // The title is the affordance: tapping converts it in place, and Enter
      // commits. There is no dialog and no save button any more.
      await tester.tap(
        find.byKey(const Key('session-detail-rename-button')),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('session-detail-rename-input')),
        'After',
      );
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();

      expect(brokerClient.renameSessionCount, 1);
      expect(brokerClient.lastRenameTitle, 'After');
      expect(find.text('After'), findsNWidgets(2));
      expect(find.text('Before'), findsNothing);
      expect(
        find.descendant(
          of: find.byKey(const Key('open-session-tab-claude/session-1')),
          matching: find.text('After'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('hides rename when the broker capability is unavailable', (
      tester,
    ) async {
      final brokerClient = FakeBrokerClient(
        agents: [fakeAgentInfo(canRenameNative: false)],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [sessionEvent('Read only title')],
          brokerClient: brokerClient,
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-rename-button')),
        findsNothing,
      );
    });
  });
}
