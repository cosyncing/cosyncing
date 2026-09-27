/// When the transcript asks for the next history page.
///
/// The transcript holds a bounded window of history around the reader, with a
/// boundary on each side where more can be loaded: the start of what is
/// loaded, and released ranges above or below the reader. This decides, from
/// how the reader is actually moving, when to ask for the page beyond the
/// boundary they are heading for, so it arrives before they reach it and not
/// long before.
///
/// A page is asked for when the reader is moving toward a boundary that is
/// closer than the distance they will cover while a page is on its way:
///
///     prefetchDistance =
///         clamp(|velocity| × latency + margin, minimum, maximum)
///
/// where latency is an average of how long this session's pages have taken
/// to arrive. Only the reader's own movement counts (a drag, the fling it
/// throws, a wheel, a trackpad, a key); a layout correction, a jump or a page
/// landing never does. The distance is in the transcript's own layout, which
/// is not the widget cache extent: the rows laid out ahead of the viewport are
/// a rendering matter, and this is a data one.
///
/// Around that rule:
///
/// - One page is in flight at a time, and the same boundary is never asked for
///   twice while it is.
/// - Once the reader's movement settles, nothing more is asked for: a page
///   already on its way lands, and the next one waits for the reader to move
///   again. Without the reader's hand behind it — a fling that has left the
///   finger, or pages landing while the reader holds still — at most
///   [TranscriptPrefetchPolicy.flingPages] new pages are asked for before the
///   reader moves the transcript again, whatever the speed.
/// - After a page in one direction, a page in the other waits until the
///   reader has moved [TranscriptPrefetchPolicy.reversalViewports] back, so
///   turning around at a boundary cannot ping-pong between loading one side
///   and releasing the other.
/// - A page that failed for a reason that can pass is asked for again after a
///   backoff that doubles up to [TranscriptPrefetchPolicy.retryCap], at most
///   [TranscriptPrefetchPolicy.retryLimit] times, and only while the reader is
///   still at that boundary. A reader who has left it is not waited on: the
///   retry is made when their movement, or a change in the transcript, next
///   finds them there. A refusal that cannot pass is never retried here.
/// - Everything is tied to one generation (a session, source, connection and
///   transcript replacement). Starting a new one forgets what was in flight
///   and what failed, so an answer to an old request teaches nothing.
library;

import 'dart:math' as math;

import 'package:flutter/foundation.dart';

/// Which way a page extends the transcript from the reader.
enum TranscriptPrefetchDirection {
  /// Earlier rows, above the reader.
  older,

  /// Newer rows, below the reader.
  newer,
}

/// The bounds [TranscriptPrefetchController] works within.
@immutable
final class TranscriptPrefetchPolicy {
  /// Creates a policy.
  const TranscriptPrefetchPolicy({
    this.minimumViewports = 1,
    this.maximumViewports = 3,
    this.marginViewports = 0.5,
    this.initialLatency = const Duration(milliseconds: 250),
    this.latencyWeight = 0.3,
    this.maximumLatency = const Duration(seconds: 3),
    this.settleDelay = const Duration(milliseconds: 250),
    this.reversalViewports = 0.5,
    this.flingPages = 2,
    this.retryBase = const Duration(milliseconds: 500),
    this.retryCap = const Duration(seconds: 8),
    this.retryLimit = 4,
  });

  /// The shortest prefetch distance, in viewports: a boundary this close is
  /// asked for as soon as the reader moves toward it, however slowly.
  final double minimumViewports;

  /// The longest prefetch distance, in viewports, however fast the reader
  /// moves and however slow pages are.
  final double maximumViewports;

  /// Added to the distance covered while a page is on its way, in viewports:
  /// the time to apply and paint it, and a reader who speeds up.
  final double marginViewports;

  /// The page latency assumed before any page has arrived.
  final Duration initialLatency;

  /// The weight a new latency sample gets in the running average.
  final double latencyWeight;

  /// The longest latency a sample counts as.
  final Duration maximumLatency;

  /// How long after the reader's last movement their scrolling counts as
  /// settled.
  final Duration settleDelay;

  /// How far, in viewports, the reader moves back after a page in one
  /// direction before a page in the other is asked for.
  final double reversalViewports;

  /// The most pages asked for without the reader's hand behind them: after
  /// a fling leaves the finger, or after a page lands under a reader holding
  /// still.
  final int flingPages;

  /// The first retry backoff; each further failure doubles it.
  final Duration retryBase;

  /// The longest retry backoff.
  final Duration retryCap;

  /// Automatic retries of one boundary before only an explicit retry remains.
  final int retryLimit;
}

/// Why [TranscriptPrefetchController.decide] did or did not ask for a page.
enum TranscriptPrefetchDecision {
  /// Ask for it now.
  request,

  /// A page is already in flight.
  busy,

  /// The reader is not moving toward this boundary.
  otherDirection,

  /// The reader's scrolling has settled.
  settled,

  /// The reader turned around and has not moved far enough back yet.
  reversing,

  /// The fling has asked for all the pages it may.
  flingLimit,

  /// The boundary is farther than the prefetch distance.
  tooFar,

