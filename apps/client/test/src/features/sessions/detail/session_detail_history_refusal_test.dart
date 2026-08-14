import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

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

void main() {
  group('history unavailable presentation', () {
    testWidgets(
      'a refused history with a bounded replay shows neither start nor empty',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: [
            HistoryWireEvent(
              messages: _messages(6),
              reset: true,
              cursor: 'tail-cursor',
              hasEarlier: true,
              truncated: const HistoryTruncation(shown: 6, total: 996),
              gap: _resourceLimitGap,
            ),
          ],
        );
        await _pumpTranscript(tester, connection);

        expect(find.textContaining('Message 6'), findsOneWidget);
        expect(
          find.byKey(const Key('session-history-start-marker')),
          findsNothing,
          reason: 'a refusal cannot prove the start of the session',
        );
        final l10n = await AppLocalizations.delegate.load(const Locale('en'));
        expect(
          find.text(l10n.sessionDetailTranscriptEmpty),
          findsNothing,
          reason: 'a refusal cannot prove the session has no messages',
        );
        final gapText = tester.widget<Text>(
          find.byKey(const Key('session-history-gap-text')),
        );
        expect(gapText.data, isNot(contains('full replay')));
        expect(
          gapText.data,
          l10n.sessionHistoryUnavailable('HISTORY_PAGE_RESOURCE_LIMIT'),
          reason:
              'the visible sentence must be localized copy and nothing else',
        );
      },
    );

    testWidgets(
      'a refusal with no replay keeps the pages an initialized client holds',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: [
            HistoryWireEvent(
              messages: _messages(5),
              reset: true,
              cursor: 'first-cursor',
              hasEarlier: true,
              truncated: const HistoryTruncation(shown: 5, total: 400),
            ),
          ],
        );
        await _pumpTranscript(tester, connection);
        expect(find.textContaining('Message 5'), findsOneWidget);

        // The reconnect the broker cannot serve: no replacement, no messages,
        // no cursor move — only the truthful gap.
        connection.emitEvent(
          const HistoryWireEvent(
            messages: [],
            gap: HistoryGap(
              code: 'HISTORY_PAGE_RESOURCE_LIMIT',
              reason: 'resource-limit',
              message:
                  'This native history exceeds every bounded reader; no '
                  'messages could be replayed. Reconnect to retry.',
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.textContaining('Message 5'),
          findsOneWidget,
          reason: 'a refusal must never erase a retained client window',
        );
        expect(
          find.byKey(const Key('session-history-start-marker')),
          findsNothing,
        );
        final l10n = await AppLocalizations.delegate.load(const Locale('en'));
        expect(find.text(l10n.sessionDetailTranscriptEmpty), findsNothing);
      },
    );

    // The broker now reads a bounded tail wherever whole-source indexing is
    // refused, so this contentless frame is the LAST RESORT — reached only when
    // even that read is impossible. It still may not claim a start or an empty
    // session. The cases where a tail IS available are pinned on the wire in
    // `test-history-refusal-wire.ts` and against real ceilings in
    // `history-refusal-tail.ts`.
    testWidgets(
      'the last-resort contentless refusal still refuses to claim a start',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            HistoryWireEvent(
              messages: [],
              gap: HistoryGap(
                code: 'HISTORY_PAGE_RESOURCE_LIMIT',
                reason: 'resource-limit',
                message:
                    'This native history exceeds every bounded reader; no '
                    'messages could be replayed. Reconnect to retry.',
              ),
            ),
          ],
        );
        await _pumpTranscript(tester, connection);

        final l10n = await AppLocalizations.delegate.load(const Locale('en'));
        expect(
          find.byKey(const Key('session-history-start-marker')),
          findsNothing,
        );
        expect(find.text(l10n.sessionDetailTranscriptEmpty), findsNothing);
        expect(
          find.byKey(const Key('session-history-gap-text')),
          findsOneWidget,
          reason: 'the gap is the only truthful thing to render here',
        );
      },
    );

    testWidgets('a later refusal retracts an earlier true start marker', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          HistoryWireEvent(
            messages: _messages(3),
            reset: true,
            cursor: 'complete-cursor',
          ),
        ],
      );
      await _pumpTranscript(tester, connection);
      expect(
        find.byKey(const Key('session-history-start-marker')),
        findsOneWidget,
        reason: 'a complete replay genuinely reaches the start',
      );

      connection.emitEvent(
        const HistoryWireEvent(
          messages: [],
          gap: HistoryGap(
            code: 'HISTORY_PAGE_SOURCE_CHANGED',
            reason: 'source-changed',
            message:
                'This session changed while its history was being read; no '
                'messages could be replayed. Reconnect to retry.',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-history-start-marker')),
        findsNothing,
        reason: 'a source that can no longer be read cannot prove its start',
      );
      expect(find.textContaining('Message 3'), findsOneWidget);
    });

    testWidgets('an ordinary cursor gap still reports its full replay', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          HistoryWireEvent(
            messages: _messages(4),
            reset: true,
            cursor: 'replayed',
            gap: const HistoryGap(
              code: 'HISTORY_CURSOR_DIVERGED',
              reason: 'cursor-prefix-mismatch',
              message:
                  'history cursor no longer matches this session; full replay '
                  'was sent',
            ),
          ),
        ],
      );
      await _pumpTranscript(tester, connection);

      final l10n = await AppLocalizations.delegate.load(const Locale('en'));
      final gapText = tester.widget<Text>(
        find.byKey(const Key('session-history-gap-text')),
      );
      expect(
        gapText.data,
        contains(
          l10n.sessionHistoryCursorUnavailable('HISTORY_CURSOR_DIVERGED'),
        ),
        reason: 'a stale cursor really was answered with a full replay',
      );
    });
  });

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
