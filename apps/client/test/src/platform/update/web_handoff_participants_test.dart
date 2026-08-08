import 'dart:async';

import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

/// A surface whose editability the registry can actually observe.
///
/// `frozen` is what makes the two-phase commit testable: a participant that
/// says it locked but keeps accepting edits would satisfy a boolean-only
/// contract while losing exactly the text the commit exists to save.
class _FakeSurface {
  _FakeSurface({this.durable = true, this.refuseLock = false});

  /// Mid-sentence: set by the tests that simulate typing after phase one.
  bool busy = false;
  bool durable;
  bool refuseLock;
  bool frozen = false;
  int flushes = 0;
  int locks = 0;
  int releases = 0;

  /// Holds the durable write open, the way a slow repository would.
  Completer<bool>? gate;

  WebHandoffParticipant get participant => WebHandoffParticipant(
    isBusy: () => busy,
    flush: () async {
      flushes += 1;
      final held = gate;
      if (held != null) return held.future;
      return durable;
    },
    lock: () {
      locks += 1;
      if (busy || refuseLock) return false;
      frozen = true;
      return true;
    },
    release: () {
      releases += 1;
      frozen = false;
    },
  );
}

WebHandoffParticipant _participant({
  bool busy = false,
  bool durable = true,
  void Function()? onFlush,
}) {
  return WebHandoffParticipant(
    isBusy: () => busy,
    flush: () async {
      onFlush?.call();
      return durable;
    },
    lock: () => !busy,
    release: () {},
  );
}

