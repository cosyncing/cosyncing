import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_freshness.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_roster_identity.dart';
import 'package:cosyncing_client/src/features/sessions/view/roster_freshness_slot.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// R0b: a completed roster failure is actionable, and Retry has one owner.
void main() {
  CachedRosterPresentation cached(CachedRosterReason reason) =>
      CachedRosterPresentation(
        snapshot: SessionRosterSnapshot(
          brokerProfileId: 'profile-a',
          rows: const [
            SessionRosterIdentity(
              tool: 'codex',
              sessionId: 'cached',
              title: 'Cached session',
              machine: 'mac',
              cwd: '/work/alpha',
            ),
          ],
          capturedAt: DateTime.utc(2026),
          omittedRowCount: 0,
        ),
        reason: reason,
      );

  group('a failed roster refresh is actionable, not permanently busy', () {
    test('a failure that retained rows is failed, and the slot owns Retry', () {
      final freshness = RosterFreshnessPresentation.fromListState(
        const SessionListState(
          status: SessionListStatus.error,
          error: 'broker unreachable',
          sessions: [
            SessionInfo(
              id: 'kept',
              tool: 'codex',
              title: 'Kept session',
              status: SessionStatus.idle,
              attachMode: AttachMode.resume,
            ),
          ],
        ),
      );

      // Calling this `reconnecting` made `isBusy` true forever: the shared slot
      // spun with nothing in flight and offered no way out.
      expect(freshness.freshness, SessionFreshness.failed);
      expect(freshness.freshness.isBusy, isFalse);
      expect(freshness.slotOwnsRecovery, isTrue);
      expect(freshness.error, 'broker unreachable');
    });

    test('a failure with only cached rows leaves Retry to the cached pane', () {
      final freshness = RosterFreshnessPresentation.fromListState(
        SessionListState(
          status: SessionListStatus.error,
          error: 'broker unreachable',
          cachedRoster: cached(CachedRosterReason.unreachable),
        ),
      );

      expect(freshness.freshness, SessionFreshness.failed);
      expect(freshness.slotOwnsRecovery, isFalse);
    });

    test('a failure with nothing retained leaves Retry to the error page', () {
      final freshness = RosterFreshnessPresentation.fromListState(
        const SessionListState(
          status: SessionListStatus.error,
          error: 'broker unreachable',
        ),
      );

      expect(freshness.freshness, SessionFreshness.failed);
      expect(freshness.slotOwnsRecovery, isFalse);
    });

    test('a reconnect with cached rows is still busy and stale', () {
      final freshness = RosterFreshnessPresentation.fromListState(
        SessionListState(cachedRoster: cached(CachedRosterReason.hydrating)),
      );

      expect(freshness.freshness, SessionFreshness.reconnecting);
      expect(freshness.freshness.isBusy, isTrue);
      expect(freshness.freshness.isStale, isTrue);
    });
  });

  group('the slot renders exactly one owner of recovery', () {
    Widget host(RosterFreshnessPresentation presentation, VoidCallback onTap) {
      return MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(
          themeSpecById(kDefaultThemeId).light,
          Brightness.light,
        ),
        home: Scaffold(
          appBar: AppBar(
            actions: [
              RosterFreshnessSlot(
                presentation: presentation,
                onRefresh: onTap,
              ),
            ],
          ),
        ),
      );
    }

    testWidgets('a retained-content failure offers Retry from the slot', (
      tester,
    ) async {
      var taps = 0;
      await tester.pumpWidget(
        host(
          const RosterFreshnessPresentation(
            freshness: SessionFreshness.failed,
            error: 'broker unreachable',
            slotOwnsRecovery: true,
          ),
          () => taps++,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('roster-freshness-retry')), findsOneWidget);
      expect(find.byKey(const Key('roster-freshness-busy')), findsNothing);
      await tester.tap(find.byKey(const Key('roster-freshness-retry')));
      expect(taps, 1);
    });

    testWidgets('a failure owned by the content offers nothing in the slot', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          const RosterFreshnessPresentation(
            freshness: SessionFreshness.failed,
            error: 'broker unreachable',
          ),
          () {},
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('roster-freshness-slot')), findsOneWidget);
      expect(
        find.byKey(const Key('roster-freshness-deferred')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('roster-freshness-retry')), findsNothing);
      expect(find.byKey(const Key('roster-freshness-refresh')), findsNothing);
    });

    testWidgets('every state keeps the same slot footprint', (tester) async {
      for (final presentation in const [
        RosterFreshnessPresentation(freshness: SessionFreshness.current),
        RosterFreshnessPresentation(freshness: SessionFreshness.refreshing),
        RosterFreshnessPresentation(freshness: SessionFreshness.reconnecting),
        RosterFreshnessPresentation(freshness: SessionFreshness.initialLoading),
        RosterFreshnessPresentation(freshness: SessionFreshness.failed),
        RosterFreshnessPresentation(
          freshness: SessionFreshness.failed,
          slotOwnsRecovery: true,
        ),
      ]) {
        await tester.pumpWidget(host(presentation, () {}));
        await tester.pump();
        expect(
          tester.getSize(find.byKey(const Key('roster-freshness-slot'))),
          const Size(
            RosterFreshnessSlot.slotExtent,
            RosterFreshnessSlot.slotExtent,
          ),
          reason: '${presentation.freshness} changed the header layout',
        );
      }
    });
  });
}
