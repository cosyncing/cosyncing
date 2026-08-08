import 'dart:async';

import 'package:cosyncing_client/src/features/attention/controller/attention_profile_sync_gate.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('serializes operations for one profile in arrival order', () async {
    final gate = AttentionProfileSyncGate();
    final firstMayFinish = Completer<void>();
    final trace = <String>[];

    final first = gate.run('profile-a', () async {
      trace.add('first-start');
      await firstMayFinish.future;
      trace.add('first-end');
    });
    final second = gate.run('profile-a', () async {
      trace
        ..add('second-start')
        ..add('second-end');
    });

    await Future<void>.delayed(Duration.zero);
    expect(trace, ['first-start']);
    firstMayFinish.complete();
    await Future.wait([first, second]);
    expect(trace, [
      'first-start',
      'first-end',
      'second-start',
      'second-end',
    ]);
  });

  test('does not serialize independent broker profiles', () async {
    final gate = AttentionProfileSyncGate();
    final profileAMayFinish = Completer<void>();
    var profileBStarted = false;

    final profileA = gate.run('profile-a', () async {
      await profileAMayFinish.future;
    });
    final profileB = gate.run('profile-b', () async {
      profileBStarted = true;
    });

    await profileB;
    expect(profileBStarted, isTrue);
    profileAMayFinish.complete();
    await profileA;
  });
}
