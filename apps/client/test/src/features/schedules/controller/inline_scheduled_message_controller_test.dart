import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/schedules/controller/inline_schedule_diagnostics.dart';
import 'package:cosyncing_client/src/features/schedules/controller/inline_scheduled_message_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'filters exact live message rows and adopts a created row by id',
    () async {
      final created = _row(
        id: 'created',
        text: 'Created immediately',
        at: 3000,
      );
      final fake = _FakeBrokerClient(
        rows: [
          _row(id: 'target'),
          _row(id: 'other-session', sessionId: 'session-2'),
          _row(id: 'other-tool', tool: 'claude'),
          _row(id: 'new-session', kind: ScheduleKind.newSession),
          _row(id: 'delivered', state: ScheduleState.delivered),
        ],
      );
      final container = _container(fake);
      addTearDown(container.dispose);
      final subscription = container.listen(
        inlineScheduledMessageControllerProvider(_target),
        (_, _) {},
      );
      addTearDown(subscription.close);
      final controller = container.read(
        inlineScheduledMessageControllerProvider(_target).notifier,
      );

      await controller.refresh();
      expect(
        container
            .read(inlineScheduledMessageControllerProvider(_target))
            .schedules
            .map((row) => row.id),
        ['target'],
      );

      controller.upsert(created);
      final rows = container
          .read(inlineScheduledMessageControllerProvider(_target))
          .schedules;
      expect(rows.map((row) => row.id), ['target', 'created']);
    },
  );

  test(
    'edits with stable id and only expected revision, text, and at',
    () async {
      final fake = _FakeBrokerClient(rows: [_row(id: 'same', revision: 4)]);
      final container = _container(fake);
      addTearDown(container.dispose);
      final subscription = container.listen(
        inlineScheduledMessageControllerProvider(_target),
        (_, _) {},
      );
      addTearDown(subscription.close);
      final controller = container.read(
        inlineScheduledMessageControllerProvider(_target).notifier,
      );
      await controller.refresh();

      final updated = await controller.update(
        'same',
        const ScheduleUpdate(
          expectedRevision: 4,
          text: 'Edited prompt',
          at: 4000,
        ),
      );

      expect(updated, isTrue);
      expect(fake.updatedId, 'same');
      expect(fake.updatedRequest?.toJson(), {
        'expectedRevision': 4,
        'text': 'Edited prompt',
        'at': 4000,
      });
      final row = container
          .read(inlineScheduledMessageControllerProvider(_target))
          .schedules
          .single;
      expect(row.id, 'same');
      expect(row.revision, 5);
      expect(row.text, 'Edited prompt');
    },
  );

  test('cancels by stable id through revision-free DELETE', () async {
    final fake = _FakeBrokerClient(rows: [_row(id: 'cancel-me', revision: 9)]);
    final container = _container(fake);
    addTearDown(container.dispose);
    final subscription = container.listen(
      inlineScheduledMessageControllerProvider(_target),
      (_, _) {},
    );
    addTearDown(subscription.close);
    final controller = container.read(
      inlineScheduledMessageControllerProvider(_target).notifier,
    );
    await controller.refresh();

    expect(await controller.cancel('cancel-me'), isTrue);
    expect(fake.deletedId, 'cancel-me');
    expect(
      container
          .read(inlineScheduledMessageControllerProvider(_target))
          .schedules,
      isEmpty,
    );
  });

  test(
    'refresh replaces canonical rows by id without overlap or duplicates',
    () async {
      final pending = Completer<ScheduleListResponse>();
      final fake = _FakeBrokerClient(
        rows: [_row(id: 'same', text: 'old')],
        pendingLists: [pending],
      );
      final container = _container(fake);
      addTearDown(container.dispose);
      final subscription = container.listen(
        inlineScheduledMessageControllerProvider(_target),
        (_, _) {},
      );
      addTearDown(subscription.close);
      final controller = container.read(
        inlineScheduledMessageControllerProvider(_target).notifier,
      );

      final first = controller.refresh();
      final second = controller.refresh();
      await Future<void>.delayed(Duration.zero);
      expect(fake.listCalls, 1);
      pending.complete(
        ScheduleListResponse(
          schedules: [_row(id: 'same', text: 'new')],
        ),
      );
      await Future.wait([first, second]);
      expect(
        container
            .read(inlineScheduledMessageControllerProvider(_target))
            .schedules
            .map((row) => row.text),
        ['new'],
      );
    },
  );

  test('a profile switch does not inherit the old transport report', () async {
    final oldResponse = Completer<ScheduleListResponse>();
    final newResponse = Completer<ScheduleListResponse>();
    final fake = _FakeBrokerClient(
      rows: const [],
      pendingLists: [oldResponse, newResponse],
    );
    final container = _container(fake, profile: _profile('profile-a'));
    addTearDown(container.dispose);
    final subscription = container.listen(
      inlineScheduledMessageControllerProvider(_target),
      (_, _) {},
    );
    addTearDown(subscription.close);
    final controller = container.read(
      inlineScheduledMessageControllerProvider(_target).notifier,
    )..setTransportConnected(connected: true);
    await Future<void>.delayed(Duration.zero);
    expect(fake.listCalls, 1);

    container.read(activeBrokerProfileProvider.notifier).state = _profile(
      'profile-b',
    );
    oldResponse.complete(
      ScheduleListResponse(schedules: [_row(id: 'private-to-a')]),
    );
    for (var i = 0; i < 20; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(
      fake.listCalls,
      1,
      reason:
          'the standing connected report described profile-a transport; '
          'profile-b has not connected yet',
    );

    // Session Detail resets to a disconnected default for the new profile
    // (`forActiveSource`), so that is what Chat reports first.
    controller.setTransportConnected(connected: false);
    await Future<void>.delayed(Duration.zero);
    expect(fake.listCalls, 1);

    // Only profile-b's own connection arms profile-b's read.
    controller.setTransportConnected(connected: true);
    await Future<void>.delayed(Duration.zero);
    expect(fake.listCalls, 2);
    newResponse.complete(ScheduleListResponse(schedules: [_row(id: 'b-row')]));
    await Future<void>.delayed(Duration.zero);
    expect(
      container
          .read(inlineScheduledMessageControllerProvider(_target))
          .schedules
          .map((row) => row.id),
      ['b-row'],
      reason: "profile-a's response never reached profile-b's state",
    );
  });

  test(
    'an endpoint edit clears cards, retires A, and reads only B',
    () async {
      final held = Completer<ScheduleListResponse>();
      final alpha = _FakeBrokerClient(rows: const [], pendingLists: [held]);
      final beta = _FakeBrokerClient(rows: [_row(id: 'owned-by-beta')]);
      final container = ProviderContainer(
        overrides: [
          activeBrokerProfileProvider.overrideWith(
            (ref) => _profileAt('one-profile', 'http://alpha.test'),
          ),
          // One profile id, two machines: the client follows the endpoint the
          // profile currently points at, exactly as production does.
          brokerClientProvider.overrideWith((ref) async {
            final active = ref.watch(activeBrokerProfileProvider);
            return active?.baseUri.host == 'beta.test' ? beta : alpha;
          }),
        ],
      );
      addTearDown(container.dispose);
      final subscription = container.listen(
        inlineScheduledMessageControllerProvider(_target),
        (_, _) {},
      );
      addTearDown(subscription.close);
      final controller = container.read(
        inlineScheduledMessageControllerProvider(_target).notifier,
      )..setTransportConnected(connected: true);
      await Future<void>.delayed(Duration.zero);
      expect(alpha.listCalls, 1);
      controller.upsert(_row(id: 'card-from-alpha'));
      expect(
        container
            .read(inlineScheduledMessageControllerProvider(_target))
            .schedules
            .map((row) => row.id),
        ['card-from-alpha'],
      );

      // The SAME profile id, re-pointed at another machine.
      container.read(activeBrokerProfileProvider.notifier).state = _profileAt(
        'one-profile',
        'http://beta.test',
      );
      expect(
        container
            .read(inlineScheduledMessageControllerProvider(_target))
            .schedules,
        isEmpty,
        reason: "A's prompt-bearing cards go the moment the source changes",
      );
      expect(
        controller.debugPollingActive,
        isFalse,
        reason: "A's poll timer is disarmed; B has reported nothing yet",
      );

      held.complete(
        ScheduleListResponse(schedules: [_row(id: 'private-to-alpha')]),
      );
      for (var i = 0; i < 20; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(
        container
            .read(inlineScheduledMessageControllerProvider(_target))
            .schedules,
        isEmpty,
        reason: "A's late answer is inert under B",
      );
      expect(beta.listCalls, 0, reason: 'B has not reported a transport yet');

      // Only B's own connected transport arms B's read.
      controller.setTransportConnected(connected: true);
      await Future<void>.delayed(Duration.zero);
      expect(beta.listCalls, 1);
      expect(alpha.listCalls, 1);
      expect(
        container
            .read(inlineScheduledMessageControllerProvider(_target))
            .schedules
            .map((row) => row.id),
        ['owned-by-beta'],
      );

      // Debug reads by source too, so A's reading is not shown as B's.
      final readings = container.read(inlineScheduleDiagnosticsProvider);
      final alphaKey = InlineScheduleDiagnosticsKey(
        brokerScopeKey: RosterSource.ofProfile(
          _profileAt('one-profile', 'http://alpha.test'),
        ).storageKey,
        tool: 'codex',
        sessionId: 'session-1',
      );
      final betaKey = InlineScheduleDiagnosticsKey(
        brokerScopeKey: RosterSource.ofProfile(
          _profileAt('one-profile', 'http://beta.test'),
        ).storageKey,
        tool: 'codex',
        sessionId: 'session-1',
      );
      expect(alphaKey == betaKey, isFalse);
      expect(readings[betaKey]?.scheduleCount, 1);
    },
  );

  test('held refresh cannot erase an upserted and edited row', () async {
    final held = Completer<ScheduleListResponse>();
    final fake = _FakeBrokerClient(
      rows: const [],
      pendingLists: [held],
    );
    final container = _container(fake);
    addTearDown(container.dispose);
    final subscription = container.listen(
      inlineScheduledMessageControllerProvider(_target),
      (_, _) {},
    );
    addTearDown(subscription.close);
    final controller = container.read(
      inlineScheduledMessageControllerProvider(_target).notifier,
    )..setTransportConnected(connected: true);
    await Future<void>.delayed(Duration.zero);
    final created = _row(id: 'new', text: 'created');
    fake.rows = [created];
    controller.upsert(created);
    await controller.update(
      'new',
      const ScheduleUpdate(expectedRevision: 1, text: 'edited', at: 4000),
    );

    held.completeError(StateError('stale GET failed after local edit'));
    await Future<void>.delayed(Duration.zero);
    final row = container
        .read(inlineScheduledMessageControllerProvider(_target))
        .schedules
        .single;
    expect(row.id, 'new');
    expect(row.text, 'edited');
    expect(row.at, 4000);
    final state = container.read(
      inlineScheduledMessageControllerProvider(_target),
    );
    expect(state.loading, isFalse);
    expect(state.mutationError, isNull);
  });

  test('missing broker client settles loading with an honest error', () async {
    final container = ProviderContainer(
      overrides: [
        brokerClientProvider.overrideWith((ref) async => null),
        activeBrokerProfileProvider.overrideWith(
          (ref) => _profile('profile-a'),
        ),
      ],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      inlineScheduledMessageControllerProvider(_target),
      (_, _) {},
    );
    addTearDown(subscription.close);
    await container
        .read(inlineScheduledMessageControllerProvider(_target).notifier)
        .refresh();
    final state = container.read(
      inlineScheduledMessageControllerProvider(_target),
    );
    expect(state.loading, isFalse);
    expect(
      state.mutationError?.failure,
      InlineScheduleActionFailure.connectToView,
    );
    expect(state.freshness, InlineScheduleFreshness.stale);
  });

  test(
    'drops terminal rows and ignores a late response after profile switch',
    () async {
      final pending = Completer<ScheduleListResponse>();
      final fake = _FakeBrokerClient(
        rows: [_row(id: 'live')],
        pendingLists: [pending],
      );
      final container = _container(fake, profile: _profile('profile-a'));
      addTearDown(container.dispose);
      final subscription = container.listen(
        inlineScheduledMessageControllerProvider(_target),
        (_, _) {},
      );
      addTearDown(subscription.close);
      final controller = container.read(
        inlineScheduledMessageControllerProvider(_target).notifier,
      );
      final refresh = controller.refresh();
      await Future<void>.delayed(Duration.zero);
      fake.rows = const [];
      container.read(activeBrokerProfileProvider.notifier).state = _profile(
        'profile-b',
      );
      pending.complete(
        ScheduleListResponse(schedules: [_row(id: 'private-to-a')]),
      );
      await refresh;
      expect(
        container
            .read(inlineScheduledMessageControllerProvider(_target))
            .schedules,
        isEmpty,
      );

      fake.rows = [_row(id: 'same', state: ScheduleState.delivered)];
      final current = container.read(
        inlineScheduledMessageControllerProvider(_target).notifier,
      );
      await current.refresh();
      expect(
        container
            .read(inlineScheduledMessageControllerProvider(_target))
            .schedules,
        isEmpty,
      );
    },
  );

  group('U6 transport-gated automatic refresh', () {
    testWidgets('connected initial refresh loads a schedule', (tester) async {
      final fake = _FakeBrokerClient(rows: [_row(id: 'target')]);
      await _withLifecycle(tester, fake, (container, controller) async {
        controller.setTransportConnected(connected: true);
        await tester.pump(Duration.zero);

        expect(fake.listCalls, 1);
        final state = container.read(
          inlineScheduledMessageControllerProvider(_target),
        );
        expect(state.schedules.map((row) => row.id), ['target']);
        expect(state.freshness, InlineScheduleFreshness.fresh);
        expect(state.loading, isFalse);
      });
    });

    testWidgets('initial open while offline makes zero requests', (
      tester,
    ) async {
      final fake = _FakeBrokerClient(rows: [_row(id: 'target')]);
      await _withLifecycle(tester, fake, (container, controller) async {
        await tester.pump(Duration.zero);
        await tester.pump(_pollInterval * 3);
        expect(fake.listCalls, 0);
        expect(controller.debugPollingActive, isFalse);

        controller.setTransportConnected(connected: true);
        await tester.pump(Duration.zero);
        expect(fake.listCalls, 1);
      });
    });

    testWidgets(
      'offline across multiple poll intervals makes no request and keeps rows',
      (tester) async {
        final fake = _FakeBrokerClient(rows: [_row(id: 'target')]);
        await _withLifecycle(tester, fake, (container, controller) async {
          controller.setTransportConnected(connected: true);
          await tester.pump(Duration.zero);
          expect(fake.listCalls, 1);

          controller.setTransportConnected(connected: false);
          await tester.pump(_pollInterval * 3);

          expect(fake.listCalls, 1, reason: 'no passive work while offline');
          expect(controller.debugPollingActive, isFalse);
          final state = container.read(
            inlineScheduledMessageControllerProvider(_target),
          );
          expect(state.schedules.map((row) => row.id), ['target']);
          expect(state.mutationError, isNull);
          expect(state.loading, isFalse);
        });
      },
    );

    testWidgets('reconnect issues one refresh then resumes the cadence', (
      tester,
    ) async {
      final fake = _FakeBrokerClient(rows: [_row(id: 'target')]);
      await _withLifecycle(tester, fake, (container, controller) async {
        controller.setTransportConnected(connected: true);
        await tester.pump(Duration.zero);
        expect(fake.listCalls, 1);

        controller.setTransportConnected(connected: false);
        await tester.pump(_pollInterval * 2);
        expect(fake.listCalls, 1);

        controller.setTransportConnected(connected: true);
        await tester.pump(Duration.zero);
        expect(fake.listCalls, 2, reason: 'exactly one reconnect refresh');

        await tester.pump(_pollInterval);
        expect(fake.listCalls, 3);
        await tester.pump(_pollInterval);
        expect(fake.listCalls, 4, reason: 'one request per existing interval');
      });
    });

    testWidgets('repeated lifecycle frames do not duplicate work', (
      tester,
    ) async {
      final fake = _FakeBrokerClient(rows: [_row(id: 'target')]);
      await _withLifecycle(tester, fake, (container, controller) async {
        for (var i = 0; i < 5; i++) {
          controller.setTransportConnected(connected: true);
        }
        await tester.pump(Duration.zero);
        expect(fake.listCalls, 1);

        for (var i = 0; i < 5; i++) {
          controller.setTransportConnected(connected: false);
        }
        await tester.pump(_pollInterval * 2);
        expect(fake.listCalls, 1);
        expect(controller.debugPollingActive, isFalse);

        for (var i = 0; i < 5; i++) {
          controller.setTransportConnected(connected: true);
        }
        await tester.pump(Duration.zero);
        expect(fake.listCalls, 2, reason: 'one reconnect read, not five');

        // One armed timer, so exactly one request lands per interval.
        await tester.pump(_pollInterval);
        expect(fake.listCalls, 3);
      });
    });

    testWidgets(
      'a retained hidden page stays silent across an app resume',
      (tester) async {
        final fake = _FakeBrokerClient(rows: [_row(id: 'target')]);
        await _withLifecycle(tester, fake, (container, controller) async {
          controller.setTransportConnected(connected: true);
          await tester.pump(Duration.zero);
          expect(fake.listCalls, 1);

          controller.setHostVisible(visible: false);
          await tester.pump(_pollInterval * 2);
          expect(fake.listCalls, 1);
          expect(controller.debugPollingActive, isFalse);

          controller
            ..setAppVisible(visible: false)
            ..setAppVisible(visible: true);
          await tester.pump(_pollInterval * 2);
          expect(
            fake.listCalls,
            1,
            reason: 'app resume cannot reactivate a hidden retained page',
          );
          expect(controller.debugPollingActive, isFalse);

          controller.setHostVisible(visible: true);
          await tester.pump(Duration.zero);
          expect(fake.listCalls, 2, reason: 'onstage gets one catch-up read');
          await tester.pump(_pollInterval);
          expect(fake.listCalls, 3, reason: 'one timer resumes');
        });
      },
    );

    testWidgets('disposal stops the poll timer', (tester) async {
      final fake = _FakeBrokerClient(rows: [_row(id: 'target')]);
      final container = _container(fake);
      final subscription = container.listen(
        inlineScheduledMessageControllerProvider(_target),
        (_, _) {},
      );
      final controller = container.read(
        inlineScheduledMessageControllerProvider(_target).notifier,
      )..setTransportConnected(connected: true);
      await tester.pump(Duration.zero);
      expect(fake.listCalls, 1);
      expect(controller.debugPollingActive, isTrue);

      // Leaving Chat drops the last listener, which disposes the autoDispose
      // provider exactly as navigating away does.
      subscription.close();
      await tester.pump(Duration.zero);
      expect(controller.debugPollingActive, isFalse);

      await tester.pump(_pollInterval * 3);
      expect(fake.listCalls, 1);
      container.dispose();
      await tester.pump(Duration.zero);
    });

    testWidgets(
      'a passive failure keeps rows, marks stale, and stays out of Chat',
      (tester) async {
        final failing = Completer<ScheduleListResponse>();
        final fake = _FakeBrokerClient(
          rows: [_row(id: 'target')],
          pendingLists: [null, failing],
        );
        await _withLifecycle(tester, fake, (container, controller) async {
          controller.setTransportConnected(connected: true);
          await tester.pump(Duration.zero);
          expect(fake.listCalls, 1);

          await tester.pump(_pollInterval);
          failing.completeError(
            const BrokerException(message: 'connection refused'),
          );
          await tester.pump(Duration.zero);

          final state = container.read(
            inlineScheduledMessageControllerProvider(_target),
          );
          expect(state.schedules.map((row) => row.id), ['target']);
          expect(state.freshness, InlineScheduleFreshness.stale);
          expect(state.mutationError, isNull);
          expect(state.loading, isFalse);
        });
      },
    );

    testWidgets(
      'a later passive success renews rows without clearing a standing '
      'mutation error',
      (tester) async {
        final fake = _FakeBrokerClient(
          rows: [_row(id: 'target')],
          updateError: const BrokerException(message: 'edit refused'),
        );
        await _withLifecycle(tester, fake, (container, controller) async {
          controller.setTransportConnected(connected: true);
          await tester.pump(Duration.zero);

          await controller.update(
            'target',
            const ScheduleUpdate(expectedRevision: 1, text: 'edited', at: 4000),
          );
          expect(
            container
                .read(inlineScheduledMessageControllerProvider(_target))
                .mutationError
                ?.failure,
            InlineScheduleActionFailure.mutationFailed,
          );

          fake.rows = [_row(id: 'target', text: 'renewed')];
          await tester.pump(_pollInterval);
          await tester.pump(Duration.zero);

          final state = container.read(
            inlineScheduledMessageControllerProvider(_target),
          );
          expect(state.schedules.single.text, 'renewed');
          expect(state.freshness, InlineScheduleFreshness.fresh);
          expect(
            state.mutationError?.failure,
            InlineScheduleActionFailure.mutationFailed,
            reason: 'a passive success must not absolve an explicit failure',
          );
        });
      },
    );

    testWidgets(
      'a HUNG pre-disconnect request cannot stall reconnect, and is released '
      'rather than left holding a socket',
      (tester) async {
        final hung = Completer<ScheduleListResponse>();
        final fake = _FakeBrokerClient(
          rows: [_row(id: 'target')],
          pendingLists: [hung],
        );
        await _withLifecycle(tester, fake, (container, controller) async {
          controller.setTransportConnected(connected: true);
          await tester.pump(Duration.zero);
          expect(fake.listCalls, 1);
          expect(
            container
                .read(inlineScheduledMessageControllerProvider(_target))
                .loading,
            isTrue,
          );

          // The socket dies mid-request and never answers.
          controller.setTransportConnected(connected: false);
          await tester.pump(Duration.zero);
          expect(
            fake.canceledLists,
            1,
            reason:
                'the drop RELEASES the request; the broker client has no '
                'default timeout, so an abandoned read that is merely ignored '
                'holds its connection slot indefinitely',
          );
          expect(
            container
                .read(inlineScheduledMessageControllerProvider(_target))
                .loading,
            isFalse,
            reason:
                'the drop settles the indicator; it does not wait on a '
                'socket that may never fail',
          );
          await tester.pump(_pollInterval * 2);
          expect(fake.listCalls, 1);

          // Reconnect with the pre-drop GET STILL unresolved.
          fake.rows = [_row(id: 'target'), _row(id: 'after-reconnect')];
          controller.setTransportConnected(connected: true);
          await tester.pump(Duration.zero);
          expect(
            fake.listCalls,
            2,
            reason:
                'the reconnect read starts immediately rather than queuing '
                'behind a request that may never settle',
          );
          expect(
            container
                .read(inlineScheduledMessageControllerProvider(_target))
                .schedules
                .map((row) => row.id),
            ['after-reconnect', 'target'],
          );

          // The abandoned request is already settled by its cancellation, so
          // there is no late answer left to ignore. Nothing it might have said
          // reached the state either way.
          expect(hung.isCompleted, isTrue);
          await tester.pump(Duration.zero);
          final state = container.read(
            inlineScheduledMessageControllerProvider(_target),
          );
          expect(
            state.schedules.map((row) => row.id),
            ['after-reconnect', 'target'],
            reason: 'the retired response never published',
          );
          expect(state.loading, isFalse);
          expect(state.mutationError, isNull);
        });
      },
    );

    testWidgets('a retired request cannot publish its error either', (
      tester,
    ) async {
      final held = Completer<ScheduleListResponse>();
      final fake = _FakeBrokerClient(
        rows: [_row(id: 'target')],
        pendingLists: [null, held],
      );
      await _withLifecycle(tester, fake, (container, controller) async {
        controller.setTransportConnected(connected: true);
        await tester.pump(Duration.zero);
        await tester.pump(_pollInterval);
        expect(fake.listCalls, 2);

        controller.setTransportConnected(connected: false);
        held.completeError(const BrokerException(message: 'connection reset'));
        await tester.pump(Duration.zero);

        final state = container.read(
          inlineScheduledMessageControllerProvider(_target),
        );
        expect(state.mutationError, isNull);
        expect(state.loading, isFalse);
        expect(
          state.freshness,
          InlineScheduleFreshness.fresh,
          reason: 'a retired result reports nothing, not even staleness',
        );
      });
    });

    testWidgets('explicit update and cancel failures stay actionable', (
      tester,
    ) async {
      final fake = _FakeBrokerClient(
        rows: [_row(id: 'target')],
        updateError: const BrokerException(message: 'edit refused'),
        deleteError: const BrokerException(
          message: 'cancel refused',
          statusCode: 500,
        ),
      );
      await _withLifecycle(tester, fake, (container, controller) async {
        controller.setTransportConnected(connected: true);
        await tester.pump(Duration.zero);

        expect(
          await controller.update(
            'target',
            const ScheduleUpdate(expectedRevision: 1, text: 'edited', at: 4000),
          ),
          isFalse,
        );
        var state = container.read(
          inlineScheduledMessageControllerProvider(_target),
        );
        expect(
          state.mutationError?.failure,
          InlineScheduleActionFailure.mutationFailed,
        );
        expect(state.mutationError?.failureKind, FailureKind.offline);
        expect(state.schedules.map((row) => row.id), ['target']);

        expect(await controller.cancel('target'), isFalse);
        state = container.read(
          inlineScheduledMessageControllerProvider(_target),
        );
        expect(
          state.mutationError?.failure,
          InlineScheduleActionFailure.mutationFailed,
        );
        expect(state.mutationError?.failureKind, FailureKind.brokerFault);
        expect(
          state.schedules.map((row) => row.id),
          ['target'],
          reason: 'a failed cancel keeps its recovery row',
        );

        // Explicit failures are not suppressed by an offline transport either.
        controller.setTransportConnected(connected: false);
        expect(await controller.cancel('missing-row'), isFalse);
        state = container.read(
          inlineScheduledMessageControllerProvider(_target),
        );
        expect(
          state.mutationError?.failure,
          InlineScheduleActionFailure.missingRow,
        );
      });
    });

    testWidgets(
      'a passive 401 stays actionable instead of becoming silent staleness',
      (tester) async {
        final failing = Completer<ScheduleListResponse>();
        final fake = _FakeBrokerClient(
          rows: [_row(id: 'target')],
          pendingLists: [null, failing],
        );
        await _withLifecycle(tester, fake, (container, controller) async {
          controller.setTransportConnected(connected: true);
          await tester.pump(Duration.zero);

          await tester.pump(_pollInterval);
          failing.completeError(
            const BrokerException(message: 'token expired', statusCode: 401),
          );
          await tester.pump(Duration.zero);

          final state = container.read(
            inlineScheduledMessageControllerProvider(_target),
          );
          expect(
            state.mutationError?.failure,
            InlineScheduleActionFailure.refreshFailed,
            reason:
                'an expired credential is not connectivity noise; the next '
                'poll cannot resolve it',
          );
          expect(state.mutationError?.failureKind, FailureKind.unauthorized);
          expect(
            state.mutationError?.provenance,
            InlineScheduleFailureProvenance.passiveRefresh,
          );
          expect(state.passiveFailure?.failureKind, FailureKind.unauthorized);
          expect(state.schedules.map((row) => row.id), ['target']);
        });
      },
    );

    testWidgets('a passive structured 4xx stays actionable', (tester) async {
      final failing = Completer<ScheduleListResponse>();
      final fake = _FakeBrokerClient(
        rows: [_row(id: 'target')],
        pendingLists: [null, failing],
      );
      await _withLifecycle(tester, fake, (container, controller) async {
        controller.setTransportConnected(connected: true);
        await tester.pump(Duration.zero);

        await tester.pump(_pollInterval);
        failing.completeError(
          const BrokerException(
            message: 'unsupported contract revision',
            statusCode: 400,
            error: BrokerError(
              error: 'client contract revision is not supported',
              code: 'CONTRACT_INCOMPATIBLE',
            ),
          ),
        );
        await tester.pump(Duration.zero);

        final state = container.read(
          inlineScheduledMessageControllerProvider(_target),
        );
        expect(state.mutationError?.failureKind, FailureKind.rejected);
        expect(
          state.mutationError?.provenance,
          InlineScheduleFailureProvenance.passiveRefresh,
        );
        expect(
          state.mutationError?.detail,
          contains('CONTRACT_INCOMPATIBLE'),
          reason: 'the raw text is kept for Debug, never as primary copy',
        );
      });
    });

    testWidgets(
      'an oversized broker body is bounded in live controller state, not '
      'only where Debug copies it',
      (tester) async {
        final failing = Completer<ScheduleListResponse>();
        final fake = _FakeBrokerClient(
          rows: [_row(id: 'target')],
          pendingLists: [null, failing],
        );
        await _withLifecycle(tester, fake, (container, controller) async {
          controller.setTransportConnected(connected: true);
          await tester.pump(Duration.zero);

          await tester.pump(_pollInterval);
          // Actionable, so it is retained TWICE: as the Debug-facing
          // passiveFailure and as the promoted visible row.
          failing.completeError(
            BrokerException(
              message: 'x' * 5000,
              statusCode: 401,
            ),
          );
          await tester.pump(Duration.zero);

          const bounded =
              InlineScheduleDiagnostics.detailCharacterLimit +
              InlineScheduleDiagnostics.truncationMarker.length;
          final state = container.read(
            inlineScheduledMessageControllerProvider(_target),
          );
          expect(
            state.passiveFailure?.detail?.length,
            bounded,
            reason:
                'the unbounded original stays resident in controller state '
                'until the next successful read, so the bound belongs at '
                'construction',
          );
          expect(
            state.mutationError?.detail?.length,
            bounded,
            reason: 'the promoted copy is bounded too',
          );
          expect(
            state.passiveFailure?.detail,
            endsWith(InlineScheduleDiagnostics.truncationMarker),
          );

          // Debug reads the already-bounded value; re-bounding is a no-op
          // rather than a second cut with a stacked marker.
          final reading =
              container.read(
                inlineScheduleDiagnosticsProvider,
              )[InlineScheduleDiagnosticsKey(
                brokerScopeKey: RosterSource.ofProfile(
                  _profile('p'),
                ).storageKey,
                tool: 'codex',
                sessionId: 'session-1',
              )];
          expect(reading?.passiveFailureDetail?.length, bounded);
          expect(reading?.passiveFailureDetail, state.passiveFailure?.detail);
        });
      },
    );

    testWidgets('offline and broker-fault passive failures stay silent', (
      tester,
    ) async {
      final offline = Completer<ScheduleListResponse>();
      final serverFault = Completer<ScheduleListResponse>();
      final fake = _FakeBrokerClient(
        rows: [_row(id: 'target')],
        pendingLists: [null, offline, serverFault],
      );
      await _withLifecycle(tester, fake, (container, controller) async {
        controller.setTransportConnected(connected: true);
        await tester.pump(Duration.zero);

        await tester.pump(_pollInterval);
        offline.completeError(const BrokerException(message: 'refused'));
        await tester.pump(Duration.zero);
        var state = container.read(
          inlineScheduledMessageControllerProvider(_target),
        );
        expect(state.mutationError, isNull);
        expect(state.passiveFailure?.failureKind, FailureKind.offline);
        expect(state.freshness, InlineScheduleFreshness.stale);

        await tester.pump(_pollInterval);
        serverFault.completeError(
          const BrokerException(message: 'boom', statusCode: 503),
        );
        await tester.pump(Duration.zero);
        state = container.read(
          inlineScheduledMessageControllerProvider(_target),
        );
        expect(
          state.mutationError,
          isNull,
          reason: 'a transient broker-side fault is what the next poll fixes',
        );
        expect(state.passiveFailure?.failureKind, FailureKind.brokerFault);
      });
    });

    testWidgets('a passive success clears only what a passive read raised', (
      tester,
    ) async {
      final failing = Completer<ScheduleListResponse>();
      final fake = _FakeBrokerClient(
        rows: [_row(id: 'target')],
        pendingLists: [null, failing],
      );
      await _withLifecycle(tester, fake, (container, controller) async {
        controller.setTransportConnected(connected: true);
        await tester.pump(Duration.zero);

        await tester.pump(_pollInterval);
        failing.completeError(
          const BrokerException(message: 'token expired', statusCode: 401),
        );
        await tester.pump(Duration.zero);
        expect(
          container
              .read(inlineScheduledMessageControllerProvider(_target))
              .mutationError,
          isNotNull,
        );

        // Credentials are repaired; the next poll succeeds.
        await tester.pump(_pollInterval);
        await tester.pump(Duration.zero);
        final state = container.read(
          inlineScheduledMessageControllerProvider(_target),
        );
        expect(
          state.mutationError,
          isNull,
          reason: 'the passive-raised row goes when its condition resolves',
        );
        expect(state.passiveFailure, isNull);
        expect(state.freshness, InlineScheduleFreshness.fresh);
      });
    });

    testWidgets(
      'an explicit refresh supersedes an active poll instead of waiting for '
      "it, and the poll's late answer is fenced out",
      (tester) async {
        final heldPoll = Completer<ScheduleListResponse>();
        final fake = _FakeBrokerClient(
          rows: [_row(id: 'target')],
          pendingLists: [null, heldPoll],
        );
        await _withLifecycle(tester, fake, (container, controller) async {
          controller.setTransportConnected(connected: true);
          await tester.pump(Duration.zero);
          expect(fake.listCalls, 1);

          // The 15s poll fires and the broker holds it open.
          await tester.pump(_pollInterval);
          expect(fake.listCalls, 2);

          // The user asks for a refresh while that poll is still open.
          fake.rows = [_row(id: 'explicit-truth')];
          final explicit = controller.refresh();
          await tester.pump(Duration.zero);
          expect(
            fake.listCalls,
            3,
            reason:
                'a user action issues its own read rather than inherit the '
                'timing of a poll that may never answer',
          );
          await explicit;
          await tester.pump(Duration.zero);
          expect(
            container
                .read(inlineScheduledMessageControllerProvider(_target))
                .schedules
                .map((row) => row.id),
            ['explicit-truth'],
          );

          // The superseded poll was canceled at the moment it was superseded,
          // so it never gets to answer with its older rows at all.
          expect(
            heldPoll.isCompleted,
            isTrue,
            reason: 'superseding a read releases it rather than ignoring it',
          );
          expect(fake.canceledLists, 1);
          expect(fake.outstandingLists, 0);
          await tester.pump(Duration.zero);

          final state = container.read(
            inlineScheduledMessageControllerProvider(_target),
          );
          expect(
            state.schedules.map((row) => row.id),
            ['explicit-truth'],
            reason: 'a superseded read can never overwrite a newer answer',
          );
          expect(state.freshness, InlineScheduleFreshness.fresh);
          expect(state.loading, isFalse);
        });
      },
    );

    testWidgets(
      'reads admitted under profile A publish nothing once B is active',
      (tester) async {
        final heldPoll = Completer<ScheduleListResponse>();
        final heldExplicit = Completer<ScheduleListResponse>();
        final fake = _FakeBrokerClient(
          rows: [_row(id: 'b-row')],
          pendingLists: [heldPoll, heldExplicit],
        );
        final container = _container(fake, profile: _profile('profile-a'));
        final subscription = container.listen(
          inlineScheduledMessageControllerProvider(_target),
          (_, _) {},
        );
        try {
          final controller = container.read(
            inlineScheduledMessageControllerProvider(_target).notifier,
          )..setTransportConnected(connected: true);
          await tester.pump(Duration.zero);
          expect(fake.listCalls, 1);

          // A user refresh under A, issued while A's poll is still open.
          unawaited(controller.refresh());
          await tester.pump(Duration.zero);
          expect(fake.listCalls, 2);

          container.read(activeBrokerProfileProvider.notifier).state = _profile(
            'profile-b',
          );
          await tester.pump(Duration.zero);
          expect(
            fake.listCalls,
            2,
            reason: 'B has not reported a connected transport of its own',
          );

          // The switch released whatever was still open under A. Anything the
          // cancellation did not already settle answers now, after the switch.
          expect(fake.outstandingLists, 0, reason: 'A holds no socket under B');
          for (final held in [heldPoll, heldExplicit]) {
            if (!held.isCompleted) {
              held.complete(
                ScheduleListResponse(schedules: [_row(id: 'a-late')]),
              );
            }
          }
          await tester.pump(Duration.zero);
          await tester.pump(_pollInterval);

          expect(
            fake.listCalls,
            2,
            reason: 'an A-originated read must never issue a request under B',
          );
          final state = container.read(
            inlineScheduledMessageControllerProvider(_target),
          );
          expect(
            state.schedules,
            isEmpty,
            reason: "A's rows must not land in B's state",
          );
          expect(state.freshness, InlineScheduleFreshness.unknown);
          expect(state.loading, isFalse);
          expect(tester.takeException(), isNull);
        } finally {
          subscription.close();
          container.dispose();
          await tester.pump(Duration.zero);
        }
      },
    );

    testWidgets(
      'reads still open when Chat is torn down publish nothing and do not '
      'touch the disposed notifier',
      (tester) async {
        final heldPoll = Completer<ScheduleListResponse>();
        final heldExplicit = Completer<ScheduleListResponse>();
        final fake = _FakeBrokerClient(
          rows: [_row(id: 'target')],
          pendingLists: [heldPoll, heldExplicit],
        );
        final container = _container(fake);
        final subscription = container.listen(
          inlineScheduledMessageControllerProvider(_target),
          (_, _) {},
        );
        final controller = container.read(
          inlineScheduledMessageControllerProvider(_target).notifier,
        )..setTransportConnected(connected: true);
        await tester.pump(Duration.zero);
        expect(fake.listCalls, 1);

        unawaited(controller.refresh());
        await tester.pump(Duration.zero);
        expect(fake.listCalls, 2);

        // Leaving Chat auto-disposes the controller with both reads open.
        subscription.close();
        container.dispose();
        await tester.pump(Duration.zero);

        expect(
          fake.outstandingLists,
          0,
          reason: 'teardown releases every read it left open',
        );
        for (final held in [heldPoll, heldExplicit]) {
          if (!held.isCompleted) {
            held.complete(
              ScheduleListResponse(schedules: [_row(id: 'late')]),
            );
          }
        }
        await tester.pump(Duration.zero);
        await tester.pump(_pollInterval);

        expect(
          fake.listCalls,
          2,
          reason: 'a disposed controller issues nothing further',
        );
        expect(
          tester.takeException(),
          isNull,
          reason:
              'a read that outlives its notifier must touch neither ref nor '
              'state',
        );
      },
    );

    testWidgets(
      'repeated supersession across refresh, reconnect, and disposal keeps '
      'outstanding reads bounded to one',
      (tester) async {
        // Every read is held open, so nothing settles on its own: only
        // cancellation can bound this.
        final held = List.generate(
          9,
          (_) => Completer<ScheduleListResponse>(),
        );
        final fake = _FakeBrokerClient(
          rows: [_row(id: 'target')],
          pendingLists: [...held],
        );
        final container = _container(fake);
        final subscription = container.listen(
          inlineScheduledMessageControllerProvider(_target),
          (_, _) {},
        );
        final controller = container.read(
          inlineScheduledMessageControllerProvider(_target).notifier,
        )..setTransportConnected(connected: true);
        await tester.pump(Duration.zero);

        for (var round = 0; round < 3; round++) {
          // A user refresh supersedes the poll that is still open.
          unawaited(controller.refresh());
          await tester.pump(Duration.zero);
          // The next 15s tick replaces that read rather than riding it.
          await tester.pump(_pollInterval);
          // Reconnect churn retires whatever is open.
          controller
            ..setTransportConnected(connected: false)
            ..setTransportConnected(connected: true);
          await tester.pump(Duration.zero);
        }

        expect(
          fake.listCalls,
          greaterThan(3),
          reason: 'the loop really did issue repeated reads',
        );
        expect(
          fake.peakOutstandingLists,
          1,
          reason:
              'a superseded read that is merely ignored keeps its request and '
              'connection slot; only cancellation bounds this',
        );

        // Leaving Chat releases the last one.
        subscription.close();
        container.dispose();
        await tester.pump(Duration.zero);

        expect(
          fake.outstandingLists,
          0,
          reason: 'disposal leaves no read holding a connection',
        );
        expect(
          fake.canceledLists,
          fake.listCalls,
          reason:
              'every read in this run was held open, so every one of them had '
              'to be settled by a cancellation rather than by the broker',
        );
        expect(
          held.take(fake.listCalls).every((completer) => completer.isCompleted),
          isTrue,
          reason: 'canceled reads settle rather than hang on',
        );
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'a 409 reconciles without waiting for a poll the broker never answers',
      (tester) async {
        final heldPoll = Completer<ScheduleListResponse>();
        final fake = _FakeBrokerClient(
          rows: [_row(id: 'target')],
          pendingLists: [null, heldPoll],
          deleteError: const BrokerException(
            message: 'revision conflict',
            statusCode: 409,
          ),
        );
        await _withLifecycle(tester, fake, (container, controller) async {
          controller.setTransportConnected(connected: true);
          await tester.pump(Duration.zero);
          expect(fake.listCalls, 1);

          // The 15s poll fires and the broker never answers it.
          await tester.pump(_pollInterval);
          expect(fake.listCalls, 2);

          expect(await controller.cancel('target'), isFalse);

          expect(
            fake.listCalls,
            3,
            reason: 'reconciliation issued its own read rather than wait',
          );
          expect(
            fake.canceledLists,
            1,
            reason:
                'the hung poll was released, not awaited: reconciliation '
                'superseded it',
          );
          expect(fake.outstandingLists, 0);
          final state = container.read(
            inlineScheduledMessageControllerProvider(_target),
          );
          expect(
            state.mutatingIds,
            isEmpty,
            reason: 'a hung poll must not leave the row spinning forever',
          );
          expect(
            state.mutationError?.failure,
            InlineScheduleActionFailure.conflict,
          );
        });
      },
    );

    testWidgets("an A -> B -> A profile round trip cannot revive A's report", (
      tester,
    ) async {
      final fake = _FakeBrokerClient(rows: [_row(id: 'target')]);
      final container = _container(fake, profile: _profile('profile-a'));
      final subscription = container.listen(
        inlineScheduledMessageControllerProvider(_target),
        (_, _) {},
      );
      try {
        final controller = container.read(
          inlineScheduledMessageControllerProvider(_target).notifier,
        )..setTransportConnected(connected: true);
        await tester.pump(Duration.zero);
        expect(fake.listCalls, 1);

        final profiles = container.read(activeBrokerProfileProvider.notifier)
          ..state = _profile('profile-b');
        await tester.pump(Duration.zero);
        profiles.state = _profile('profile-a');
        await tester.pump(Duration.zero);
        await tester.pump(_pollInterval * 2);

        expect(
          fake.listCalls,
          1,
          reason:
              "A's original report predates two switches; returning to A "
              'must not revive it',
        );
        expect(controller.debugPollingActive, isFalse);

        // Only a fresh report for the current profile arms it again.
        controller.setTransportConnected(connected: true);
        await tester.pump(Duration.zero);
        expect(fake.listCalls, 2);
      } finally {
        subscription.close();
        container.dispose();
        await tester.pump(Duration.zero);
      }
    });

    testWidgets('a passive refresh never clears a standing mutation error', (
      tester,
    ) async {
      final fake = _FakeBrokerClient(
        rows: [_row(id: 'target')],
        deleteError: const BrokerException(
          message: 'cancel refused',
          statusCode: 500,
        ),
      );
      await _withLifecycle(tester, fake, (container, controller) async {
        controller.setTransportConnected(connected: true);
        await tester.pump(Duration.zero);
        await controller.cancel('target');
        expect(
          container
              .read(inlineScheduledMessageControllerProvider(_target))
              .mutationError,
          isNotNull,
        );

        // Reconnect churn runs a fresh passive read; the failure stays put.
        controller
          ..setTransportConnected(connected: false)
          ..setTransportConnected(connected: true);
        await tester.pump(Duration.zero);
        expect(
          container
              .read(inlineScheduledMessageControllerProvider(_target))
              .mutationError
              ?.failure,
          InlineScheduleActionFailure.mutationFailed,
        );

        // A later successful explicit mutation clears it normally.
        fake.deleteError = null;
        expect(await controller.cancel('target'), isTrue);
        expect(
          container
              .read(inlineScheduledMessageControllerProvider(_target))
              .mutationError,
          isNull,
        );
      });
    });
  });
}

/// Runs [body] against a live controller and tears the provider down INSIDE the
/// test body.
///
/// `addTearDown` would be too late: the widget-test binding asserts no timer is
/// pending as soon as the body returns, and the whole point of these cases is
/// that a real 15-second [Timer.periodic] is armed while connected.
Future<void> _withLifecycle(
  WidgetTester tester,
  _FakeBrokerClient fake,
  Future<void> Function(
    ProviderContainer container,
    InlineScheduledMessageController controller,
  )
  body,
) async {
  final container = _container(fake);
  final subscription = container.listen(
    inlineScheduledMessageControllerProvider(_target),
    (_, _) {},
  );
  try {
    await body(
      container,
      container.read(
        inlineScheduledMessageControllerProvider(_target).notifier,
      ),
    );
  } finally {
    subscription.close();
    container.dispose();
    await tester.pump(Duration.zero);
  }
}

const _target = InlineScheduledMessageKey(
  tool: 'codex',
  sessionId: 'session-1',
);

const Duration _pollInterval = InlineScheduledMessageController.pollInterval;

ProviderContainer _container(
  _FakeBrokerClient fake, {
  BrokerProfile? profile,
}) => ProviderContainer(
  overrides: [
    brokerClientProvider.overrideWith((ref) async => fake),
    activeBrokerProfileProvider.overrideWith((ref) => profile ?? _profile('p')),
  ],
);

/// A profile whose id says nothing about which machine it points at.
BrokerProfile _profileAt(String id, String endpoint) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse(endpoint),
  createdAt: DateTime(2026, 7, 17),
);

BrokerProfile _profile(String id) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse('http://$id.test'),
  createdAt: DateTime(2026, 7, 17),
);

