import 'package:cosyncing_client/src/features/sessions/transcript/transcript_prefetch.dart';
import 'package:flutter_test/flutter_test.dart';

const TranscriptPrefetchDirection _older = TranscriptPrefetchDirection.older;
const TranscriptPrefetchDirection _newer = TranscriptPrefetchDirection.newer;
const _viewport = 800.0;

Duration _ms(int value) => Duration(milliseconds: value);

/// A controller whose reader is moving toward [direction] by hand.
TranscriptPrefetchController _moving(
  TranscriptPrefetchDirection direction, {
  TranscriptPrefetchPolicy policy = const TranscriptPrefetchPolicy(),
}) {
  return TranscriptPrefetchController(policy: policy)
    ..startGeneration('g1')
    ..recordMovement(direction: direction, physical: true);
}

TranscriptPrefetchDecision _decide(
  TranscriptPrefetchController controller, {
  TranscriptPrefetchDirection direction = _older,
  String key = 'older:a',
  double distance = 0,
  double velocity = 0,
  Duration now = Duration.zero,
}) => controller.decide(
  direction: direction,
  key: key,
  distance: distance,
  velocity: velocity,
  viewport: _viewport,
  now: now,
);

/// Completes one request of [key] toward [direction] that took [latency].
void _roundTrip(
  TranscriptPrefetchController controller, {
  required Duration start,
  required Duration latency,
  String key = 'older:a',
  TranscriptPrefetchDirection direction = _older,
}) {
  controller
    ..begin(key: key, direction: direction)
    ..markSent(start)
    ..finish(start + latency, applied: true);
}

