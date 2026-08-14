import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('SessionDetailPage interrupt safety', () {
    const drivingControl = {
      'drive': {'state': 'driving', 'supported': true},
      'terminalSync': {
        'supported': false,
        'syncAvailable': false,
        'active': false,
      },
    };

    SessionWireEvent sessionEvent({
      required Map<String, dynamic> control,
      String status = 'idle',
    }) {
      return SessionWireEvent(
        info: SessionInfo.fromJson({
          'id': 'session-1',
          'tool': 'claude',
          'title': 'Model controls',
          'status': status,
          'attachMode': 'observe',
          'control': control,
        }),
      );
    }

    testWidgets('pending Stop disables send until the turn leaves working', (
      tester,
    ) async {
      final stopWrite = Completer<void>();
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(control: drivingControl, status: 'working'),
          const CommandsWireEvent(
            commands: [
              SlashCommand(name: 'stop', kind: SlashCommandKind.action),
            ],
          ),
        ],
        onSendCommand: () => stopWrite.future,
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      final send = find.byKey(const Key('session-detail-send-button'));
      await tester.enterText(input, 'keep this draft');
      await tester.pump();
      expect(tester.widget<IconButton>(send).onPressed, isNotNull);

      await tester.tap(
        find.byKey(const Key('session-detail-interrupt-button')),
      );
      await tester.pump();
      expect(tester.widget<IconButton>(send).onPressed, isNull);

      // The keyboard path is subject to the same pending-Stop guard.
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();
      expect(connection.sendPromptCount, 0);

      stopWrite.complete();
      await tester.pumpAndSettle();
      // The transport write completed, but Stop remains requested until the
      // current working turn actually changes state.
      expect(tester.widget<IconButton>(send).onPressed, isNull);

      connection.emitSessionControl(drivingControl);
      await tester.pumpAndSettle();
      expect(tester.widget<IconButton>(send).onPressed, isNotNull);
    });

    testWidgets('delayed Stop never restores over a newer composer revision', (
      tester,
    ) async {
      final stopWrite = Completer<void>();
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(control: drivingControl),
          const CommandsWireEvent(
            commands: [
              SlashCommand(name: 'stop', kind: SlashCommandKind.action),
            ],
          ),
        ],
        onSendCommand: () => stopWrite.future,
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'accepted prompt');
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();
      connection.emitSessionControl(drivingControl, status: 'working');
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('session-detail-interrupt-button')),
      );
      await tester.pump();
      await tester.enterText(input, 'new draft typed during Stop');
      await tester.pump();
      // Returning to empty is still an edit. An empty-only ownership check
      // would incorrectly resurrect the older accepted prompt here.
      await tester.enterText(input, '');
      await tester.pump();
      stopWrite.complete();
      await tester.pumpAndSettle();

      expect(tester.widget<TextField>(input).controller?.text, isEmpty);
    });

    testWidgets('delayed Stop never restores over a newer accepted send', (
      tester,
    ) async {
      final stopWrite = Completer<void>();
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(control: drivingControl),
          const CommandsWireEvent(
            commands: [
              SlashCommand(name: 'stop', kind: SlashCommandKind.action),
            ],
          ),
        ],
        onSendCommand: () => stopWrite.future,
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'older accepted prompt');
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();
      connection.emitSessionControl(drivingControl, status: 'working');
      await tester.pumpAndSettle();

      await tester.enterText(input, 'newer accepted prompt');
      await tester.pump();
      expect(
        tester
            .widget<IconButton>(
              find.byKey(const Key('session-detail-send-button')),
            )
            .onPressed,
        isNotNull,
      );
      tester
          .widget<IconButton>(
            find.byKey(const Key('session-detail-send-button')),
          )
          .onPressed!();
      // Start Stop before the async send has accepted the newer prompt. This
      // captures the older restore snapshot while both operations are live.
      tester
          .widget<IconButton>(
            find.byKey(const Key('session-detail-interrupt-button')),
          )
          .onPressed!();

      await tester.pump();
      await tester.pump();
      expect(tester.widget<TextField>(input).controller?.text, isEmpty);
      stopWrite.complete();
      await tester.pumpAndSettle();

      expect(tester.widget<TextField>(input).controller?.text, isEmpty);
    });
  });
}
