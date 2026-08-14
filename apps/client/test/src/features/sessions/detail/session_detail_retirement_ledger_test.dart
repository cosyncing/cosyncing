import 'dart:async';

import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _settle() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.value();
  }
}

void main() {
  const key = SessionDetailKey(tool: 'claude', sessionId: 'a');
  const otherKey = SessionDetailKey(tool: 'codex', sessionId: 'b');

  test('a pending retirement holds the key and completion frees it', () async {
    final ledger = SessionDetailRetirementLedger();
    final retirement = Completer<void>();

    unawaited(ledger.register(key, retirement.future));
    expect(ledger.pendingFor(key), isNotNull);
    expect(ledger.pendingFor(otherKey), isNull);

    retirement.complete();
    await _settle();
    expect(ledger.pendingFor(key), isNull);
  });

  test('overlapping retirements completing in reverse order keep the key '
      'held until the earliest one settles', () async {
    final ledger = SessionDetailRetirementLedger();
    final first = Completer<void>();
    final second = Completer<void>();

    unawaited(ledger.register(key, first.future));
    unawaited(ledger.register(key, second.future));

    // The LATER retirement settles first. The earlier one can still
    // invalidate the session's provider, so the key must stay held.
    second.complete();
    await _settle();
    expect(
      ledger.pendingFor(key),
      isNotNull,
      reason:
          'freeing on the later retirement alone would let an adopter '
          'attach a controller the earlier retirement is about to invalidate',
    );

    first.complete();
    await _settle();
    expect(ledger.pendingFor(key), isNull);
  });

  test('the settled future completes only after the key is freed', () async {
    final ledger = SessionDetailRetirementLedger();
    final retirement = Completer<void>();

    var freeAtCompletion = false;
    unawaited(
      ledger.register(key, retirement.future).whenComplete(() {
        freeAtCompletion = ledger.pendingFor(key) == null;
      }),
    );

    retirement.complete();
    await _settle();
    expect(
      freeAtCompletion,
      isTrue,
      reason:
          'a completion-triggered reconcile must already see the key '
          'as free',
    );
  });

  test('a retirement that fails its own teardown still frees the key '
      'without surfacing the error', () async {
    final ledger = SessionDetailRetirementLedger();
    final retirement = Completer<void>();

    final settled = ledger.register(key, retirement.future);
    retirement.completeError(StateError('teardown failed'));
    await settled;
    expect(ledger.pendingFor(key), isNull);
  });
}
