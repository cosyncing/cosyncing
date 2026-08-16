import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/router.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/roster/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_identity.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_roster_snapshot_repository.dart';
import '../../../../support/in_memory_session_display_preferences_store.dart';
import '../../../../support/in_memory_session_live_state_view_store.dart';
import '../../../../support/roster_expansion.dart';
import '../../../../support/session_detail_page_test_harness.dart';

/// U3-A/B — the title Session Detail shows while its session frame is
/// outstanding.
///
/// The defect: `SessionDetailPage` fell back to `widget.sessionId` whenever
/// `sessionInfo` was unresolved, so opening a named session flashed its native
/// fingerprint — for the whole of a slow attach — before the name appeared.
/// Every case below therefore *holds* the bootstrap open (a connection that
/// never connects, or a roster that never answers) rather than settling it.
void main() {
  late InMemorySessionListRepository fakeRepo;

  setUp(() {
    fakeRepo = InMemorySessionListRepository();
  });

  List<Override> localStorageOverrides({RosterSnapshotRepository? snapshots}) {
    final database = AppDatabase(NativeDatabase.memory());
    addTearDown(database.close);
    return [
      appDatabaseProvider.overrideWithValue(database),
      rosterSnapshotRepositoryProvider.overrideWithValue(
        snapshots ?? InMemoryRosterSnapshotRepository(),
      ),
    ];
  }

  /// A routed app whose Session Detail connection never resolves, so the page
  /// stays in the exact pre-`sessionInfo` window this lane is about.
  Widget buildRoutedSubject({
    List<SessionInfo>? sessions,
    SessionListRepository? repository,
    RosterSnapshotRepository? snapshots,
    OpenSessionsStore? openSessions,
    void Function(_HeldSessionDetailConnection connection)? onConnection,
  }) {
    fakeRepo.sessions = sessions ?? [];
    return ProviderScope(
      overrides: [
        ...localStorageOverrides(snapshots: snapshots),
        openSessionsStoreProvider.overrideWithValue(
          openSessions ?? InMemoryOpenSessionsStore(),
        ),
        sessionListRepositoryProvider.overrideWith(
          (ref) async => repository ?? fakeRepo,
        ),
        sessionDisplayPreferencesStoreProvider.overrideWithValue(
          InMemorySessionDisplayPreferencesStore(),
        ),
        sessionLiveStateViewStoreProvider.overrideWithValue(
          InMemorySessionLiveStateViewStore(),
        ),
        sessionArtifactTransferRepositoryProvider.overrideWithValue(
          InMemorySessionArtifactTransferRepository(),
        ),
        activeBrokerProfileProvider.overrideWith(
          (ref) => BrokerProfile(
            id: 'local',
            displayName: 'local',
            baseUri: Uri.parse('http://127.0.0.1:7734'),
            createdAt: DateTime(2026, 7, 27),
          ),
        ),
        sessionDetailConnectionFactoryProvider.overrideWithValue(
          ({required resolver, required sessionId, required tool}) {
            final connection = _HeldSessionDetailConnection();
            onConnection?.call(connection);
            return connection;
          },
        ),
      ],
      child: MaterialApp.router(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(
          themeSpecById(kDefaultThemeId).light,
          Brightness.light,
        ),
        routerConfig: createGoRouter(),
      ),
    );
  }

  void useCompactViewport(WidgetTester tester) {
    tester.view
      ..physicalSize = const Size(420, 900)
      ..devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  /// The session title as the top strip actually renders it.
  Finder stripTitle(String text) => find.descendant(
    of: find.byKey(const Key('session-detail-top-strip')),
    matching: find.text(text),
  );

  /// The composer's current text, or null when there is no composer field.
  ///
  /// A session the client may not prompt renders a blocked hint instead of a
  /// field — which is also a composer holding nothing.
  String? composerText(WidgetTester tester) {
    final field = find.byKey(const Key('session-detail-prompt-input'));
    if (field.evaluate().isEmpty) return null;
    return tester.widget<TextField>(field).controller!.text;
  }

  /// Fails on the FIRST frame that puts [sessionId] anywhere on screen.
  ///
  /// A single settled assertion would miss the defect entirely: the fingerprint
  /// was only ever visible between the route landing and the session frame
  /// arriving, which `pumpAndSettle` skips straight past.
  Future<void> expectNoFingerprintWhilePumping(
    WidgetTester tester,
    String sessionId, {
    int frames = 20,
  }) async {
    for (var frame = 0; frame < frames; frame++) {
      expect(
        find.text(sessionId),
        findsNothing,
        reason: 'frame $frame rendered the raw session id',
      );
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  /// Advances one frame at a time until Session Detail's strip first exists,
  /// failing if any frame along the way rendered [sessionId].
  ///
  /// Stopping at that first frame is the point: it is the earliest moment the
  /// page can render a title at all, and the regression this guards is what it
  /// renders *there*, not after everything has settled.
  Future<void> pumpToSessionDetail(
    WidgetTester tester,
    String sessionId,
  ) async {
    const strip = Key('session-detail-top-strip');
    for (var frame = 0; frame < 90; frame++) {
      expect(
        find.text(sessionId),
        findsNothing,
        reason: 'frame $frame rendered the raw session id',
      );
      if (find.byKey(strip).evaluate().isNotEmpty) return;
      await tester.pump(const Duration(milliseconds: 16));
    }
    fail('Session Detail never mounted');
  }

  group('U3 session title through bootstrap', () {
    testWidgets('roster navigation shows the tapped title on the first frame', (
      tester,
    ) async {
      useCompactViewport(tester);
      await tester.pumpWidget(
        buildRoutedSubject(
          sessions: [
            SessionInfo(
              id: 'ses_01JQ4Z8W',
              tool: 'claude',
              title: 'Refactor the broker gate',
              status: SessionStatus.idle,
              attachMode: AttachMode.live,
              updatedAt: DateTime.now().millisecondsSinceEpoch,
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await expandRosterProject(tester);

      await tester.tap(find.text('Refactor the broker gate'));
      await pumpToSessionDetail(tester, 'ses_01JQ4Z8W');

      expect(
        stripTitle('Refactor the broker gate'),
        findsOneWidget,
        reason: 'the row the user tapped names the page immediately',
      );
      expect(find.text('ses_01JQ4Z8W'), findsNothing);
      await expectNoFingerprintWhilePumping(tester, 'ses_01JQ4Z8W');
    });

    testWidgets('cached N3 roster navigation shows its known title', (
      tester,
    ) async {
      useCompactViewport(tester);
      await tester.pumpWidget(
        buildRoutedSubject(
          // Never answers, so the bounded identity snapshot is the only title
          // source on screen — the cold-start/offline case N3 introduced.
          repository: _NeverAnswersSessionListRepository(),
          snapshots: _StubRosterSnapshotRepository(
            SessionRosterSnapshot(
              brokerProfileId: 'local',
              rows: const [
                SessionRosterIdentity(
                  tool: 'claude',
                  sessionId: 'ses_cached_01',
                  title: 'Nightly index rebuild',
                  machine: 'mac',
                  cwd: '/work/alpha',
                ),
              ],
              capturedAt: DateTime(2026, 7, 27),
              omittedRowCount: 0,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      final header = find.byWidgetPredicate(
        (widget) =>
            widget.key is ValueKey<String> &&
            (widget.key! as ValueKey<String>).value.startsWith(
              'cached-project-header-',
            ),
      );
      await tester.tap(header);
      await tester.pump();
      await tester.tap(find.text('Nightly index rebuild'));
      await pumpToSessionDetail(tester, 'ses_cached_01');

      expect(stripTitle('Nightly index rebuild'), findsOneWidget);
      await expectNoFingerprintWhilePumping(tester, 'ses_cached_01');
    });

    testWidgets('open-tab navigation keeps the persisted title and does not '
        'downgrade the working set', (tester) async {
      final store = InMemoryOpenSessionsStore(
        snapshot: const OpenSessionsSnapshot(
          refs: [
            SessionRef(
              tool: 'claude',
              id: 'session-1',
              title: 'Persisted title',
              status: SessionStatus.needsInput,
            ),
          ],
          activeKey: 'claude/session-1',
        ),
      );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          autoConnect: false,
          openSessionsStore: store,
        ),
      );
      await tester.pumpAndSettle();

      expect(stripTitle('Persisted title'), findsOneWidget);
      expect(find.text('session-1'), findsNothing);
      expect(
        store.snapshot.refs.single.title,
        'Persisted title',
        reason: 'a held bootstrap must not rewrite the tab with the id',
      );
    });

    testWidgets('an authoritative empty title retires a stale local one', (
      tester,
    ) async {
      // The broker clearing a title is a fact, not an absence. The local
      // sources exist only for the window BEFORE the session frame arrives;
      // consulting them afterwards puts a name back on a session that no
      // longer has one.
      //
      // The roster is the durable form of that bug — it keeps serving the old
      // row until it refreshes, so a fallthrough shows the retired name
      // indefinitely, not for one frame.
      useCompactViewport(tester);
      late _HeldSessionDetailConnection connection;
      await tester.pumpWidget(
        buildRoutedSubject(
          sessions: [
            SessionInfo(
              id: 'ses_renamed_01',
              tool: 'claude',
              title: 'Old title',
              status: SessionStatus.idle,
              attachMode: AttachMode.live,
              updatedAt: DateTime.now().millisecondsSinceEpoch,
            ),
          ],
          onConnection: (created) => connection = created,
        ),
      );
      await tester.pumpAndSettle();
      await expandRosterProject(tester);
      await tester.tap(find.text('Old title'));
      await pumpToSessionDetail(tester, 'ses_renamed_01');
      expect(stripTitle('Old title'), findsOneWidget);

      connection.emit(
        SessionWireEvent(
          info: SessionInfo.fromJson(const {
            'id': 'ses_renamed_01',
            'tool': 'claude',
            'title': '',
            'status': 'idle',
            'attachMode': 'observe',
          }),
        ),
      );
      await tester.pump();

      // From the very first frame the session frame is applied, and it stays
      // that way while the roster still holds the retired name.
      expect(stripTitle('Untitled session'), findsOneWidget);
      expect(stripTitle('Old title'), findsNothing);
      for (var frame = 0; frame < 10; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
        expect(stripTitle('Old title'), findsNothing);
      }
      expect(find.text('ses_renamed_01'), findsNothing);
    });

    testWidgets(
      'an authoritative empty title retires the persisted tab title',
      (
        tester,
      ) async {
        // Same rule against the working set, asserted on the FIRST frame after
        // the session frame lands: the tab self-heals a frame later through
        // `SessionRef.fromSession`, so anything less than a first-frame check
        // would step straight over the flash.
        final store = InMemoryOpenSessionsStore(
          snapshot: const OpenSessionsSnapshot(
            refs: [
              SessionRef(
                tool: 'claude',
                id: 'session-1',
                title: 'Old title',
                status: SessionStatus.idle,
              ),
            ],
            activeKey: 'claude/session-1',
          ),
        );
        final connection = ScriptedSessionDetailConnection(
          events: const [],
          autoConnect: false,
        );

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            openSessionsStore: store,
            locale: const Locale('en'),
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(stripTitle('Old title'), findsOneWidget);

        connection.emitEvent(
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': '',
              'status': 'idle',
              'attachMode': 'observe',
            }),
          ),
        );
        await tester.pump();

        expect(stripTitle('Untitled session'), findsOneWidget);
        expect(stripTitle('Old title'), findsNothing);
        expect(find.text('session-1'), findsNothing);
      },
    );

    testWidgets('a profile switch never shows or persists the previous '
        "profile's title", (tester) async {
      // `OpenSessionsController` watches the active profile, so switching
      // rebuilds it — and Riverpod keeps serving profile A's working set
      // through `valueOrNull` until B's hydration lands. Both profiles carry
      // the SAME native session id here, which is exactly when a tool/id-only
      // lookup leaks A's name onto B.
      final store = _GatedOpenSessionsStore({
        'local': const OpenSessionsSnapshot(
          refs: [
            SessionRef(
              tool: 'claude',
              id: 'session-1',
              title: 'Profile A title',
              status: SessionStatus.idle,
            ),
          ],
          activeKey: 'claude/session-1',
        ),
      });

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          autoConnect: false,
          openSessionsStore: store,
          locale: const Locale('en'),
        ),
      );
      await tester.pumpAndSettle();
      expect(stripTitle('Profile A title'), findsOneWidget);

      // Switch to a broker whose working set never finishes hydrating.
      store.holdProfile('other');
      ProviderScope.containerOf(
        tester.element(find.byType(SessionDetailPage)),
      ).read(activeBrokerProfileProvider.notifier).state = BrokerProfile(
        id: 'other',
        displayName: 'other',
        baseUri: Uri.parse('http://127.0.0.1:8899'),
        createdAt: DateTime(2026, 7, 27),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 120));

      expect(
        stripTitle('Profile A title'),
        findsNothing,
        reason: "profile B must never be named by profile A's working set",
      );
      expect(stripTitle('Opening session'), findsOneWidget);
      expect(
        store.saved['other']?.refs.any(
          (ref) => ref.title == 'Profile A title',
        ),
        isNot(isTrue),
        reason: "and A's title must not be persisted under B",
      );

      // Releasing B's hydration resolves it on B's own identity.
      store.release('other');
      await tester.pumpAndSettle();
      expect(stripTitle('Profile A title'), findsNothing);
    });

    testWidgets("a profile switch shows none of the previous profile's "
        'session', (tester) async {
      // The controller's own content, not a local copy of it. Profile A's
      // socket refuses to finish tearing down, which is the case that used to
      // hold everything A reported on screen: the switch queued its attach
      // behind that teardown, so A's title, controls, transcript, draft and
      // terminal badge all outlived the switch. A cross-source attach now
      // supersedes the retired lane instead of waiting on it, so the same
      // hostile teardown delays nothing.
      final store = _GatedOpenSessionsStore({});
      final connection = _HeldTeardownConnection(
        events: [
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Profile A title',
              'status': 'idle',
              'attachMode': 'resume',
              'control': {
                'drive': {'state': 'driving', 'supported': true},
                'terminalSync': {
                  'supported': false,
                  'syncAvailable': false,
                  'active': false,
                },
              },
            }),
          ),
          const HistoryWireEvent(
            messages: [
              AgentMessage(
                id: 'a-transcript',
                type: AgentMessageType.modelOutput,
                raw: {
                  'type': 'model-output',
                  'text': 'Profile A transcript body',
                },
              ),
              AgentMessage(
                id: 'a-terminal',
                type: AgentMessageType.terminalOutput,
                raw: {
                  'type': 'terminal-output',
                  'command': 'profile-a-command',
                  'output': 'Profile A terminal body',
                },
              ),
            ],
          ),
          // The composer applies a remote draft, and the profile listener
          // resets the applied-draft watermarks — so a retained draft would be
          // typed straight back into profile B's composer.
          const DraftWireEvent(text: 'Profile A draft body', at: 40),
        ],
      );

      // Profile B gets its OWN socket, and one that never connects: whatever
      // the page shows after the switch has to have come from profile A.
      final connectionsDispensed = <SessionDetailConnection>[];
      SessionDetailConnection dispense() {
        final next = connectionsDispensed.isEmpty
            ? connection
            : ScriptedSessionDetailConnection(
                events: const [],
                autoConnect: false,
              );
        connectionsDispensed.add(next);
        return next;
      }

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connectionFactory:
              ({required resolver, required sessionId, required tool}) =>
                  dispense(),
          openSessionsStore: store,
          locale: const Locale('en'),
        ),
      );
      await tester.pumpAndSettle();
      expect(stripTitle('Profile A title'), findsOneWidget);
      expect(
        find.byKey(const Key('session-detail-control-pill-driving')),
        findsOneWidget,
      );
      expect(find.text('Profile A transcript body'), findsOneWidget);
      expect(composerText(tester), 'Profile A draft body');
      expect(
        find.byKey(const Key('session-detail-view-menu-dot')),
        findsOneWidget,
        reason: "profile A's unseen terminal output is being advertised",
      );

      // B's own working set never hydrates either, so the only thing that can
      // still be showing profile A here is the controller's retained state.
      store.holdProfile('other');
      ProviderScope.containerOf(
        tester.element(find.byType(SessionDetailPage)),
      ).read(activeBrokerProfileProvider.notifier).state = BrokerProfile(
        id: 'other',
        displayName: 'other',
        baseUri: Uri.parse('http://127.0.0.1:8899'),
        createdAt: DateTime(2026, 7, 27),
      );

      for (var frame = 0; frame < 20; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
        expect(
          stripTitle('Profile A title'),
          findsNothing,
          reason: "frame $frame named profile B with profile A's session",
        );
        expect(
          find.byKey(const Key('session-detail-control-pill-driving')),
          findsNothing,
          reason: "frame $frame offered profile A's controls on profile B",
        );
        expect(
          find.text('Profile A transcript body'),
          findsNothing,
          reason: "frame $frame rendered profile A's transcript on profile B",
        );
        expect(
          composerText(tester) ?? '',
          isEmpty,
          reason: "frame $frame put profile A's draft in profile B's composer",
        );
        expect(
          find.text('Profile A draft body'),
          findsNothing,
          reason: "frame $frame showed profile A's draft text",
        );
        expect(
          find.byKey(const Key('session-detail-view-menu-dot')),
          findsNothing,
          reason: "frame $frame advertised profile A's terminal output",
        );
      }

      // The fixture is real, not raced past: B's own socket was created and
      // never connected, so nothing B reported can be what emptied the page —
      // and the controller itself no longer holds any of profile A. The old
      // teardown-blocked lane could not reach this state at all, which is the
      // point: the retired broker's socket is still refusing to close right
      // now. (Page-level qualification of a controller that DOES still hold
      // another broker's frame is proven separately, from a seeded state, by
      // "the previous broker's control frame is never shown".)
      expect(connectionsDispensed, hasLength(2));
      final raw =
          ProviderScope.containerOf(
            tester.element(find.byType(SessionDetailPage)),
          ).read(
            sessionDetailControllerProvider(
              const SessionDetailKey(tool: 'claude', sessionId: 'session-1'),
            ),
          );
      expect(raw.sessionInfo, isNull);
      expect(raw.source?.profileId, isNot('local'));
      expect(raw.messageEvents, isEmpty);
      expect(raw.terminalOutputMessages, isEmpty);
      expect(raw.latestDraft?.text, isNot('Profile A draft body'));

      expect(stripTitle('Opening session'), findsOneWidget);
      expect(
        store.saved['other']?.refs.any(
          (ref) => ref.title == 'Profile A title',
        ),
        isNot(isTrue),
        reason: "and A's title must not be persisted under B",
      );

      // Let the held teardown finish so nothing is left hanging.
      connection.releaseTeardown();
    });
  });

  group('U3 direct deep link', () {
    testWidgets('shows the neutral English fallback, never the fingerprint', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          autoConnect: false,
          sessionId: 'ses_deep_link_01',
          locale: const Locale('en'),
        ),
      );
      await tester.pumpAndSettle();

      expect(stripTitle('Opening session'), findsOneWidget);
      expect(find.text('ses_deep_link_01'), findsNothing);
    });

    testWidgets('shows the neutral Chinese fallback', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          autoConnect: false,
          sessionId: 'ses_deep_link_01',
          locale: const Locale('zh'),
        ),
      );
      await tester.pumpAndSettle();

      expect(stripTitle('正在打开会话'), findsOneWidget);
      expect(stripTitle('Opening session'), findsNothing);
      expect(find.text('ses_deep_link_01'), findsNothing);
    });

    testWidgets('authoritative session info replaces the fallback', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [],
        autoConnect: false,
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          sessionId: 'ses_deep_link_01',
          locale: const Locale('en'),
        ),
      );
      // Bounded pumps, not pumpAndSettle: settling races past the bootstrap's
      // initial-history timeout, and the retired attempt then ignores the very
      // frame this test is about.
      await tester.pump();
      await tester.pump();
      expect(stripTitle('Opening session'), findsOneWidget);

      connection.emitEvent(
        SessionWireEvent(
          info: SessionInfo.fromJson(const {
            'id': 'ses_deep_link_01',
            'tool': 'claude',
            'title': 'Named by the broker',
            'status': 'idle',
            'attachMode': 'observe',
          }),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(stripTitle('Named by the broker'), findsOneWidget);
      expect(stripTitle('Opening session'), findsNothing);
      expect(find.text('ses_deep_link_01'), findsNothing);
    });

    testWidgets('a resolved session with no title is named untitled, not '
        'opening', (tester) async {
      // The broker answered; the session simply has no name. Reusing the
      // opening placeholder here would be a progress state that never ends.
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          sessionId: 'ses_untitled_01',
          locale: const Locale('en'),
        ),
      );
      await tester.pumpAndSettle();

      expect(stripTitle('Untitled session'), findsOneWidget);
      expect(stripTitle('Opening session'), findsNothing);
      expect(find.text('ses_untitled_01'), findsNothing);
    });

    testWidgets('the working set persists the id, never the localized label', (
      tester,
    ) async {
      // Storage keeps stable identity. Freezing one locale's words into the
      // persisted tab would read like a title the broker had supplied.
      final store = InMemoryOpenSessionsStore();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          autoConnect: false,
          sessionId: 'ses_deep_link_01',
          openSessionsStore: store,
          locale: const Locale('en'),
        ),
      );
      await tester.pumpAndSettle();

      expect(store.snapshot.refs.single.title, 'ses_deep_link_01');
      expect(stripTitle('Opening session'), findsOneWidget);
    });
  });

  group('U3 title is presentation, never identity', () {
    testWidgets('the rename field edits the real title, not the placeholder', (
      tester,
    ) async {
      final client = FakeBrokerClient();
      final connection = ScriptedSessionDetailConnection(
        events: const [],
        autoConnect: false,
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          brokerClient: client,
          sessionId: 'ses_deep_link_01',
          locale: const Locale('en'),
        ),
      );
      await tester.pumpAndSettle();
      expect(stripTitle('Opening session'), findsOneWidget);

      await tester.tap(find.byKey(const Key('session-detail-rename-button')));
      await tester.pumpAndSettle();

      final field = find.byKey(const Key('session-detail-rename-input'));
      expect(field, findsOneWidget);
      expect(
        tester.widget<TextField>(field).controller!.text,
        isEmpty,
        reason: 'the placeholder must never be seeded as an editable name',
      );

      // Dismissing without typing commits nothing: the placeholder is not an
      // edit, so there is no rename to send.
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(client.renameSessionCount, 0);
    });

    testWidgets('a known title is what the rename field starts from', (
      tester,
    ) async {
      final client = FakeBrokerClient();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            SessionWireEvent(
              info: SessionInfo.fromJson(const {
                'id': 'session-1',
                'tool': 'claude',
                'title': 'Broker named it',
                'status': 'idle',
                'attachMode': 'observe',
              }),
            ),
          ],
          brokerClient: client,
          locale: const Locale('en'),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('session-detail-rename-button')));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(
              find.byKey(const Key('session-detail-rename-input')),
            )
            .controller!
            .text,
        'Broker named it',
      );
    });
  });
}