  /// The boundary failed and its backoff has not passed.
  backingOff,

  /// The boundary failed too often, or for a reason that cannot pass.
  exhausted,
}

final class _Failure {
  _Failure({required this.attempts, required this.retryAt});

  final int attempts;
  final Duration? retryAt;
}

final class _InFlight {
  _InFlight({required this.key, required this.direction});

  final String key;
  final TranscriptPrefetchDirection direction;

  /// When the request was first seen on its way, or null until then.
  Duration? sentAt;
}

/// Decides when the transcript asks for a history page (see the library
/// documentation).
///
/// Pure bookkeeping: the caller reports the reader's movement, the offset,
/// and each request's life, passes the time explicitly, and asks [decide]
/// before every request it would make.
final class TranscriptPrefetchController {
  /// Creates a controller working within [policy].
  TranscriptPrefetchController({
    this.policy = const TranscriptPrefetchPolicy(),
  }) : _latencyMs = policy.initialLatency.inMicroseconds / 1000;

  /// The bounds this controller works within.
  final TranscriptPrefetchPolicy policy;

  Object? _generation;
  double _latencyMs;
  int _latencySamples = 0;

  bool _active = false;
  TranscriptPrefetchDirection? _moving;

  /// Whether the reader's hand has moved the transcript since the last
  /// request, and whether it is still what moves it (no fling carrying on).
  bool _physicalSinceRequest = true;
  bool _underHand = true;

  /// Requests made without the reader's hand behind them: pages chained
  /// after one landed, and pages a fling reached.
  int _flingRequests = 0;

  TranscriptPrefetchDirection? _lastRequestDirection;
  double? _offset;
  double? _extreme;

  _InFlight? _inFlight;
  final Map<String, _Failure> _failures = {};

  /// The running average page latency.
  Duration get latency => Duration(microseconds: (_latencyMs * 1000).round());

  /// How many latency samples the average holds.
  @visibleForTesting
  int get latencySamples => _latencySamples;

  /// Whether the reader's scrolling has not yet settled.
  bool get active => _active;

  /// The key of the request in flight, if any.
  String? get inFlightKey => _inFlight?.key;

  /// The direction of the request in flight, if any.
  TranscriptPrefetchDirection? get inFlightDirection => _inFlight?.direction;

  /// The generation the bookkeeping belongs to.
  Object? get generation => _generation;

  /// Starts [generation] if it is not the current one: forgets the request in
  /// flight, every failure, the reader's movement and the last direction, so
  /// an answer to a request from before teaches nothing and finishes
  /// nothing. Page latency is kept: it describes the broker, not the
  /// transcript.
  void startGeneration(Object? generation) {
    if (generation == _generation) return;
    _generation = generation;
    _inFlight = null;
    _failures.clear();
    _active = false;
    _moving = null;
    _physicalSinceRequest = true;
    _underHand = true;
    _flingRequests = 0;
    _lastRequestDirection = null;
    _offset = null;
    _extreme = null;
  }

  /// The distance, in logical pixels, at which a boundary is asked for when
  /// the reader moves at [velocity] pixels per second in a viewport
  /// [viewport] pixels tall.
  double prefetchDistance({
    required double velocity,
    required double viewport,
  }) {
    final lead = velocity.abs() * _latencyMs / 1000;
    final distance = lead + policy.marginViewports * viewport;
    return distance.clamp(
      policy.minimumViewports * viewport,
      policy.maximumViewports * viewport,
    );
  }

  /// Records the reader's own movement toward [direction]. [physical] is
  /// input under the reader's hand (a drag, wheel, trackpad or key), as
  /// opposed to a fling carrying on after the finger left.
  void recordMovement({
    required TranscriptPrefetchDirection direction,
    required bool physical,
  }) {
    _active = true;
    _moving = direction;
    _underHand = physical;
    if (physical) {
      _physicalSinceRequest = true;
      _flingRequests = 0;
    }
  }

  /// Whether the next request is the reader's own: their hand moved the
  /// transcript since the last one and still does.
  bool get _earned => _physicalSinceRequest && _underHand;

  /// Records that the reader's scrolling settled.
  void settle() => _active = false;

  /// Records the scroll offset, with every correction that moved nothing on
  /// screen taken out; larger is newer. Every change counts, the reader's own
  /// and a jump alike: turning around is measured in how far the view moved.
  void observeOffset(double offset) {
    _offset = offset;
    final extreme = _extreme;
    switch (_lastRequestDirection) {
      case TranscriptPrefetchDirection.older:
        if (extreme == null || offset < extreme) _extreme = offset;
      case TranscriptPrefetchDirection.newer:
        if (extreme == null || offset > extreme) _extreme = offset;
      case null:
        _extreme = null;
    }
  }

