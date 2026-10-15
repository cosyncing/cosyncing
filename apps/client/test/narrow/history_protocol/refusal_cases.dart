import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/session_detail_page_test_harness.dart';

/// H1c — a bounded large-history refusal never renders as an empty session.
///
/// The reproduced defect put three mutually exclusive claims on screen at once:
/// the broker "sent a full replay", the transcript was at the "Start of
/// session", and there were "No messages in this session yet". Each test here
/// pins one of those to the truth.

List<AgentMessage> _messages(int count, {int startSeq = 1}) => [
  for (var i = 0; i < count; i++)
    AgentMessage(
      type: AgentMessageType.userMessage,
      id: 'refusal-message-${startSeq + i}',
      raw: {'type': 'user-message', 'text': 'Message ${startSeq + i}'},
    ),
];

const _resourceLimitGap = HistoryGap(
  code: 'HISTORY_PAGE_RESOURCE_LIMIT',
  reason: 'resource-limit',
  message:
      'This native history exceeds the bounded paging index; the newest '
      'messages are shown and earlier ones cannot be loaded.',
);

Future<void> _pumpTranscript(
  WidgetTester tester,
  ScriptedSessionDetailConnection connection,
) async {
  await tester.pumpWidget(
    buildSessionDetailTestPage(events: const [], connection: connection),
  );
  await tester.pumpAndSettle();
}

void defineRefusalCases() {
  group('localized gap presentation', () {
    testWidgets('Chinese copy is not followed by English broker prose', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          HistoryWireEvent(
            messages: _messages(4),
            reset: true,
            cursor: 'zh-cursor',
            hasEarlier: true,
            truncated: const HistoryTruncation(shown: 4, total: 900),
            gap: _resourceLimitGap,
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          locale: const Locale('zh'),
        ),
      );
      await tester.pumpAndSettle();

      final zh = await AppLocalizations.delegate.load(const Locale('zh'));
      final gapText = tester.widget<Text>(
        find.byKey(const Key('session-history-gap-text')),
      );
      expect(
        gapText.data,
        zh.sessionHistoryUnavailable('HISTORY_PAGE_RESOURCE_LIMIT'),
      );
      // The broker's own sentence is English operator prose. It may exist in
      // the tree, but never inside the localized line.
      expect(gapText.data, isNot(contains('bounded paging index')));
      expect(gapText.data, isNot(contains('newest messages'))); // S2 boundary
    });

    testWidgets('raw broker detail stays behind technical details', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          HistoryWireEvent(
            messages: _messages(4),
            reset: true,
            cursor: 'detail-cursor',
            hasEarlier: true,
            truncated: const HistoryTruncation(shown: 4, total: 900),
            gap: _resourceLimitGap,
          ),
        ],
      );
      await _pumpTranscript(tester, connection);

      // Collapsed by default: the raw text is available, not displayed.
      expect(find.byKey(const Key('session-history-gap-detail')), findsNothing);
      final expander = find.byKey(
        const Key('session-history-gap-technical-details'),
      );
      expect(expander, findsOneWidget);
      await tester.tap(expander);
      await tester.pumpAndSettle();
      final detail = tester.widget<SelectableText>(
        find.byKey(const Key('session-history-gap-detail')),
      );
      expect(detail.data, _resourceLimitGap.message);
    });
  });

  group('isHistoryUnavailableGapCode', () {
    test('covers exactly the codes that describe an unreadable history', () {
      for (final code in const [
        'HISTORY_PAGE_RESOURCE_LIMIT',
        'HISTORY_PAGE_SOURCE_CHANGED',
        'HISTORY_PAGE_SOURCE_UNVERSIONED',
      ]) {
        expect(isHistoryUnavailableGapCode(code), isTrue, reason: code);
      }
      for (final code in const [
        'HISTORY_CURSOR_INVALID',
        'HISTORY_CURSOR_GONE',
        'HISTORY_CURSOR_DIVERGED',
        null,
      ]) {
        expect(isHistoryUnavailableGapCode(code), isFalse, reason: '$code');
      }
    });
  });
}