/// A Session Detail connection that accepts the attach and then goes quiet, so
/// `sessionInfo` stays unresolved for the whole test.
class _HeldSessionDetailConnection implements SessionDetailConnection {
  final _events = StreamController<WireEvent>.broadcast();
  final _states = StreamController<SessionDetailConnectionStatus>.broadcast();

  /// Delivers one frame on a connection that is otherwise silent.
  void emit(WireEvent event) => _events.add(event);

  @override
  SessionDetailConnectionStatus get state =>
      SessionDetailConnectionStatus.connecting;

  @override
  Stream<WireEvent> get events => _events.stream;

  @override
  Stream<SessionDetailConnectionStatus> get stateStream => _states.stream;

  @override
  Future<void> connect() async {}

  @override
  Future<void> close({bool reconnect = false}) async {}

  bool requiredReadOnly = false;

  @override
  void requireReadOnly() => requiredReadOnly = true;

  @override
  bool get readOnly => requiredReadOnly;

  @override
  Future<void> reattach({
    String? mode,
    String? reason,
    bool readOnly = false,
    SessionOwnerRevision? ownerRevision,
  }) async {}

  @override
  void disarmDriveAuthority() {}

  @override
  Future<void> sendHandoff({String? clientMessageId}) async {}

  @override
  Future<void> dispose() async {
    await _events.close();
    await _states.close();
  }