ScheduleRecord _row({
  required String id,
  String tool = 'codex',
  String sessionId = 'session-1',
  ScheduleKind kind = ScheduleKind.message,
  ScheduleState state = ScheduleState.scheduled,
  String text = 'Prompt',
  int at = 2000,
  int revision = 1,
}) => ScheduleRecord(
  id: id,
  revision: revision,
  kind: kind,
  tool: tool,
  sessionId: sessionId,
  text: text,
  at: at,
  state: state,
  createdAt: 1,
  updatedAt: 1,
);

final class _FakeBrokerClient extends BrokerClient {
  _FakeBrokerClient({
    required this.rows,
    this.pendingLists,
    this.updateError,
    this.deleteError,
  }) : super(baseUrl: 'http://test');

  List<ScheduleRecord> rows;

  /// Per-call scripting for [listSchedules]: a completer holds that call open,
  /// `null` lets it answer from [rows] immediately.
  final List<Completer<ScheduleListResponse>?>? pendingLists;
  Object? updateError;
  Object? deleteError;
  int listCalls = 0;

  /// Reads issued but not yet settled — the connection slots actually held.
  int outstandingLists = 0;

  /// Highest [outstandingLists] ever observed. The bound under test.
  int peakOutstandingLists = 0;

  /// Reads that ended because the caller canceled them.
  int canceledLists = 0;
  String? updatedId;
  ScheduleUpdate? updatedRequest;
  String? deletedId;