void main() {
  final registry = WebHandoffParticipants.instance;

  setUp(() {
    WebHandoffParticipants.installHook = null;
    registry.reset();
  });

  tearDown(() {
    WebHandoffParticipants.installHook = null;
    registry.reset();
  });

  group('WebHandoffParticipants', () {
    test(
      'an empty registry is safe to move without flushing anything',
      () async {
        expect(await registry.prepare(), isTrue);
      },
    );

    // The coordinator reads an absent hook as "this tab owns nothing durable"
    // and moves immediately, so the hook's presence must track the registry
    // exactly: installed on the first participant, removed with the last.
    test('the browser hook exists exactly while a participant does', () {
      final installed = <bool>[];
      WebHandoffParticipants.installHook = (registry) =>
          installed.add(registry != null);

      final releaseFirst = registry.register(_participant());
      final releaseSecond = registry.register(_participant());
      expect(installed, [true], reason: 'installed once, on the first');

      releaseFirst();
      expect(installed, [true], reason: 'one participant remains');

      releaseSecond();
      expect(installed, [true, false]);
    });

    test('releasing twice is a no-op rather than a double removal', () {
      final release = registry.register(_participant());
      final other = registry.register(_participant());
      release();
      release();
      expect(registry.participantCount, 1);
      other();
      expect(registry.participantCount, 0);
    });

    test(
      'one actively editing surface defers, and nothing is flushed',
      () async {
        var flushes = 0;
        registry
          ..register(_participant(onFlush: () => flushes++))
          ..register(_participant(busy: true, onFlush: () => flushes++));

        expect(await registry.prepare(), isFalse);
        expect(flushes, 0, reason: 'a deferred tab is not going anywhere');
      },
    );

    test('a flush that did not land defers the handoff', () async {
      registry
        ..register(_participant())
        ..register(_participant(durable: false));

      expect(await registry.prepare(), isFalse);
    });

    // Abandoning the other flushes on the first failure would leave in-flight
    // writes racing a navigation that destroys the document.
    test('every flush completes even after one fails', () async {
      var flushed = 0;
      registry
        ..register(_participant(durable: false, onFlush: () => flushed++))
        ..register(_participant(onFlush: () => flushed++))
        ..register(_participant(onFlush: () => flushed++));

      expect(await registry.prepare(), isFalse);
      expect(flushed, 3);
    });

    test('a throwing participant defers instead of propagating', () async {
      registry.register(
        WebHandoffParticipant(
          isBusy: () => throw StateError('disposed'),
          flush: () async => true,
          lock: () => true,
          release: () {},
        ),
      );
      expect(await registry.prepare(), isFalse);

      registry
        ..reset()
        ..register(
          WebHandoffParticipant(
            isBusy: () => false,
            flush: () async => throw StateError('storage gone'),
            lock: () => true,
            release: () {},
          ),
        );
      expect(await registry.prepare(), isFalse);
    });

    // A surface whose durable write never settles must not hold the tab: the
    // browser coordinator has its own bound, but one stuck participant would
    // otherwise consume the entire budget and make every sibling look slow.
    test(
      'a flush that never settles is a deferral, not a hang',
      () async {
        final stuck = Completer<bool>();
        addTearDown(() {
          if (!stuck.isCompleted) stuck.complete(false);
        });
        registry.register(
          WebHandoffParticipant(
            isBusy: () => false,
            flush: () => stuck.future,
            lock: () => true,
            release: () {},
          ),
        );

        expect(await registry.prepare(), isFalse);
      },
      timeout: const Timeout(Duration(seconds: 30)),
    );

    // Phase two exists because phase one's answer goes stale. Seconds pass
    // between a tab acknowledging and being told to go, and the composer stays
    // editable throughout, so the commit has to freeze first and flush second.
    test('commit freezes every surface before it flushes anything', () async {
      final first = _FakeSurface();
      final second = _FakeSurface();
      registry
        ..register(first.participant)
        ..register(second.participant);

      expect(await registry.commit(), isTrue);
      expect(first.frozen, isTrue);
      expect(second.frozen, isTrue);
      expect(first.flushes, 1);
      expect(second.flushes, 1);
      expect(registry.lockedCount, 2);
    });

    test('a surface that refuses to freeze aborts the commit', () async {
      final willing = _FakeSurface();
      final refusing = _FakeSurface(refuseLock: true);
      registry
        ..register(willing.participant)
        ..register(refusing.participant);

      expect(await registry.commit(), isFalse);
      expect(
        willing.frozen,
        isFalse,
        reason: 'a peer that already froze must be let go again',
      );
      expect(willing.releases, 1);
      expect(registry.lockedCount, 0);
      expect(
        willing.flushes,
        0,
        reason: 'nothing is persisted for a round that is not happening',
      );
    });

    // A tab left frozen is a composer that silently refuses to type. The
    // coordinator abandons rounds for reasons this tab never learns about, so
    // release must always be able to undo a freeze.
    test('releaseAll unfreezes every surface and is idempotent', () async {
      final surface = _FakeSurface();
      registry.register(surface.participant);
      expect(await registry.commit(), isTrue);
      expect(surface.frozen, isTrue);

      registry
        ..releaseAll()
        ..releaseAll();
      expect(surface.frozen, isFalse);
      expect(surface.releases, 1, reason: 'a second release has nothing to do');
      expect(registry.lockedCount, 0);
    });

    test(
      'a commit whose flush did not land unfreezes rather than moving',
      () async {
        final surface = _FakeSurface(durable: false);
        registry.register(surface.participant);

        expect(await registry.commit(), isFalse);
        expect(surface.frozen, isFalse);
        expect(registry.lockedCount, 0);
      },
    );

    // The window this closes: the freeze lands synchronously but the durable
    // write takes as long as it takes, and the round can be abandoned in
    // between. A commit that reported success afterwards would hand back a tab
    // that believes it is frozen and safe to move for a round nobody is running
    // — and a surface frozen with nobody left to unfreeze it.
    test(
      'a release during an in-flight flush unfreezes and refuses the commit',
      () async {
        final surface = _FakeSurface();
        final gate = Completer<bool>();
        surface.gate = gate;
        registry.register(surface.participant);

        final pending = registry.commit();
        expect(surface.frozen, isTrue, reason: 'the freeze is synchronous');
        expect(registry.lockedCount, 1);

        // The coordinator gives up while the write is still in flight.
        registry.releaseAll();
        expect(surface.frozen, isFalse, reason: 'the surface types again');
        expect(registry.lockedCount, 0);

        gate.complete(true);
        expect(
          await pending,
          isFalse,
          reason: 'a cancelled commit may not report the tab movable',
        );
        expect(
          surface.frozen,
          isFalse,
          reason: 'and the late flush re-froze nothing on its way out',
        );
        expect(registry.lockedCount, 0);

        // And the tab is not poisoned: the next round commits normally.
        surface.gate = null;
        expect(await registry.commit(), isTrue);
        expect(surface.frozen, isTrue);
      },
    );

    // Central review round 3: individual participants can only vouch for the
    // snapshot the commit took, and the tab then waits seconds for `go`. The
    // registry-level flag is what the app shell watches to refuse every
    // keystroke in that window (see WebHandoffFreeze) — including into fields
    // that were verified empty and editors that were never in the snapshot.
    test(
      'commit raises the tab-wide input lock for the whole window',
      () async {
        final surface = _FakeSurface();
        registry.register(surface.participant);
        expect(registry.frozen.value, isFalse);

        final pending = registry.commit();
        expect(
          registry.frozen.value,
          isTrue,
          reason: 'raised synchronously, before the first await',
        );
        expect(await pending, isTrue);
        expect(
          registry.frozen.value,
          isTrue,
          reason: 'held until go destroys the document or release undoes it',
        );

        registry.releaseAll();
        expect(registry.frozen.value, isFalse);
      },
    );

    test('a refused or cancelled commit drops the tab-wide lock', () async {
      final refusing = _FakeSurface(refuseLock: true);
      final release = registry.register(refusing.participant);
      expect(await registry.commit(), isFalse);
      expect(registry.frozen.value, isFalse);
      release();

      final surface = _FakeSurface();
      final gate = Completer<bool>();
      surface.gate = gate;
      registry.register(surface.participant);
      final pending = registry.commit();
      expect(registry.frozen.value, isTrue);
      registry.releaseAll();
      expect(
        registry.frozen.value,
        isFalse,
        reason: 'the abandoned round must hand the whole tab back',
      );
      gate.complete(true);
      expect(await pending, isFalse);
      expect(registry.frozen.value, isFalse);
    });

    test('holdOpen defers for exactly as long as the body runs', () async {
      var hints = 0;
      WebHandoffParticipants.readinessHook = () => hints++;
      addTearDown(() => WebHandoffParticipants.readinessHook = null);

      final closing = Completer<String>();
      final pending = registry.holdOpen(() => closing.future);
      expect(
        await registry.prepare(),
        isFalse,
        reason: 'an open modal defers regardless of its content',
      );
      expect(await registry.commit(), isFalse);

      closing.complete('saved');
      expect(await pending, 'saved');
      expect(registry.participantCount, 0);
      expect(hints, 1, reason: 'closing the dialog announces readiness');
      expect(await registry.prepare(), isTrue);
    });

    test(
      'a surface that became busy since phase one refuses the commit',
      () async {
        final surface = _FakeSurface();
        registry.register(surface.participant);
        expect(await registry.prepare(), isTrue);

        // The user starts typing in the acknowledgement window.
        surface.busy = true;

        expect(await registry.commit(), isFalse);
        expect(surface.frozen, isFalse);
      },
    );

    test('a held editor defers and never freezes', () async {
      registry.hold();
      expect(await registry.prepare(), isFalse);
      expect(await registry.commit(), isFalse);
      expect(registry.lockedCount, 0);
    });

    test('a conditional hold defers only while it has content', () async {
      var text = '';
      registry.holdWhile(() => text.isNotEmpty);
      expect(
        await registry.prepare(),
        isTrue,
        reason: 'an empty field is free',
      );
      expect(await registry.commit(), isTrue);

      registry.releaseAll();
      text = 'a token nobody saved';
      expect(await registry.prepare(), isFalse);
      expect(await registry.commit(), isFalse);
    });

    // An editor the registry cannot track is exactly an editor whose contents a
    // handoff would discard, so overflowing has to fail closed.
    test('an overflowed registry refuses to move at all', () async {
      for (
        var index = 0;
        index < WebHandoffParticipants.maxParticipants;
        index++
      ) {
        registry.register(_participant());
      }
      expect(await registry.prepare(), isTrue);

      registry.register(_participant());
      expect(await registry.prepare(), isFalse);
      expect(await registry.commit(), isFalse);
    });

    test('closing an editor announces that this tab may be movable', () {
      var hints = 0;
      WebHandoffParticipants.readinessHook = () => hints++;
      addTearDown(() => WebHandoffParticipants.readinessHook = null);

      final release = registry.register(_participant());
      expect(hints, 0, reason: 'opening an editor is not a readiness change');
      release();
      expect(hints, 1);

      registry.notifyReadinessChanged();
      expect(hints, 2);
    });

    test('registration is refused past the ceiling with a safe disposer', () {
      final releases = <VoidCallback>[];
      const ceiling = WebHandoffParticipants.maxParticipants;
      for (var index = 0; index < ceiling; index++) {
        releases.add(registry.register(_participant()));
      }
      expect(
        registry.participantCount,
        WebHandoffParticipants.maxParticipants,
      );

      final refused = registry.register(_participant());
      expect(
        registry.participantCount,
        WebHandoffParticipants.maxParticipants,
        reason: 'the fan-out stays bounded',
      );
      refused();
      expect(
        registry.participantCount,
        WebHandoffParticipants.maxParticipants,
        reason: 'a refused registration disposes nobody else',
      );
      for (final release in releases) {
        release();
      }
      expect(registry.participantCount, 0);
    });
  });
}