  @override
  Future<void> sendPrompt(
    String text, {
    SessionCurrentModel? model,
    String? clientMessageId,
    int? draftRevision,
    String? draftUpdateId,
    List<PromptFileAttachment> files = const [],
  }) async {}

  @override
  Future<void> sendDraft(
    String text, {
    String? updateId,
    int? baseRevision,
  }) async {}

  @override
  Future<void> sendPlanAction(
    PlanActionRequest request, {
    String? clientMessageId,
  }) async {}

  @override
  Future<void> sendArtifactInteraction(
    ArtifactInteractionRequest request, {
    String? clientMessageId,
  }) async {}

  @override
  Future<void> sendAck(String attachTicket, {String? clientMessageId}) async {}

  @override
  Future<void> sendNack(String attachTicket, {String? clientMessageId}) async {}

  @override
  Future<void> sendPermissionDecision(
    String requestId,
    String decision, {
    String? clientMessageId,
  }) async {}

  @override
  Future<void> sendSetAgent(String agent, {String? clientMessageId}) async {}

  @override
  Future<void> sendQuestionAnswer(
    String requestId,
    List<List<String>> answers, {
    String? clientMessageId,
  }) async {}

  @override
  Future<void> rejectQuestion(
    String requestId, {
    String? clientMessageId,
  }) async {}

