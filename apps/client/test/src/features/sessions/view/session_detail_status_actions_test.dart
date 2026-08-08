import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_detail_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// V1/V2-R1 Status-action refinements: distinct icons, purposeful groups, a
/// labeled Local data zone, an All-profiles scope chip, token-driven
/// destructive confirmation, and disabled reasons — in English and Chinese.
void main() {
  Icon leadingIconOf(WidgetTester tester, Key tileKey) {
    final tile = tester.widget<ListTile>(find.byKey(tileKey));
    return tile.leading! as Icon;
  }

  Future<void> openStatusTab(WidgetTester tester) async {
    await tester.pumpAndSettle();
    await openSessionDetailTestTab(tester, 'session-detail-tab-status');
  }

  group('Session Detail Status actions refinement', () {
    testWidgets('Duplicate and Copy transcript carry distinct icons', (
      tester,
    ) async {
      await tester.pumpWidget(buildSessionDetailTestPage(events: const []));
      await openStatusTab(tester);
      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-copy-transcript-button'),
      );

      final duplicate = leadingIconOf(
        tester,
        const Key('session-detail-clone-button'),
      );
      final copyTranscript = leadingIconOf(
        tester,
        const Key('session-detail-copy-transcript-button'),
      );
      expect(duplicate.icon, Icons.difference_outlined);
      expect(copyTranscript.icon, Icons.copy_all_outlined);
      expect(duplicate.icon, isNot(copyTranscript.icon));
    });

    testWidgets(
      'actions are grouped into Session, Transcript, and Local data zones',
      (tester) async {
        await tester.pumpWidget(buildSessionDetailTestPage(events: const []));
        await openStatusTab(tester);
        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-clear-all-cache-button'),
        );

        for (final (group, tile) in [
          ('session-actions-group-session', 'session-detail-detach-button'),
          ('session-actions-group-session', 'session-detail-fork-button'),
          ('session-actions-group-session', 'session-detail-clone-button'),
          (
            'session-actions-group-transcript',
            'session-detail-export-transcript-button',
          ),
          (
            'session-actions-group-transcript',
            'session-detail-copy-transcript-button',
          ),
          (
            'session-actions-group-local-data',
            'session-detail-clear-current-cache-button',
          ),
          (
            'session-actions-group-local-data',
            'session-detail-clear-all-cache-button',
          ),
        ]) {
          expect(
            find.descendant(
              of: find.byKey(Key(group)),
              matching: find.byKey(Key(tile)),
            ),
            findsOneWidget,
            reason: '$tile must live in $group',
          );
        }

        // The Local data zone is labeled, and the all-local action carries the
        // scope chip. Persistent rows stay ListTiles — no solid red cards.
        expect(
          find.byKey(const Key('session-actions-local-data-caption')),
          findsOneWidget,
        );
        expect(
          find.text('Local data — rebuildable, but gone until re-synced'),
          findsOneWidget,
        );
        final chip = tester.widget<MetadataChip>(
          find.byKey(const Key('session-detail-clear-all-cache-scope-chip')),
        );
        expect(chip.label, 'All profiles');
      },
    );

    testWidgets('destructive confirmation buttons use statusError', (
      tester,
    ) async {
      await tester.pumpWidget(buildSessionDetailTestPage(events: const []));
      await openStatusTab(tester);
      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-clear-all-cache-button'),
      );
      await tester.tap(
        find.byKey(const Key('session-detail-clear-all-cache-button')),
      );
      await tester.pumpAndSettle();

      final confirmFinder = find.byKey(
        const Key('session-detail-clear-all-cache-confirm'),
      );
      final tokens = Theme.of(
        tester.element(confirmFinder),
      ).extension<AppTokens>()!;
      final confirm = tester.widget<FilledButton>(confirmFinder);
      expect(
        confirm.style?.backgroundColor?.resolve(const {}),
        tokens.statusError,
      );
      // The consequence explanation stays selectable.
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a missing tool capability explains the disabled rows', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          brokerClient: FakeBrokerClient(
            agents: [
              fakeAgentInfo(canClone: false, canTranscriptExport: false),
            ],
          ),
        ),
      );
      await openStatusTab(tester);
      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-export-transcript-button'),
      );

      expect(
        find.byKey(const Key('session-detail-clone-disabled-reason')),
        findsOneWidget,
      );
      expect(
        find.text("This agent type can't duplicate sessions."),
        findsOneWidget,
      );
      expect(
        find.text("This agent type can't export transcripts."),
        findsOneWidget,
      );
    });

    testWidgets('a supported but unavailable action explains the connection', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          withActiveBrokerClient: false,
        ),
      );
      await openStatusTab(tester);
      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-clone-button'),
      );

      expect(
        tester
            .widget<Text>(
              find.byKey(const Key('session-detail-clone-disabled-reason')),
            )
            .data,
        'Available while the session is connected.',
      );
    });

    testWidgets(
      'capabilities still loading on a connected session never read as offline',
      (tester) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            brokerClient: _PendingAgentsBrokerClient(),
          ),
        );
        await openStatusTab(tester);
        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-export-transcript-button'),
        );

        for (final key in const [
          Key('session-detail-clone-disabled-reason'),
          Key('session-detail-export-disabled-reason'),
        ]) {
          expect(
            tester.widget<Text>(find.byKey(key)).data,
            'Checking what this agent type supports…',
          );
        }
        // The P1 contradiction this guards against: the session is connected,
        // so the subtitle must not tell the user to connect.
        expect(
          find.text('Available while the session is connected.'),
          findsNothing,
        );
      },
    );

    testWidgets(
      'read-only compatibility on a connected session names itself',
      (tester) async {
        const brokerContract = BrokerContractIdentity(
          revision: 6,
          minimumClientRevision: 0,
          surfaceHash: 'fnv1a32:095fc995',
        );
        final connection = ScriptedSessionDetailConnection(
          events: const [
            HelloWireEvent(
              brokerVersion: '0.1.0',
              brokerContract: brokerContract,
              compatibility: BrokerClientCompatibility(
                status: BrokerClientCompatibilityStatus.hardIncompatible,
                readOnly: true,
                reason: 'equal revisions advertise different public surfaces',
                broker: brokerContract,
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await openStatusTab(tester);
        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-export-transcript-button'),
        );

        for (final key in const [
          Key('session-detail-clone-disabled-reason'),
          Key('session-detail-export-disabled-reason'),
        ]) {
          expect(
            tester.widget<Text>(find.byKey(key)).data,
            'Unavailable while compatibility keeps this session read-only.',
          );
        }
        expect(
          find.text('Available while the session is connected.'),
          findsNothing,
        );
      },
    );

    testWidgets(
      'a failed capability read never claims the agent type lacks support',
      (tester) async {
        final broker = _FlakyAgentsBrokerClient();
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], brokerClient: broker),
        );
        await openStatusTab(tester);
        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-export-transcript-button'),
        );

        expect(broker.listAgentsCalls, 1);
        for (final key in const [
          Key('session-detail-clone-disabled-reason'),
          Key('session-detail-export-disabled-reason'),
        ]) {
          expect(
            tester.widget<Text>(find.byKey(key)).data,
            "Couldn't confirm what this agent type supports.",
          );
        }
        // The P1 this guards against: a transient /api/agents failure must
        // not be presented as a permanent agent-type limitation.
        expect(find.textContaining("This agent type can't"), findsNothing);

        // Recovery: a forced re-attach retries the read; with the loaded
        // capabilities back, the rows enable and the reasons disappear.
        final container = ProviderScope.containerOf(
          tester.element(find.byType(SessionDetailPage)),
        );
        await container
            .read(
              sessionDetailControllerProvider(
                const SessionDetailKey(tool: 'claude', sessionId: 'session-1'),
              ).notifier,
            )
            .attach(force: true);
        await tester.pumpAndSettle();
        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-export-transcript-button'),
        );

        expect(broker.listAgentsCalls, greaterThan(1));
        expect(
          tester
              .widget<ListTile>(
                find.byKey(const Key('session-detail-clone-button')),
              )
              .enabled,
          isTrue,
        );
        expect(
          tester
              .widget<ListTile>(
                find.byKey(
                  const Key('session-detail-export-transcript-button'),
                ),
              )
              .enabled,
          isTrue,
        );
        expect(
          find.byKey(const Key('session-detail-clone-disabled-reason')),
          findsNothing,
        );
        expect(
          find.byKey(const Key('session-detail-export-disabled-reason')),
          findsNothing,
        );
      },
    );

    for (final (densityName, density) in [
      ('Compact', UiDensity.compact),
      ('Roomy', UiDensity.spacious),
    ]) {
      testWidgets(
        'grouping, zone label, and chip hold at $densityName density',
        (tester) async {
          await tester.pumpWidget(
            buildSessionDetailTestPage(
              events: const [],
              theme: buildAppTheme(
                themeSpecById(kDefaultThemeId).light,
                Brightness.light,
                density: density.visualDensity,
              ),
            ),
          );
          await openStatusTab(tester);
          await showSessionStatusTestItem(
            tester,
            const Key('session-detail-clear-all-cache-button'),
          );

          for (final key in const [
            Key('session-actions-group-session'),
            Key('session-actions-group-transcript'),
            Key('session-actions-group-local-data'),
            Key('session-actions-local-data-caption'),
            Key('session-detail-clear-all-cache-scope-chip'),
          ]) {
            expect(
              find.byKey(key),
              findsOneWidget,
              reason: '$key must survive $densityName density',
            );
          }
        },
      );
    }

    testWidgets('grouping, zone label, chip, and reasons render in Chinese', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          locale: const Locale('zh'),
          brokerClient: FakeBrokerClient(
            agents: [
              fakeAgentInfo(canClone: false, canTranscriptExport: false),
            ],
          ),
        ),
      );
      await openStatusTab(tester);
      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-clear-all-cache-button'),
      );

      expect(find.text('本地数据 — 可重建，重新同步前不可用'), findsOneWidget);
      expect(
        tester
            .widget<MetadataChip>(
              find.byKey(
                const Key('session-detail-clear-all-cache-scope-chip'),
              ),
            )
            .label,
        '所有配置',
      );
      expect(find.text('此代理类型不支持复制会话。'), findsOneWidget);
      expect(find.text('此代理类型不支持导出对话记录。'), findsOneWidget);

      await tester.tap(
        find.byKey(const Key('session-detail-clear-all-cache-button')),
      );
      await tester.pumpAndSettle();
      expect(find.text('清除全部缓存'), findsOneWidget);
    });
  });
}

/// Broker whose /api/agents call never resolves, holding a connected session
/// in the capabilities-pending state.
class _PendingAgentsBrokerClient extends FakeBrokerClient {
  final _never = Completer<List<AgentInfo>>();

  @override
  Future<List<AgentInfo>> listAgents() => _never.future;
}

/// Broker whose first /api/agents call rejects and later calls succeed —
/// a transient capability-read failure with recovery.
class _FlakyAgentsBrokerClient extends FakeBrokerClient {
  int listAgentsCalls = 0;

  @override
  Future<List<AgentInfo>> listAgents() async {
    listAgentsCalls += 1;
    if (listAgentsCalls == 1) {
      throw StateError('transient agents read failure');
    }
    return agents;
  }
}
