import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_detail_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// U3-C/D/E — what the normal Status surface says, and how much of it the user
/// can select.
///
/// Three separate defects: Status exposed the native session id even though
/// Debug already owns technical identity; nothing on the page was selectable,
/// because Status is a plain `ListView` with no ancestor selection region; and
/// one healthy state repeated itself three times over.
void main() {
  SessionWireEvent controlEvent(
    Map<String, dynamic> control, {
    String title = 'Status fixture',
    String status = 'idle',
  }) => SessionWireEvent(
    info: SessionInfo.fromJson({
      'id': 'session-1',
      'tool': 'claude',
      'title': title,
      'status': status,
      'attachMode': 'observe',
      'control': control,
    }),
  );

  /// The exact healthy state U3-E compacts: connected, compatible, Synced, not
  /// answer-only, terminal genuinely shared and not behind, no broker reason.
  const healthySyncedShared = <String, dynamic>{
    'drive': {'state': 'observing', 'supported': false},
    'terminalSync': {
      'supported': true,
      'syncAvailable': true,
      'active': true,
      'presence': 'shared',
    },
  };

  Future<void> openStatus(WidgetTester tester) =>
      openSessionDetailTestTab(tester, 'session-detail-tab-status');

  Finder inStatus(Finder matching) => find.descendant(
    of: find.byKey(const Key('session-detail-status-panel')),
    matching: matching,
  );

  group('U3-C fingerprints belong to Debug', () {
    testWidgets('normal Status exposes no native session id', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [controlEvent(healthySyncedShared)],
          showDebugViews: true,
        ),
      );
      await tester.pumpAndSettle();
      await openStatus(tester);

      expect(
        inStatus(find.textContaining('session-1')),
        findsNothing,
        reason: 'the fingerprint moved to Debug, it did not move surfaces',
      );
      expect(
        find.byKey(const Key('session-detail-status-session-id')),
        findsNothing,
      );
    });

    testWidgets('Debug keeps the tool/native identity when enabled', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [controlEvent(healthySyncedShared)],
          showDebugViews: true,
        ),
      );
      await tester.pumpAndSettle();
      await openSessionDetailTestTab(tester, 'session-detail-tab-debug');

      expect(
        find.byKey(const Key('session-detail-debug-identity')),
        findsOneWidget,
      );
      expect(find.text('claude / session-1'), findsOneWidget);
    });

    testWidgets('with debug views off the identity card is unreachable', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [controlEvent(healthySyncedShared)],
        ),
      );
      await tester.pumpAndSettle();

      await expectSessionDetailViewItem(tester, 'debug', matcher: findsNothing);
      expect(
        find.byKey(const Key('session-detail-debug-identity')),
        findsNothing,
        reason: 'D1 keeps the whole Debug destination out of the tree',
      );

      // And Status is still reachable and still fingerprint-free.
      await openStatus(tester);
      expect(inStatus(find.textContaining('session-1')), findsNothing);
    });
  });

  group('U3-D Status information is selectable', () {
    Future<void> selectStatusText(WidgetTester tester) async {
      tester
          .state<SelectableRegionState>(
            find.descendant(
              of: find.byKey(const Key('session-detail-status-selection')),
              matching: find.byType(SelectableRegion),
            ),
          )
          .selectAll();
      await tester.pump();
    }

    /// The full-text selection a given string's paragraph is carrying.
    ///
    /// Asserting on the render object rather than on a helper's return value
    /// is what makes this a behavior test: the string is selected because the
    /// selection machinery actually reached it.
    void expectFullySelected(WidgetTester tester, String text) {
      // Down to the paragraph itself: under a selection region a `Text` sits
      // inside a MouseRegion, so the element's own render object is not the
      // one carrying the selection.
      final paragraph = tester.renderObject<RenderParagraph>(
        find
            .descendant(
              of: inStatus(find.text(text)).first,
              matching: find.byType(RichText),
            )
            .first,
      );
      expect(
        paragraph.selections,
        isNotEmpty,
        reason: '"$text" did not participate in the selection',
      );
      final selection = paragraph.selections.first;
      expect(
        (selection.extentOffset - selection.baseOffset).abs(),
        text.length,
        reason: '"$text" was only partially selectable',
      );
    }

    testWidgets('headline, description, telemetry and status tag select '
        'together', (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            controlEvent(const {
              'drive': {'state': 'driving', 'supported': true},
              'terminalSync': {
                'supported': false,
                'syncAvailable': false,
                'active': false,
              },
            }, status: 'working'),
            MessageWireEvent(
              seq: 1,
              message: AgentMessage.fromJson(const {
                'type': 'token-count',
                'input': 4,
                'output': 567,
              }),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await openStatus(tester);

      await selectStatusText(tester);

      // A section headline, the control description, the status tag itself,
      // and a telemetry label with its value — one region, one selection.
      expectFullySelected(tester, 'Connection & ownership');
      expectFullySelected(
        tester,
        'Driving from the app. Switch to Observe before resuming this session '
        'manually in a terminal.',
      );
      expectFullySelected(tester, 'Driving');
      expectFullySelected(tester, 'Output');
      expectFullySelected(tester, '567');
      expectFullySelected(tester, 'Session actions');
      expect(tester.takeException(), isNull);
    });

    testWidgets('selection does not consume scrolling', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [controlEvent(healthySyncedShared)],
        ),
      );
      await tester.pumpAndSettle();
      await openStatus(tester);
      await selectStatusText(tester);

      final scrollable = find
          .descendant(
            of: find.byKey(const Key('session-detail-status-panel')),
            matching: find.byType(Scrollable),
          )
          .first;
      expect(tester.state<ScrollableState>(scrollable).position.pixels, 0);
      await tester.drag(scrollable, const Offset(0, -160));
      await tester.pumpAndSettle();

      expect(
        tester.state<ScrollableState>(scrollable).position.pixels,
        greaterThan(0),
        reason: 'a drag inside the selection region still scrolls the list',
      );
    });

    testWidgets('selection does not consume button taps', (tester) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          controlEvent(const {
            'drive': {'state': 'observing', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          }),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openStatus(tester);
      await selectStatusText(tester);

      await tester.tap(
        find.byKey(const Key('session-detail-take-over-button')),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('session-detail-take-over-dialog')),
        findsOneWidget,
      );
      await tester.tap(
        find.byKey(const Key('session-detail-take-over-confirm')),
      );
      await tester.pumpAndSettle();
      expect(connection.reattachModes, ['resume']);
    });

    testWidgets('selection does not consume the copy-command action', (
      tester,
    ) async {
      final copied = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied.add(
              (call.arguments as Map<Object?, Object?>)['text']! as String,
            );
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            controlEvent(const {
              'drive': {'state': 'observing', 'supported': true},
              'terminalSync': {
                'supported': true,
                'syncAvailable': true,
                'active': false,
                'action': 'join',
                'command': 'codex resume --remote sock thread',
              },
            }),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await openStatus(tester);
      await selectStatusText(tester);

      await tester.tap(
        find.byKey(const Key('session-detail-status-copy-command')),
      );
      await tester.pumpAndSettle();
      expect(copied, ['codex resume --remote sock thread']);
    });
  });

  group('U3-E healthy synced state says it once', () {
    testWidgets('the exact healthy shared-terminal fixture keeps only the '
        'pill', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [controlEvent(healthySyncedShared)],
        ),
      );
      await tester.pumpAndSettle();
      await openStatus(tester);

      expect(
        find.byKey(
          const Key('session-detail-status-sheet-control-pill-synced'),
        ),
        findsOneWidget,
        reason: 'the one sufficient headline stays',
      );
      expect(
        find.byKey(const Key('session-detail-status-control-description')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-detail-status-terminal-heading')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-detail-status-terminal-description')),
        findsNothing,
      );
      expect(find.text('Terminal connected and synced.'), findsNothing);
      expect(
        find.textContaining('Send from here or the terminal'),
        findsNothing,
      );
      // Nothing was removed that the user could act on.
      expect(
        find.byKey(const Key('session-detail-detach-button')),
        findsOneWidget,
      );
    });

    /// Every state that carries an action, a caveat, a limitation, a safety
    /// consequence, or a recovery path. None of these may be compacted.
    final preserved =
        <
          ({
            String name,
            Map<String, dynamic> control,
            String description,
            String? terminal,
            Key? action,
          })
        >[
          (
            name: 'answers-only sync',
            control: {
              'drive': {'state': 'unavailable', 'supported': false},
              'terminalSync': {
                'supported': true,
                'syncAvailable': true,
                'active': true,
                'input': 'answer-only',
                'presence': 'shared',
              },
            },
            description:
                'Synced with your terminal for answers only. Answer '
                'permission and question cards here; send new prompts from '
                'the terminal.',
            terminal: 'Terminal connected and synced.',
            action: null,
          ),
          (
            name: 'observing',
            control: {
              'drive': {'state': 'observing', 'supported': true},
              'terminalSync': {
                'supported': false,
                'syncAvailable': false,
                'active': false,
              },
            },
            description:
                'The terminal owns input right now. Take over to send from '
                'the app.',
            terminal: 'The terminal connection could not be confirmed.',
            action: const Key('session-detail-take-over-button'),
          ),
          (
            name: 'terminal behind',
            control: {
              'drive': {'state': 'driving', 'supported': true},
              'terminalSync': {
                'supported': true,
                'syncAvailable': false,
                'active': false,
                'presence': 'private',
                'behind': true,
              },
            },
            description:
                'Driving from the app. Switch to Observe before resuming this '
                'session manually in a terminal.',
            terminal:
                'This terminal is behind. Restart or resume it to rejoin.',
            action: null,
          ),
          (
            name: 'terminal available but not joined',
            control: {
              'drive': {'state': 'observing', 'supported': true},
              'terminalSync': {
                'supported': true,
                'syncAvailable': true,
                'active': false,
                'action': 'join',
                'command': 'codex resume --remote sock thread',
              },
            },
            description:
                'A terminal can join this session. Run the command below '
                'to sync, then send from either side.',
            terminal: null,
            action: const Key('session-detail-status-copy-command'),
          ),
          (
            name: 'unavailable',
            control: {
              'drive': {'state': 'unavailable', 'supported': false},
              'terminalSync': {
                'supported': false,
                'syncAvailable': false,
                'active': false,
              },
            },
            description:
                'The app can neither take over nor sync this session. You can '
                'only observe it.',
            terminal: 'The terminal connection could not be confirmed.',
            action: null,
          ),
          (
            name: 'synced but terminal sync degraded',
            control: {
              'drive': {'state': 'observing', 'supported': false},
              'terminalSync': {
                'supported': true,
                'syncAvailable': true,
                'active': true,
                'presence': 'unknown',
              },
            },
            description:
                'Synced with your terminal. Send from here or the '
                'terminal; both stay in step.',
            terminal: 'The terminal connection could not be confirmed.',
            action: null,
          ),
          (
            name: 'synced shared but behind',
            control: {
              'drive': {'state': 'observing', 'supported': false},
              'terminalSync': {
                'supported': true,
                'syncAvailable': true,
                'active': true,
                'presence': 'shared',
                'behind': true,
              },
            },
            description:
                'Synced with your terminal. Send from here or the '
                'terminal; both stay in step.',
            terminal: 'Terminal connected and synced.',
            action: null,
          ),
        ];

    for (final testCase in preserved) {
      testWidgets('${testCase.name} keeps its explanation and controls', (
        tester,
      ) async {
        useRoomyTestViewport(tester);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [controlEvent(testCase.control)],
          ),
        );
        await tester.pumpAndSettle();
        await openStatus(tester);

        expect(
          find.byKey(const Key('session-detail-status-control-description')),
          findsOneWidget,
        );
        expect(find.text(testCase.description), findsOneWidget);
        if (testCase.terminal case final terminal?) {
          expect(
            find.byKey(const Key('session-detail-status-terminal-heading')),
            findsOneWidget,
          );
          expect(find.text(terminal), findsOneWidget);
        }
        if (testCase.action case final action?) {
          await showSessionStatusTestItem(tester, action);
          expect(find.byKey(action), findsOneWidget);
        }
      });
    }

    testWidgets('answers-only is never described as fully synced', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            controlEvent(const {
              'drive': {'state': 'unavailable', 'supported': false},
              'terminalSync': {
                'supported': true,
                'syncAvailable': true,
                'active': true,
                'input': 'answer-only',
                'presence': 'shared',
              },
            }),
          ],
        ),
      );
      await tester.pumpAndSettle();

      // The composer caveat is a safety consequence, not repetition: it lives
      // on Chat and must survive whatever Status compacts.
      expect(
        find.byKey(const Key('session-detail-composer-blocked-hint')),
        findsOneWidget,
      );

      await openStatus(tester);
      expect(find.textContaining('for answers only'), findsOneWidget);
      expect(
        find.textContaining('Send from here or the terminal'),
        findsNothing,
      );
    });

    testWidgets('a disconnected session keeps its hint and Attach action', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [controlEvent(healthySyncedShared)],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openStatus(tester);

      connection.emitState(SessionDetailConnectionStatus.reconnecting);
      await tester.pumpAndSettle();

      // R0b: the control footprint carries the stale statement, once. The
      // separate reconnect sentence that used to sit beside it is gone.
      expect(
        find.byKey(
          const Key('session-detail-status-sheet-control-pill-reconnecting'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-status-offline-hint')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-detail-status-control-description')),
        findsOneWidget,
        reason: 'a session that is not attached is not a healthy synced one',
      );
    });

    testWidgets('a broker reason survives the healthy-looking shape', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            controlEvent(const {
              'drive': {'state': 'observing', 'supported': false},
              'terminalSync': {
                'supported': true,
                'syncAvailable': true,
                'active': true,
                'presence': 'shared',
                'reason': 'Sync is running one revision behind.',
              },
            }),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await openStatus(tester);

      await tester.tap(find.text('Technical details'));
      await tester.pumpAndSettle();
      expect(
        find.text('Sync is running one revision behind.'),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-status-control-description')),
        findsOneWidget,
      );
    });
  });

  group('U3 Status presentation', () {
    const densities = <(String, Size)>[
      ('compact', Size(420, 900)),
      ('roomy', Size(1280, 900)),
    ];

    for (final (label, size) in densities) {
      for (final brightness in Brightness.values) {
        for (final scale in const [1.0, 2.0]) {
          testWidgets('$label ${brightness.name} at ${scale}x lays out '
              'cleanly', (tester) async {
            tester.view
              ..physicalSize = size
              ..devicePixelRatio = 1;
            addTearDown(tester.view.reset);

            final spec = themeSpecById(kDefaultThemeId);
            await tester.pumpWidget(
              buildSessionDetailTestPage(
                events: [controlEvent(healthySyncedShared)],
                theme: buildAppTheme(
                  brightness == Brightness.dark ? spec.dark : spec.light,
                  brightness,
                ),
                textScale: scale,
              ),
            );
            await tester.pumpAndSettle();
            await openStatus(tester);

            expect(
              find.byKey(const Key('session-detail-status-panel')),
              findsOneWidget,
            );
            expect(
              find.byKey(
                const Key('session-detail-status-sheet-control-pill-synced'),
              ),
              findsOneWidget,
            );
            expect(
              tester.takeException(),
              isNull,
              reason: 'no overflow or layout exception',
            );
          });
        }
      }
    }
  });

  group('R0b Status is broker-qualified', () {
    /// The page shows a progress affordance whenever nothing authoritative has
    /// arrived for the active broker, so a qualified-empty state never settles.
    Future<void> pumpFrames(WidgetTester tester) async {
      for (var frame = 0; frame < 8; frame++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    testWidgets(
      'moving the active profile from endpoint A to endpoint B drops A’s '
      'claim while Status is open',
      (tester) async {
        // The REAL transition, not a stand-in: one profile id, edited to point
        // at another machine, with Status already open. Its id is unchanged, so
        // every id-based comparison in the detail scope — the view's
        // qualification, the attach admission, and the async guards — sees no
        // change at all and keeps serving endpoint A's ownership claim.
        final endpointA = Uri.parse('http://alpha.invalid:7734');
        final endpointB = Uri.parse('http://beta.invalid:7734');
        useRoomyTestViewport(tester);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            brokerProfile: createTestBrokerProfile(baseUri: endpointA),
            events: [
              controlEvent(
                const {
                  'drive': {'state': 'driving', 'supported': true},
                  'terminalSync': {
                    'supported': false,
                    'syncAvailable': false,
                    'active': false,
                  },
                },
                title: 'Owned at endpoint A',
                status: 'working',
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();
        await openStatus(tester);

        expect(
          find.byKey(
            const Key('session-detail-status-sheet-control-pill-driving'),
          ),
          findsOneWidget,
          reason: 'endpoint A really is driving before the edit',
        );

        final container = ProviderScope.containerOf(
          tester.element(find.byType(SessionDetailPage)),
        );
        container.read(activeBrokerProfileProvider.notifier).state =
            createTestBrokerProfile(baseUri: endpointB);
        await pumpFrames(tester);

        // Retirement is asynchronous — the connection to A is still being torn
        // down here. That window is the whole defect: nothing A reported may be
        // displayed or actionable against B.
        expect(
          find.byKey(
            const Key('session-detail-status-sheet-control-pill-driving'),
          ),
          findsNothing,
          reason: "the retired endpoint's ownership claim must not survive",
        );
        expect(
          find.byKey(
            const Key('session-detail-status-sheet-control-pill-synced'),
          ),
          findsNothing,
        );
        expect(inStatus(find.text('Owned at endpoint A')), findsNothing);
        expect(
          find.byKey(
            const Key('session-detail-status-sheet-control-pill-reconnecting'),
          ),
          findsOneWidget,
          reason:
              'Status states the honest fact about the broker that is '
              'active now',
        );
      },
    );

    testWidgets(
      'an endpoint edit re-attaches: B connects its own socket while a hung '
      'A attach stays inert',
      (tester) async {
        // Endpoint A's machine never answers its connect — held forever. Two
        // prior defects hid behind that: the page's id-keyed listener never
        // fired for an endpoint edit at all, and even a manually requested B
        // attach was chained behind A's queue lane, so B waited indefinitely
        // on a socket to a machine the profile no longer points at.
        final endpointA = Uri.parse('http://alpha.invalid:7734');
        final endpointB = Uri.parse('http://beta.invalid:7734');
        final hungA = HungConnectSessionDetailConnection();
        final created = <ScriptedSessionDetailConnection>[];
        ScriptedSessionDetailConnection dispense() {
          final connection = created.isEmpty
              ? hungA
              : ScriptedSessionDetailConnection(
                  events: [
                    controlEvent(
                      const {
                        'drive': {'state': 'driving', 'supported': true},
                        'terminalSync': {
                          'supported': false,
                          'syncAvailable': false,
                          'active': false,
                        },
                      },
                      title: 'Owned at endpoint B',
                    ),
                  ],
                );
          created.add(connection);
          return connection;
        }

        useRoomyTestViewport(tester);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            brokerProfile: createTestBrokerProfile(baseUri: endpointA),
            events: const [],
            connectionFactory:
                ({required resolver, required sessionId, required tool}) =>
                    dispense(),
          ),
        );
        await pumpFrames(tester);

        expect(created, hasLength(1));
        expect(
          hungA.connectCallCount,
          1,
          reason: 'A really is stuck mid-connect before the edit',
        );
        expect(hungA.state, SessionDetailConnectionStatus.disconnected);

        final container = ProviderScope.containerOf(
          tester.element(find.byType(SessionDetailPage)),
        );
        container.read(activeBrokerProfileProvider.notifier).state =
            createTestBrokerProfile(baseUri: endpointB);
        await pumpFrames(tester);

        expect(
          created,
          hasLength(2),
          reason: "the edit must create a NEW connection, never reuse A's",
        );
        final connectionB = created[1];
        expect(
          connectionB.state,
          SessionDetailConnectionStatus.connected,
          reason: "B connects without waiting on A's dead socket",
        );
        await openStatus(tester);
        expect(
          find.byKey(
            const Key('session-detail-status-sheet-control-pill-driving'),
          ),
          findsOneWidget,
          reason: "B's own authoritative frame reached the page",
        );
        // The superseded lane stays inert: its socket never came up, was
        // never reattached, and sent nothing.
        expect(hungA.state, SessionDetailConnectionStatus.disconnected);
        expect(hungA.reattachModes, isEmpty);
        expect(hungA.sendPromptCount, 0);
        expect(hungA.connectCallCount, 1);
      },
    );

    testWidgets("the previous broker's control frame is never shown", (
      tester,
    ) async {
      // The page qualified its own build, but the Status panel read the
      // controller raw. Switching brokers only replaces the controller state
      // after the queued attach tears the old connection down, so in that
      // window Status displayed — and enabled — the PREVIOUS broker's
      // Driving/Sync actions against the new one.
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          initialState: SessionDetailState(
            tool: 'claude',
            sessionId: 'session-1',
            source: const RosterSource(
              profileId: 'a-different-broker',
              endpoint: 'http://a-different-broker.invalid:7734',
            ),
            connectionStatus: SessionDetailConnectionStatus.connected,
            sessionInfo: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Owned by another broker',
              'status': 'working',
              'attachMode': 'resume',
              'control': {
                'drive': {'state': 'driving', 'supported': true},
                'terminalSync': {
                  'supported': true,
                  'syncAvailable': true,
                  'active': true,
                  'presence': 'shared',
                },
              },
            }),
          ),
        ),
      );
      await pumpFrames(tester);
      await tester.tap(find.byKey(const Key('session-detail-view-menu')));
      await pumpFrames(tester);
      await tester.tap(
        find.byKey(const Key('session-detail-view-item-status')),
      );
      await pumpFrames(tester);

      expect(
        find.byKey(
          const Key('session-detail-status-sheet-control-pill-driving'),
        ),
        findsNothing,
        reason: "another broker's ownership claim must not be displayed",
      );
      expect(
        find.byKey(
          const Key('session-detail-status-sheet-control-pill-synced'),
        ),
        findsNothing,
      );
      expect(inStatus(find.text('Owned by another broker')), findsNothing);
      // Qualification empties the state, so the panel states the honest fact:
      // nothing authoritative has arrived for the broker that is active now.
      expect(
        find.byKey(
          const Key('session-detail-status-sheet-control-pill-reconnecting'),
        ),
        findsOneWidget,
      );
    });
  });
}

/// A connection whose [connect] never completes — a machine that stopped
/// answering. Everything else stays the scripted fake, so a superseding
/// attach can still dispose it cleanly.
final class HungConnectSessionDetailConnection
    extends ScriptedSessionDetailConnection {
  HungConnectSessionDetailConnection() : super(events: const []);

  /// How many times an attach reached this socket.
  int connectCallCount = 0;

  @override
  Future<void> connect() {
    connectCallCount++;
    return Completer<void>().future;
  }
}