  @override
  Future<void> sendCommand(
    String name, {
    Map<String, dynamic>? args,
    SessionCurrentModel? model,
    String? clientMessageId,
  }) async {}

  @override
  Future<void> sendFile({
    required String name,
    required String data,
    String? mimeType,
    String? clientMessageId,
  }) async {}
}

/// A scripted connection whose teardown never finishes until released.
///
/// `_resetConnectionForProfileSwitch` awaits `dispose()` before the controller
/// replaces the state, so this pins the post-switch window open for as long as
/// the test needs instead of racing a one-frame flash.
class _HeldTeardownConnection extends ScriptedSessionDetailConnection {
  _HeldTeardownConnection({required super.events});

  final _teardown = Completer<void>();

  /// Lets the blocked teardown finish.
  void releaseTeardown() {
    if (!_teardown.isCompleted) _teardown.complete();
  }

  /// Deliberately does not close the streams: the factory override hands the
  /// same instance to the next profile's attach, and a closed controller would
  /// make that re-attach throw instead of reconnecting.
  @override
  Future<void> dispose() async {
    await _teardown.future;
  }
}

/// An opened-sessions store whose per-profile load can be held open.
///
/// Holding one profile's hydration is what reproduces the switch window: the
/// controller has rebuilt for the new profile, but Riverpod is still serving
/// the previous profile's value.
class _GatedOpenSessionsStore implements OpenSessionsStore {
  _GatedOpenSessionsStore(Map<String, OpenSessionsSnapshot> initial)
    : saved = {...initial};