void main() {
  group('prefetch distance', () {
    test("grows with the reader's speed between the bounds", () {
      final controller = TranscriptPrefetchController();
      // 250 ms assumed latency, half a viewport of margin.
      expect(
        controller.prefetchDistance(velocity: 0, viewport: _viewport),
        _viewport,
        reason: 'a slow reader gets the minimum, one viewport',
      );
      expect(
        controller.prefetchDistance(velocity: 4000, viewport: _viewport),
        4000 * 0.25 + 400,
      );
      expect(
        controller.prefetchDistance(velocity: -4000, viewport: _viewport),
        4000 * 0.25 + 400,
        reason: 'speed, not direction',
      );
      expect(
        controller.prefetchDistance(velocity: 40000, viewport: _viewport),
        3 * _viewport,
        reason: 'however fast, at most three viewports',
      );
      // The same boundary 1300 px away: too far for a slow reader, close
      // enough for a fast one.
      final reader = _moving(_older);
      expect(
        _decide(reader, distance: 1300, velocity: 600),
        TranscriptPrefetchDecision.tooFar,
      );
      expect(
        _decide(reader, distance: 1300, velocity: 4000),
        TranscriptPrefetchDecision.request,
      );
    });

    test('grows with the observed page latency', () {
      final fast = _moving(_older);
      final slow = _moving(_older);
      for (var i = 0; i < 12; i++) {
        for (final reader in [fast, slow]) {
          reader.recordMovement(direction: _older, physical: true);
        }
        _roundTrip(fast, start: _ms(i * 1000), latency: _ms(50));
        _roundTrip(slow, start: _ms(i * 1000), latency: _ms(900));
      }
      expect(fast.latency.inMilliseconds, closeTo(50, 1));
      expect(slow.latency.inMilliseconds, closeTo(900, 1));
      expect(
        slow.prefetchDistance(velocity: 2000, viewport: _viewport),
        greaterThan(fast.prefetchDistance(velocity: 2000, viewport: _viewport)),
      );
      expect(
        _decide(fast, distance: 1500, velocity: 2000),
        TranscriptPrefetchDecision.tooFar,
      );
      expect(
        _decide(slow, distance: 1500, velocity: 2000),
        TranscriptPrefetchDecision.request,
      );
    });

    test('averages latency, and bounds a single slow sample', () {
      final controller = _moving(_older);
      _roundTrip(controller, start: Duration.zero, latency: _ms(100));
      expect(
        controller.latency,
        _ms(100),
        reason: 'the first sample replaces the assumption',
      );
      _roundTrip(controller, start: _ms(1000), latency: _ms(200));
      expect(controller.latency, _ms(130), reason: '100 + 0.3 × (200 − 100)');
      _roundTrip(controller, start: _ms(2000), latency: _ms(60000));
      expect(
        controller.latency,
        _ms(130 + (0.3 * (3000 - 130)).round()),
        reason: 'a sample counts as at most three seconds',
      );
      expect(controller.latencySamples, 3);
    });

    test('learns nothing from a failure or an unsent request', () {
      final controller = _moving(_older)
        ..begin(key: 'older:a', direction: _older)
        ..markSent(Duration.zero)
        ..fail(_ms(5000), transient: true)
        ..begin(key: 'older:b', direction: _older)
        ..finish(_ms(9000), applied: true);
      expect(controller.latencySamples, 0);
      expect(controller.latency, _ms(250));
    });
  });

  group('one request at a time', () {
    test('never asks while a page is in flight, for any boundary', () {
      final controller = _moving(_older);
      expect(_decide(controller), TranscriptPrefetchDecision.request);
      controller.begin(key: 'older:a', direction: _older);
      expect(controller.inFlightKey, 'older:a');
      expect(_decide(controller), TranscriptPrefetchDecision.busy);
      expect(
        _decide(controller, key: 'gap:x'),
        TranscriptPrefetchDecision.busy,
      );
      controller
        ..recordMovement(direction: _older, physical: true)
        ..finish(_ms(100), applied: true);
      expect(controller.inFlightKey, isNull);
      expect(
        _decide(controller, key: 'older:b'),
        TranscriptPrefetchDecision.request,
      );
    });
  });

  group('generations', () {
    test('an answer to an earlier generation teaches nothing', () {
      final controller = _moving(_older)
        ..begin(key: 'older:a', direction: _older)
        ..markSent(Duration.zero)
        ..startGeneration('g2');
      expect(
        controller.inFlightKey,
        isNull,
        reason: 'the new generation has nothing in flight',
      );
      controller.recordMovement(direction: _older, physical: true);
      expect(_decide(controller), TranscriptPrefetchDecision.request);
      controller
        ..begin(key: 'older:b', direction: _older)
        // The old request's answer would finish whatever is in flight now;
        // finishing it records the current one, stamped with this
        // generation, and nothing from before.
        ..markSent(_ms(10))
        ..finish(_ms(60), applied: true);
      expect(controller.latency, _ms(50));
    });

    test('a failure recorded in one generation is forgotten by the next', () {
      final controller = _moving(_older)
        ..begin(key: 'older:a', direction: _older)
        ..fail(Duration.zero, transient: false);
      expect(_decide(controller), TranscriptPrefetchDecision.exhausted);
      controller
        ..startGeneration('g2')
        ..recordMovement(direction: _older, physical: true);
      expect(_decide(controller), TranscriptPrefetchDecision.request);
    });

    test('the same generation again changes nothing', () {
      final controller = _moving(_older)
        ..begin(key: 'older:a', direction: _older)
        ..startGeneration('g1');
      expect(controller.inFlightKey, 'older:a');
    });

    test('a request from before a new generation finishes nothing in it', () {
      final controller = _moving(_older)
        ..begin(key: 'older:a', direction: _older)
        ..markSent(Duration.zero)
        ..startGeneration('g2')
        // Its answer, or its failure, arrives after the new generation began.
        ..finish(_ms(10), applied: true)
        ..fail(_ms(10), transient: true);
      expect(controller.latencySamples, 0);
      expect(controller.nextRetryAt, isNull);
      expect(controller.generation, 'g2');
    });
  });

  group('settling', () {
    test('asks for nothing once the reader stops moving', () {
      final controller = _moving(_older);
      expect(_decide(controller), TranscriptPrefetchDecision.request);
      controller.settle();
      expect(controller.active, isFalse);
      expect(_decide(controller), TranscriptPrefetchDecision.settled);
      controller.recordMovement(direction: _older, physical: false);
      expect(_decide(controller), TranscriptPrefetchDecision.request);
    });

    test('asks only for the boundary the reader is heading toward', () {
      final controller = _moving(_older);
      expect(
        _decide(controller, direction: _newer, key: 'gap:below'),
        TranscriptPrefetchDecision.otherDirection,
      );
      controller.recordMovement(direction: _newer, physical: true);
      expect(_decide(controller), TranscriptPrefetchDecision.otherDirection);
      expect(
        _decide(controller, direction: _newer, key: 'gap:below'),
        TranscriptPrefetchDecision.request,
      );
    });
  });

  group('flings', () {
    test('a fling asks for a bounded number of pages', () {
      final controller = _moving(_older);
      var asked = 0;
      // The finger threw a fling at the first request; each page lands and
      // the fling carries on at speed.
      for (var page = 0; page < 10; page++) {
        controller.recordMovement(direction: _older, physical: page == 0);
        if (_decide(controller, key: 'older:$page', velocity: 9000) !=
            TranscriptPrefetchDecision.request) {
          break;
        }
        asked += 1;
        _roundTrip(
          controller,
          key: 'older:$page',
          start: _ms(page * 100),
          latency: _ms(50),
        );
      }
      // The first page under the finger, then two more for the fling.
      expect(asked, 3);
      expect(
        _decide(controller, key: 'older:x', velocity: 9000),
        TranscriptPrefetchDecision.flingLimit,
      );
      controller.recordMovement(direction: _older, physical: true);
      expect(
        _decide(controller, key: 'older:x', velocity: 9000),
        TranscriptPrefetchDecision.request,
        reason: 'touching the transcript again renews it',
      );
    });

    test('a fling thrown before any page counts from the finger leaving', () {
      final controller = _moving(_older)
        // The finger left before the boundary came into reach.
        ..recordMovement(direction: _older, physical: false);
      var asked = 0;
      for (var page = 0; page < 10; page++) {
        controller.recordMovement(direction: _older, physical: false);
        if (_decide(controller, key: 'older:$page', velocity: 9000) !=
            TranscriptPrefetchDecision.request) {
          break;
        }
        asked += 1;
        _roundTrip(
          controller,
          key: 'older:$page',
          start: _ms(page * 100),
          latency: _ms(50),
        );
      }
      expect(asked, 2);
    });

    test('pages landing under a reader holding still chain a bounded '
        'number', () {
      // One wheel tick: the page it asked for lands inside the prefetch
      // distance, and so do the next.
      final controller = _moving(_older);
      var asked = 0;
      for (var page = 0; page < 10; page++) {
        if (_decide(controller, key: 'older:$page') !=
            TranscriptPrefetchDecision.request) {
          break;
        }
        asked += 1;
        _roundTrip(
          controller,
          key: 'older:$page',
          start: _ms(page * 16),
          latency: _ms(8),
        );
      }
      expect(asked, 3, reason: "the tick's own page, then two chained");
    });

    test('hand movement is never limited', () {
      final controller = _moving(_older);
      for (var page = 0; page < 10; page++) {
        controller.recordMovement(direction: _older, physical: true);
        expect(
          _decide(controller, key: 'older:$page', velocity: 3000),
          TranscriptPrefetchDecision.request,
        );
        _roundTrip(
          controller,
          key: 'older:$page',
          start: _ms(page * 100),
          latency: _ms(50),
        );
      }
    });
  });

  group('fling retries', () {
    test('a failed page is asked for again past the fling limit', () {
      final controller = _moving(_older);
      _roundTrip(
        controller,
        key: 'older:0',
        start: Duration.zero,
        latency: _ms(50),
      );
      controller
        ..recordMovement(direction: _older, physical: false)
        ..begin(key: 'older:1', direction: _older)
        ..fail(_ms(100), transient: true);
      _roundTrip(controller, key: 'older:x', start: _ms(200), latency: _ms(50));
      expect(
        _decide(controller, key: 'older:y', velocity: 9000, now: _ms(300)),
        TranscriptPrefetchDecision.flingLimit,
      );
      final retryAt = controller.nextRetryAt!;
      expect(
        _decide(controller, key: 'older:1', velocity: 9000, now: retryAt),
        TranscriptPrefetchDecision.request,
      );
      controller
        ..begin(key: 'older:1', direction: _older)
        ..finish(retryAt + _ms(50), applied: true)
        ..recordMovement(direction: _older, physical: false);
      expect(
        _decide(controller, key: 'older:y', velocity: 9000, now: retryAt),
        TranscriptPrefetchDecision.flingLimit,
        reason: 'the retry spent none of the fling',
      );
    });
  });

  group('turning around', () {
    test('waits until the reader has moved half a viewport back', () {
      final controller = _moving(_older)..observeOffset(1000);
      _roundTrip(controller, start: Duration.zero, latency: _ms(50));
      // Further up after the page, then back down toward a released range.
      controller
        ..observeOffset(900)
        ..recordMovement(direction: _newer, physical: true)
        ..observeOffset(1200);
      expect(
        _decide(controller, direction: _newer, key: 'gap:below'),
        TranscriptPrefetchDecision.reversing,
        reason: '300 px back from the turning point, under 400',
      );
      controller.observeOffset(1310);
      expect(
        _decide(controller, direction: _newer, key: 'gap:below'),
        TranscriptPrefetchDecision.request,
      );
      _roundTrip(
        controller,
        key: 'gap:below',
        direction: _newer,
        start: _ms(100),
        latency: _ms(50),
      );
      // And the same the other way.
      controller
        ..observeOffset(1350)
        ..recordMovement(direction: _older, physical: true)
        ..observeOffset(1100);
      expect(
        _decide(controller, key: 'older:b'),
        TranscriptPrefetchDecision.reversing,
      );
      controller.observeOffset(940);
      expect(
        _decide(controller, key: 'older:b'),
        TranscriptPrefetchDecision.request,
      );
    });

    test('carrying on the same way is never held back', () {
      final controller = _moving(_older)..observeOffset(1000);
      _roundTrip(controller, start: Duration.zero, latency: _ms(50));
      controller
        ..recordMovement(direction: _older, physical: true)
        ..observeOffset(990);
      expect(
        _decide(controller, key: 'older:b'),
        TranscriptPrefetchDecision.request,
      );
    });
  });

  group('failures', () {
    test('retries a transient failure after a doubling, capped backoff', () {
      final controller = _moving(_older);
      final waits = <Duration>[];
      var now = Duration.zero;
      for (var attempt = 0; attempt < 4; attempt++) {
        controller
          ..begin(key: 'older:a', direction: _older)
          ..fail(now, transient: true);
        final retryAt = controller.nextRetryAt!;
        waits.add(retryAt - now);
        expect(
          _decide(controller, now: retryAt - _ms(1)),
          TranscriptPrefetchDecision.backingOff,
        );
        expect(
          _decide(controller, now: retryAt),
          TranscriptPrefetchDecision.request,
        );
        now = retryAt;
      }
      expect(waits, [_ms(500), _ms(1000), _ms(2000), _ms(4000)]);
      // One more failure exceeds the retry limit: only an explicit retry
      // remains.
      controller
        ..begin(key: 'older:a', direction: _older)
        ..fail(now, transient: true);
      expect(controller.nextRetryAt, isNull);
      expect(
        _decide(controller, now: now + const Duration(minutes: 1)),
        TranscriptPrefetchDecision.exhausted,
      );
      controller.forgetFailure('older:a');
      expect(_decide(controller, now: now), TranscriptPrefetchDecision.request);
    });

    test('caps the backoff', () {
      final controller = _moving(
        _older,
        policy: const TranscriptPrefetchPolicy(retryLimit: 10),
      );
      var now = Duration.zero;
      Duration? last;
      for (var attempt = 0; attempt < 8; attempt++) {
        controller
          ..begin(key: 'older:a', direction: _older)
          ..fail(now, transient: true);
        last = controller.nextRetryAt! - now;
        now = controller.nextRetryAt!;
      }
      expect(last, const Duration(seconds: 8));
    });

    test('never retries a failure that cannot pass', () {
      final controller = _moving(_older)
        ..begin(key: 'older:a', direction: _older)
        ..fail(Duration.zero, transient: false);
      expect(controller.nextRetryAt, isNull);
      expect(
        _decide(controller, now: const Duration(hours: 1)),
        TranscriptPrefetchDecision.exhausted,
      );
      expect(
        _decide(controller, key: 'older:b'),
        TranscriptPrefetchDecision.request,
        reason: 'another boundary is unaffected',
      );
    });

    test('retries for a reader still at the boundary, however still', () {
      final controller = _moving(_older)
        ..begin(key: 'older:a', direction: _older)
        ..fail(Duration.zero, transient: true)
        ..settle();
      final retryAt = controller.nextRetryAt!;
      expect(
        _decide(controller, now: retryAt, distance: 100),
        TranscriptPrefetchDecision.request,
      );
      expect(
        _decide(controller, now: retryAt, distance: 2000, velocity: 9000),
        TranscriptPrefetchDecision.settled,
        reason: 'a reader who has moved away is not waiting on it',
      );
    });

    test("a success clears the boundary's failures", () {
      final controller = _moving(_older)
        ..begin(key: 'older:a', direction: _older)
        ..fail(Duration.zero, transient: true);
      final retryAt = controller.nextRetryAt!;
      controller
        ..begin(key: 'older:a', direction: _older)
        ..markSent(retryAt)
        ..finish(retryAt + _ms(80), applied: true);
      expect(controller.nextRetryAt, isNull);
      controller
        ..begin(key: 'older:a', direction: _older)
        ..fail(retryAt + _ms(200), transient: true);
      expect(
        controller.nextRetryAt! - (retryAt + _ms(200)),
        _ms(500),
        reason: 'the count started over',
      );
    });

    test('wakes only for a backoff still running; one that has passed is due '
        'until the boundary is asked for or given up', () {
      final controller = _moving(_older)
        ..begin(key: 'older:a', direction: _older)
        ..fail(Duration.zero, transient: true)
        ..begin(key: 'older:b', direction: _older)
        ..fail(_ms(300), transient: true);
      expect(controller.nextRetryAfter(Duration.zero), _ms(500));
      expect(controller.retryDue(Duration.zero), isFalse);
      // `a`'s backoff has passed with the reader away: nothing is worth
      // waking for but `b`'s.
      expect(controller.nextRetryAfter(_ms(500)), _ms(800));
      expect(controller.retryDue(_ms(500)), isTrue);
      expect(controller.nextRetryAfter(_ms(800)), isNull);
      expect(controller.retryDue(const Duration(hours: 1)), isTrue);
      // What has passed is still asked for once the reader is there.
      expect(
        _decide(controller, now: const Duration(hours: 1)),
        TranscriptPrefetchDecision.request,
      );
      controller
        ..forgetFailure('older:a')
        ..forgetFailure('older:b');
      expect(controller.retryDue(const Duration(hours: 1)), isFalse);
      // A failure that cannot pass, or one past the retry limit, is never
      // due.
      controller
        ..begin(key: 'older:c', direction: _older)
        ..fail(Duration.zero, transient: false);
      for (
        var attempt = 0;
        attempt <= controller.policy.retryLimit;
        attempt++
      ) {
        controller
          ..begin(key: 'older:d', direction: _older)
          ..fail(Duration.zero, transient: true);
      }
      expect(controller.nextRetryAfter(Duration.zero), isNull);
      expect(controller.retryDue(const Duration(hours: 1)), isFalse);
    });
  });
}
