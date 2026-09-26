@TestOn('browser')
library;

import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/platform/notifications/presentation_coordinator_web.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../support/notification_test_support.dart';

/// Two coordinators in one page stand in for two tabs: Web Locks are shared by
/// every same-origin context, a page's own included.
void main() {
  late ControllableLifecycleMonitor lifecycleA;
  late ControllableLifecycleMonitor lifecycleB;
  late WebPresentationCoordinator tabA;
  late WebPresentationCoordinator tabB;

  setUp(() {
    lifecycleA = ControllableLifecycleMonitor(
      currentState: BrokerAppLifecycleState.hidden,
    );
    lifecycleB = ControllableLifecycleMonitor(
      currentState: BrokerAppLifecycleState.hidden,
    );
    tabA = WebPresentationCoordinator(lifecycleA, windowToken: 'tab-a');
    tabB = WebPresentationCoordinator(lifecycleB, windowToken: 'tab-b');
  });

  tearDown(() {
    tabA.dispose();
    tabB.dispose();
    lifecycleA.dispose();
    lifecycleB.dispose();
  });

  /// Lock grants and releases settle asynchronously.
  Future<bool> eventually(Future<bool> Function() probe) async {
    for (var attempt = 0; attempt < 50; attempt++) {
      if (await probe()) return true;
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    return false;
  }

  test('a resumed tab is the foreground for the others only', () async {
    expect(await tabB.anotherWindowInForeground(), isFalse);

    lifecycleA.emit(BrokerAppLifecycleState.resumed);

    expect(await eventually(tabB.anotherWindowInForeground), isTrue);
    expect(await tabA.anotherWindowInForeground(), isFalse);

    lifecycleA.emit(BrokerAppLifecycleState.inactive);

    expect(
      await eventually(() async => !await tabB.anotherWindowInForeground()),
      isTrue,
    );
  });

  test('dispose gives up the foreground', () async {
    lifecycleA.emit(BrokerAppLifecycleState.resumed);
    expect(await eventually(tabB.anotherWindowInForeground), isTrue);

    tabA.dispose();

    expect(
      await eventually(() async => !await tabB.anotherWindowInForeground()),
      isTrue,
    );
  });

  test('presentation for one source runs in one tab at a time', () async {
    final log = <String>[];
    final release = Completer<void>();

    final first = tabA.exclusive('source-1', () async {
      log.add('a enters');
      await release.future;
      log.add('a leaves');
    });
    await eventually(() async => log.isNotEmpty);
    final second = tabB.exclusive('source-1', () async => log.add('b enters'));
    final other = tabB.exclusive('source-2', () async => log.add('b other'));

    await other;
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(log, ['a enters', 'b other']);

    release.complete();
    await Future.wait([first, second]);

    expect(log, ['a enters', 'b other', 'a leaves', 'b enters']);
  });

  test('a failure inside the section surfaces and frees the lock', () async {
    await expectLater(
      tabA.exclusive('source-1', () async => throw StateError('boom')),
      throwsA(isA<StateError>()),
    );

    var ran = false;
    await tabB.exclusive('source-1', () async => ran = true);

    expect(ran, isTrue);
  });
}