  final Map<String, OpenSessionsSnapshot> saved;
  final Map<String, Completer<void>> _gates = {};

  void holdProfile(String profileId) {
    _gates[profileId] = Completer<void>();
  }

  void release(String profileId) {
    final gate = _gates.remove(profileId);
    if (gate != null && !gate.isCompleted) gate.complete();
  }

  @override
  Future<OpenSessionsSnapshot> load(String profileId) async {
    final gate = _gates[profileId];
    if (gate != null) await gate.future;
    return saved[profileId] ?? OpenSessionsSnapshot.empty;
  }

  @override
  Future<void> save(String profileId, OpenSessionsSnapshot snapshot) async {
    saved[profileId] = snapshot;
  }
}

/// A roster request that never resolves, holding cached identity on screen.
class _NeverAnswersSessionListRepository implements SessionListRepository {
  @override
  Future<ListSessionsResponse> fetchSessions({bool force = false}) =>
      Completer<ListSessionsResponse>().future;
}

/// Returns one snapshot for any profile, so the cached roster is the thing
/// under test rather than the store's bounds.
class _StubRosterSnapshotRepository implements RosterSnapshotRepository {
  _StubRosterSnapshotRepository(this.snapshot);

  final SessionRosterSnapshot snapshot;

  @override
  Future<SessionRosterSnapshot?> load(
    String brokerProfileId, {
    required String endpoint,
  }) async => snapshot;

  @override
  Future<SessionRosterSnapshot> save({
    required String brokerProfileId,
    required String endpoint,
    required List<SessionInfo> sessions,
    DateTime? now,
  }) async => snapshot;

  @override
  Future<void> deleteForProfile(String brokerProfileId) async {}
}