  /// Whether to ask now for the page behind the boundary keyed [key], which
  /// lies [distance] logical pixels beyond the viewport edge toward
  /// [direction] (zero or less when it is on screen), for a reader moving at
  /// [velocity] pixels per second in a viewport [viewport] pixels tall, at
  /// [now].
  TranscriptPrefetchDecision decide({
    required TranscriptPrefetchDirection direction,
    required String key,
    required double distance,
    required double velocity,
    required double viewport,
    required Duration now,
  }) {
    if (_inFlight != null) return TranscriptPrefetchDecision.busy;
    final failure = _failures[key];
    final retrying = failure != null;
    if (failure != null) {
      final retryAt = failure.retryAt;
      if (retryAt == null || failure.attempts > policy.retryLimit) {
        return TranscriptPrefetchDecision.exhausted;
      }
      if (now < retryAt) return TranscriptPrefetchDecision.backingOff;
    }
    if (_moving != direction) return TranscriptPrefetchDecision.otherDirection;
    // A retry is not speculation: the reader was at this boundary when it
    // failed, and is still within the shortest distance of it.
    final demanded = distance <= policy.minimumViewports * viewport;
    if (!_active && !(retrying && demanded)) {
      return TranscriptPrefetchDecision.settled;
    }
    if (_reversing(direction, viewport)) {
      return TranscriptPrefetchDecision.reversing;
    }
    if (!retrying && !_earned && _flingRequests >= policy.flingPages) {
      return TranscriptPrefetchDecision.flingLimit;
    }
    if (distance > prefetchDistance(velocity: velocity, viewport: viewport)) {
      return TranscriptPrefetchDecision.tooFar;
    }
    return TranscriptPrefetchDecision.request;
  }

  bool _reversing(TranscriptPrefetchDirection direction, double viewport) {
    final last = _lastRequestDirection;
    if (last == null || last == direction) return false;
    final offset = _offset;
    final extreme = _extreme;
    if (offset == null || extreme == null) return false;
    return (offset - extreme).abs() < policy.reversalViewports * viewport;
  }

  /// Records that the page behind [key] toward [direction] was asked for.
  void begin({
    required String key,
    required TranscriptPrefetchDirection direction,
  }) {
    _inFlight = _InFlight(key: key, direction: direction);
    // Asking again for a page that failed is no further than the fling
    // already reached.
    if (!_earned && !_failures.containsKey(key)) _flingRequests += 1;
    _physicalSinceRequest = false;
    if (_lastRequestDirection != direction) {
      _lastRequestDirection = direction;
      _extreme = _offset;
    }
  }

  /// Records when the request in flight was first seen on its way, which is
  /// where its latency is measured from.
  void markSent(Duration now) {
    _inFlight?.sentAt ??= now;
  }

  /// Records that the request in flight finished at [now]. An [applied]
  /// answer is a latency sample and clears the boundary's failures.
  void finish(Duration now, {required bool applied}) {
    final inFlight = _inFlight;
    if (inFlight == null) return;
    _inFlight = null;
    if (!applied) return;
    _failures.remove(inFlight.key);
    final sentAt = inFlight.sentAt;
    if (sentAt == null) return;
    final sample = math.min(
      (now - sentAt).inMicroseconds / 1000,
      policy.maximumLatency.inMicroseconds / 1000,
    );
    _latencyMs = _latencySamples == 0
        ? sample
        : _latencyMs + policy.latencyWeight * (sample - _latencyMs);
    _latencySamples += 1;
  }

  /// Records that the request in flight failed at [now]. A [transient]
  /// failure may be retried after a backoff; any other never is here.
  void fail(Duration now, {required bool transient}) {
    final inFlight = _inFlight;
    if (inFlight == null) return;
    _inFlight = null;
    final attempts = (_failures[inFlight.key]?.attempts ?? 0) + 1;
    if (!transient || attempts > policy.retryLimit) {
      _failures[inFlight.key] = _Failure(attempts: attempts, retryAt: null);
      return;
    }
    final backoff = policy.retryBase * math.pow(2, attempts - 1).toInt();
    final capped = backoff > policy.retryCap ? policy.retryCap : backoff;
    _failures[inFlight.key] = _Failure(
      attempts: attempts,
      retryAt: now + capped,
    );
  }

  /// Forgets that [key] failed, as an explicit retry of it does.
  void forgetFailure(String key) => _failures.remove(key);

  /// When the next automatic retry may be made, or null when none is due.
  Duration? get nextRetryAt {
    Duration? next;
    for (final failure in _failures.values) {
      final at = failure.retryAt;
      if (at == null) continue;
      if (next == null || at < next) next = at;
    }
    return next;
  }

  /// The earliest automatic retry whose backoff is still running at [now],
  /// or null when none is: the only one worth waking for. A retry whose
  /// backoff has passed ([retryDue]) waits for a decision that finds the
  /// reader at its boundary; waking again changes nothing until the reader
  /// or the transcript moves.
  Duration? nextRetryAfter(Duration now) {
    Duration? next;
    for (final failure in _failures.values) {
      final at = failure.retryAt;
      if (at == null || at <= now) continue;
      if (next == null || at < next) next = at;
    }
    return next;
  }

  /// Whether a boundary that failed may be asked for again at [now]: its
  /// backoff has passed and it has retries left.
  bool retryDue(Duration now) => _failures.values.any((failure) {
    final at = failure.retryAt;
    return at != null && at <= now;
  });
}