  @override
  Future<ScheduleListResponse> listSchedules({
    CancelToken? cancelToken,
  }) async {
    listCalls += 1;
    final pending = pendingLists;
    Completer<ScheduleListResponse>? held;
    if (pending != null && pending.isNotEmpty) held = pending.removeAt(0);
    if (held == null) return ScheduleListResponse(schedules: rows);

    outstandingLists += 1;
    if (outstandingLists > peakOutstandingLists) {
      peakOutstandingLists = outstandingLists;
    }
    // Stands in for Dio aborting the request: a canceled read SETTLES rather
    // than hanging on, which is the whole point of holding the token.
    unawaited(
      cancelToken?.whenCancel.then((_) {
        if (!held!.isCompleted) {
          canceledLists += 1;
          held.completeError(const RequestCancelled());
        }
      }),
    );
    try {
      return await held.future;
    } finally {
      outstandingLists -= 1;
    }
  }

  @override
  Future<ScheduleMutationResponse> updateSchedule(
    String id,
    ScheduleUpdate request,
  ) async {
    updatedId = id;
    updatedRequest = request;
    final error = updateError;
    if (error != null) Error.throwWithStackTrace(error, StackTrace.current);
    final current = rows.firstWhere((row) => row.id == id);
    final next = _row(
      id: id,
      text: request.text ?? current.text,
      at: request.at ?? current.at,
      revision: current.revision + 1,
    );
    rows = [next, ...rows.where((row) => row.id != id)];
    return ScheduleMutationResponse(schedule: next);
  }

  @override
  Future<ScheduleDeleteResponse> deleteSchedule(String id) async {
    deletedId = id;
    final error = deleteError;
    if (error != null) Error.throwWithStackTrace(error, StackTrace.current);
    rows = rows.where((row) => row.id != id).toList();
    return ScheduleCanceledResponse(
      schedule: _row(
        id: id,
        state: ScheduleState.canceled,
      ),
    );
  }
}
