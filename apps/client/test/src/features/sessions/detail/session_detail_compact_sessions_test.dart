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
  group('SessionDetailPage compact session strip', () {
    final openSessions = InMemoryOpenSessionsStore(
      snapshot: const OpenSessionsSnapshot(
        refs: [
          SessionRef(
            tool: 'claude',
            id: 'session-1',
            title: 'Current',
            status: SessionStatus.idle,
          ),
          SessionRef(
            tool: 'codex',
            id: 'session-2',
            title: 'Other',
            status: SessionStatus.needsInput,
          ),
        ],
        activeKey: 'claude/session-1',
      ),
    );

    testWidgets('renders the working set above detail on compact windows', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          openSessionsStore: openSessions,
          theme: buildAppTheme(
            themeSpecById(kDefaultThemeId).light,
            Brightness.light,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final current = find.byKey(
        const Key('open-session-tab-claude/session-1'),
      );
      final other = find.byKey(const Key('open-session-tab-codex/session-2'));
      expect(current, findsOneWidget);
      expect(other, findsOneWidget);
      expect(
        tester.getTopLeft(current).dy,
        lessThan(
          tester
              .getTopLeft(find.byKey(const Key('session-detail-view-menu')))
              .dy,
        ),
      );
    });

    testWidgets('embedded detail omits duplicate app and session bars', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          openSessionsStore: openSessions,
          embedded: true,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(AppBar), findsNothing);
      expect(
        find.byKey(const Key('open-session-tab-claude/session-1')),
        findsNothing,
      );
    });
  });
}
