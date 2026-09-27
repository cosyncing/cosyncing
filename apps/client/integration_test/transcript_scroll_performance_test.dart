// Transcript scrolling under load, measured in a profile build.
//
// The production session page and controller run over a broker fake that
// pages a long mixed history (see `test/support/transcript_scroll_fixture.dart`)
// with a chosen page latency, while the harness drags, flings and streams the
// way a reader does. It records the engine's frame timings, page
// request-to-paint latency, bytes paged, rows laid out, retained transcript
// bytes, heap after full collections, and the markdown and code work the rows
// did. It is a measurement, not a gate: run it through
// `scripts/client/measure-transcript-scroll.ts`, which writes the report under
// `output/scroll-analysis/`.
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/transcript_markdown.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/transcript_render_cache.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/support/session_detail_page_test_harness.dart';
import '../test/support/transcript_scroll_fixture.dart';
import 'support/scroll_measurement.dart';

const String _selected = String.fromEnvironment(
  'TRANSCRIPT_SCROLL_SCENARIOS',
  defaultValue: 'all',
);

/// Scales the long scenarios (memory curves) down for a quick check.
const int _scale = int.fromEnvironment(
  'TRANSCRIPT_SCROLL_SCALE',
  defaultValue: 1,
);

bool _wanted(String name) =>
    _selected == 'all' || _selected.split(',').contains(name);

Finder get _transcript => find.byKey(const Key('session-detail-chat-scroll'));

ScrollPosition _position(WidgetTester tester) {
  final scrollable = tester.widget<Scrollable>(
    find.descendant(of: _transcript, matching: find.byType(Scrollable)).first,
  );
  return scrollable.controller!.position;
}

SessionDetailState _state(WidgetTester tester) {
  final container = ProviderScope.containerOf(
    tester.element(find.byType(SessionDetailPage)),
  );
  return container.read(
    sessionDetailControllerProvider(
      const SessionDetailKey(tool: 'claude', sessionId: 'session-1'),
    ),
  );
}

/// Rows the transcript has laid out, on screen and in its cache extent.
int _activeRows(WidgetTester tester) {
  var rows = 0;
  for (final element
      in find
          .descendant(of: _transcript, matching: find.byType(SliverList))
          .evaluate()) {
    final sliver = element.renderObject! as RenderSliverList;
    var child = sliver.firstChild;
    while (child != null) {
      rows += 1;
      child = sliver.childAfter(child);
    }
  }
  return rows;
}

Future<void> _wait(int milliseconds) =>
    Future<void>.delayed(Duration(milliseconds: milliseconds));

/// One touch stroke that moves [dy] (positive toward the start of the
/// transcript) over [milliseconds], sampled every 8 ms. A fling lifts while
/// moving; otherwise the finger rests before lifting, so nothing flings.
Future<void> _stroke(
  WidgetTester tester, {
  required double dy,
  required int milliseconds,
  bool fling = false,
}) async {
  final rect = tester.getRect(_transcript);
  final start = Offset(
    rect.center.dx,
    dy > 0 ? rect.top + rect.height * 0.2 : rect.bottom - rect.height * 0.2,
  );
  final clock = Stopwatch()..start();
  final gesture = await tester.createGesture();
  await gesture.down(start, timeStamp: clock.elapsed);
  final steps = math.max(1, milliseconds ~/ 8);
  for (var step = 0; step < steps; step++) {
    await _wait(8);
    await gesture.moveBy(Offset(0, dy / steps), timeStamp: clock.elapsed);
  }
  if (!fling) {
    await _wait(60);
  }
  await gesture.up(timeStamp: clock.elapsed);
}

Future<void> _settle(WidgetTester tester, {int maxMilliseconds = 4000}) async {
  final position = _position(tester);
  final clock = Stopwatch()..start();
  while (clock.elapsedMilliseconds < maxMilliseconds &&
      position.isScrollingNotifier.value) {
    await _wait(16);
  }
  await _wait(50);
}

final class _Run {
  _Run(this.tester, {required int total, required int latencyMs})
    : broker = FixturePagingBroker(total: total, clock: () => _clock.elapsed)
        ..latency = Duration(milliseconds: latencyMs);

  static final Stopwatch _clock = Stopwatch()..start();

  final WidgetTester tester;
  final FixturePagingBroker broker;
  final Map<FixturePageRequest, Duration> painted = {};
  final List<int> activeRowSamples = [];

  Duration get now => _clock.elapsed;

  Future<void> open() async {
    // Every scenario starts cold: nothing parsed by the one before it.
    transcriptRenderCache.clear();
    broker.onAnswered = (request) {
      unawaited(
        SchedulerBinding.instance.endOfFrame.then((_) {
          painted[request] = _clock.elapsed;
        }),
      );
    };
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: broker),
    );
    await tester.pumpAndSettle();
  }

  ScrollPosition get position => _position(tester);

  void sampleRows() {
    activeRowSamples.add(_activeRows(tester));
    checkIntegrity();
  }

  /// What the reader could see go wrong, sampled with the rows: gaps that
  /// need a reconnect, notices that rows never saved were released, a row
  /// held twice, and saved rows out of history order.
  final Map<String, int> integrity = {
    'samples': 0,
    'maxReconnectRequiredGaps': 0,
    'maxUnsavedReleasedNotices': 0,
    'rowsHeldTwice': 0,
    'savedRowsOutOfOrder': 0,
  };

  static final RegExp _savedRow = RegExp(r'^(?:[umtcp]|image-)(\d+)$');

  void checkIntegrity() {
    final window = _state(tester).transcriptWindow;
    if (!window.initialized) return;
    integrity.update('samples', (value) => value + 1);
    final gaps = [?window.leadingGap, ...window.gaps];
    int count(TranscriptHistoryGapKind kind) =>
        gaps.where((gap) => gap.kind == kind).length;
    integrity
      ..update(
        'maxReconnectRequiredGaps',
        (value) => math.max(
          value,
          count(TranscriptHistoryGapKind.reconnectRequired),
        ),
      )
      ..update(
        'maxUnsavedReleasedNotices',
        (value) =>
            math.max(value, count(TranscriptHistoryGapKind.unsavedReleased)),
      );
    final held = <String>{};
    for (final page in window.pages) {
      for (final message in page.messages) {
        final key = stableTranscriptMessageKey(message);
        if (key != null && !held.add(key)) {
          integrity.update('rowsHeldTwice', (value) => value + 1);
        }
      }
    }
    var last = -1;
    for (final message in window.canonicalMessages) {
      final key = stableTranscriptMessageKey(message);
      final match = key == null
          ? null
          : _savedRow.firstMatch(key.substring(key.lastIndexOf(':') + 1));
      if (match == null) continue;
      final row = int.parse(match.group(1)!);
      if (row < last) {
        integrity.update('savedRowsOutOfOrder', (value) => value + 1);
      }
      last = row;
    }
  }

  /// Page latency and bytes for every request answered so far.
  Map<String, Object?> pages() {
    final answered = broker.requests.where((r) => r.answeredAt != null);
    final toPaint = [
      for (final request in answered)
        if (painted[request] case final at?)
          (at - request.requestedAt).inMicroseconds / 1000,
    ];
    return {
      'requested': broker.requests.length,
      'older': broker.older.length,
      'newer': broker.newer.length,
      'refreshes': broker.refreshes,
      'failed': broker.requests.where((r) => r.failed).length,
      'bytes': broker.requests.fold<int>(0, (sum, r) => sum + r.bytes),
      'rows': broker.requests.fold<int>(0, (sum, r) => sum + r.rows),
      'requestToFirstPaintMs': summarizeMillis(toPaint),
    };
  }

  Map<String, Object?> window() {
    final window = _state(tester).transcriptWindow;
    return {
      'pages': window.pages.length,
      'messages': window.messageCount,
      'estimatedBytes': window.estimatedBytes,
      'imageCacheEntries': PaintingBinding.instance.imageCache.currentSize,
      'imageCacheBytes': PaintingBinding.instance.imageCache.currentSizeBytes,
      'renderCacheMarkdownEntries': transcriptRenderCache.markdownEntries,
      'renderCacheMarkdownUnits': transcriptRenderCache.markdownUnits,
      'renderCacheCodeEntries': transcriptRenderCache.codeEntries,
      'renderCacheCodeUnits': transcriptRenderCache.codeUnits,
    };
  }

  Map<String, Object?> rows() => summarizeMillis([
    for (final value in activeRowSamples) value.toDouble(),
  ]);
}

Map<String, Object?> _renderWork(TranscriptRenderWorkCounter work) => {
  'markdownParses': work.markdownParses,
  'markdownParsedUnits': work.markdownParsedUnits,
  'markdownParseMs': work.markdownParseMicros / 1000,
  'markdownCacheHits': work.markdownCacheHits,
  'markdownBodyReuses': work.markdownBodyReuses,
  'markdownBlocksReused': work.markdownBlocksReused,
  'codeHighlights': work.codeHighlights,
  'codeHighlightedUnits': work.codeHighlightedUnits,
  'codeHighlightMs': work.codeHighlightMicros / 1000,
  'codeCacheHits': work.codeCacheHits,
};

/// Reads back through the history with fast strokes until [pages] more older
/// pages have loaded (or [maxStrokes] strokes).
Future<int> _readBack(
  _Run run, {
  required int pages,
  double stroke = 600,
  int strokeMs = 200,
  int maxStrokes = 400,
}) async {
  final target = run.broker.older.length + pages;
  var strokes = 0;
  while (run.broker.older.length < target && strokes < maxStrokes) {
    await _stroke(run.tester, dy: stroke, milliseconds: strokeMs);
    strokes += 1;
    if (strokes % 4 == 0) run.sampleRows();
  }
  await _settle(run.tester);
  return strokes;
}

/// Reads forward until the reader is back at the newest rows (or
/// [maxStrokes] strokes).
Future<int> _readForward(
  _Run run, {
  double stroke = 600,
  int strokeMs = 200,
  int maxStrokes = 400,
}) async {
  var strokes = 0;
  final position = run.position;
  while (strokes < maxStrokes &&
      position.pixels < position.maxScrollExtent - 8) {
    await _stroke(run.tester, dy: -stroke, milliseconds: strokeMs);
    strokes += 1;
    if (strokes % 4 == 0) run.sampleRows();
  }
  await _settle(run.tester);
  return strokes;
}

/// A measured scenario. Semantics stay off, as they are for a reader without
/// an assistive technology: a test binding otherwise builds the semantics
/// tree every frame, which is a cost of its own and not the transcript's.
void _scenario(String description, WidgetTesterCallback body) =>
    testWidgets(description, body, semanticsEnabled: false);

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized()
    ..framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  final report = <String, Object?>{};
  late final FrameRecorder recorder;
  HeapSampler? heap;

  setUpAll(() async {
    recorder = FrameRecorder();
    heap = await HeapSampler.connect();
    report['environment'] = {
      'mode': kProfileMode
          ? 'profile'
          : kReleaseMode
          ? 'release'
          : 'debug',
      'platform': defaultTargetPlatform.name,
      'heapSampler': heap != null,
    };
  });

  tearDownAll(() async {
    recorder.dispose();
    await heap?.close();
    binding.reportData = {'transcript_scroll': report};
  });

  Future<Map<String, Object?>> measure(
    _Run run,
    Future<void> Function() body,
  ) async {
    final work = debugTranscriptRenderWork = TranscriptRenderWorkCounter();
    recorder.start();
    final clock = Stopwatch()..start();
    await body();
    final elapsed = clock.elapsedMilliseconds;
    final frames = await recorder.stop();
    debugTranscriptRenderWork = null;
    final view = binding.platformDispatcher.views.first;
    return {
      'elapsedMs': elapsed,
      'viewport': {
        'width': view.physicalSize.width / view.devicePixelRatio,
        'height': view.physicalSize.height / view.devicePixelRatio,
        'devicePixelRatio': view.devicePixelRatio,
      },
      'frames': summarizeFrames(frames),
      'pages': run.pages(),
      'window': run.window(),
      'activeRows': run.rows(),
      'renderWork': _renderWork(work),
      'integrity': (run..checkIntegrity()).integrity,
    };
  }

  if (_wanted('traverse')) {
    for (final latency in const [0, 100]) {
      _scenario('traverse more than five pages both ways ($latency ms)', (
        tester,
      ) async {
        final run = _Run(tester, total: 3000, latencyMs: latency);
        await run.open();
        final strokes = <String, int>{};
        report['traverse-${latency}ms'] =
            await measure(run, () async {
                for (var cycle = 0; cycle < 2; cycle++) {
                  strokes['back$cycle'] = await _readBack(run, pages: 6);
                  strokes['forward$cycle'] = await _readForward(run);
                }
              })
              ..['strokes'] = strokes;
      });
    }
  }

  if (_wanted('flings')) {
    for (final latency in const [0, 100, 500]) {
      _scenario('flings with pages $latency ms away', (tester) async {
        final run = _Run(tester, total: 3000, latencyMs: latency);
        await run.open();
        final flings = <Map<String, Object?>>[];
        final loadingRows = find.textContaining(
          RegExp('Loading (earlier|newer) messages'),
        );
        // Whether the reader is looking at a page they are waiting for.
        bool waitingOnScreen() =>
            _state(tester).historyPageLoading &&
            loadingRows.hitTestable().evaluate().isNotEmpty;
        Future<void> fling(double dy) async {
          final requests = run.broker.requests.length;
          final position = run.position;
          final from = position.pixels;
          var waitMs = 0;
          var peak = 0.0;
          var previous = position.pixels;
          await _stroke(tester, dy: dy, milliseconds: 40, fling: true);
          final clock = Stopwatch()..start();
          while (position.isScrollingNotifier.value &&
              clock.elapsedMilliseconds < 5000) {
            await _wait(16);
            final pace = (position.pixels - previous).abs() / 0.016;
            previous = position.pixels;
            peak = math.max(peak, pace);
            if (waitingOnScreen()) waitMs += 16;
          }
          final settledRequests = run.broker.requests.length;
          // At rest: how long the reader still looks at a page on its way,
          // and anything asked for after the fling came to rest, which is a
          // chain the reader did not make.
          final rest = Stopwatch()..start();
          while (rest.elapsedMilliseconds < 1200) {
            await _wait(16);
            if (waitingOnScreen()) waitMs += 16;
          }
          flings.add({
            'travel': (position.pixels - from).abs(),
            'peakPxPerS': peak,
            'pagesDuringFling': settledRequests - requests,
            'pagesAfterRest': run.broker.requests.length - settledRequests,
            'waitingOnScreenMs': waitMs,
          });
          run.sampleRows();
        }

        report['flings-${latency}ms'] =
            await measure(run, () async {
                // Start two viewports below the start of what is loaded, so
                // the flings up meet it, and come back down through the
                // ranges released on the way.
                final position = run.position;
                position.jumpTo(
                  position.minScrollExtent + position.viewportDimension * 2,
                );
                await _wait(100);
                for (var index = 0; index < 12 * _scale; index++) {
                  await fling(240);
                }
                for (var index = 0; index < 12 * _scale; index++) {
                  await fling(-240);
                }
              })
              ..['flings'] = flings
              ..['pagesAfterRestTotal'] = flings.fold<int>(
                0,
                (sum, f) => sum + (f['pagesAfterRest']! as int),
              )
              ..['pagesPerFlingMax'] = flings.fold<int>(
                0,
                (m, f) => math.max(m, f['pagesDuringFling']! as int),
              )
              ..['waitingOnScreenMsTotal'] = flings.fold<int>(
                0,
                (sum, f) => sum + (f['waitingOnScreenMs']! as int),
              );
      });
    }
  }

  if (_wanted('stream-far-back')) {
    _scenario('read far back while a reply streams', (tester) async {
      final run = _Run(tester, total: 3000, latencyMs: 0);
      await run.open();
      await _readBack(run, pages: 2);
      var seq = 10000;
      var reply = 0;
      final chunkTimes = <double>[];
      report['stream-far-back'] =
          await measure(run, () async {
              final clock = Stopwatch()..start();
              var direction = 1.0;
              var strokes = 0;
              while (clock.elapsedMilliseconds < 20000 * _scale) {
                final chunks = fixtureStreamedReply(
                  key: 'reply-${reply++}',
                  firstSeq: seq,
                  chunks: 30,
                );
                seq += 100;
                for (var chunk = 0; chunk < chunks.length; chunk++) {
                  final started = clock.elapsedMicroseconds;
                  run.broker.emitEvent(chunks[chunk]);
                  chunkTimes.add((clock.elapsedMicroseconds - started) / 1000);
                  if (chunk.isEven) {
                    // A slow reading stroke every other chunk, turning
                    // around every six strokes so the reader stays inside
                    // what is loaded.
                    await _stroke(
                      tester,
                      dy: 120 * direction,
                      milliseconds: 60,
                    );
                    strokes += 1;
                    if (strokes % 6 == 0) direction = -direction;
                  } else {
                    await _wait(33);
                  }
                }
                run.broker.appendDurable(chunks.last.message);
                run.sampleRows();
              }
            })
            ..['chunkApplyMs'] = summarizeMillis(chunkTimes);
    });
  }

  if (_selected.split(',').contains('trace')) {
    // Where the UI thread's time goes while a reply streams, with the reader
    // far back and with them following it: the timeline by self time, once
    // with only the framework's phase events and once with an event per
    // widget build and per layout (whose own overhead makes those times
    // relative, not absolute). Only on request: a diagnosis, not a
    // measurement.
    Future<Map<String, Object?>> traced(
      Future<void> Function(int ms) run,
    ) async {
      final sampler = heap!;
      final traces = <String, Object?>{};
      await sampler.startTimeline();
      await run(6000);
      traces['phases'] = await sampler.stopTimeline();
      debugProfileBuildsEnabled = true;
      debugProfileLayoutsEnabled = true;
      await sampler.startTimeline();
      await run(6000);
      traces['widgets'] = await sampler.stopTimeline(top: 60);
      debugProfileBuildsEnabled = false;
      debugProfileLayoutsEnabled = false;
      return traces;
    }

    _scenario('trace a reply streaming while reading far back', (tester) async {
      if (heap == null) return;
      final run = _Run(tester, total: 3000, latencyMs: 0);
      await run.open();
      await _readBack(run, pages: 2);
      var seq = 30000;
      var reply = 0;
      report['trace-stream-far-back'] = await traced((milliseconds) async {
        final clock = Stopwatch()..start();
        var direction = 1.0;
        var strokes = 0;
        while (clock.elapsedMilliseconds < milliseconds) {
          final chunks = fixtureStreamedReply(
            key: 'trace-reply-${reply++}',
            firstSeq: seq,
            chunks: 30,
          );
          seq += 100;
          for (var chunk = 0; chunk < chunks.length; chunk++) {
            run.broker.emitEvent(chunks[chunk]);
            if (chunk.isEven) {
              await _stroke(tester, dy: 120 * direction, milliseconds: 60);
              strokes += 1;
              if (strokes % 6 == 0) direction = -direction;
            } else {
              await _wait(33);
            }
          }
          run.broker.appendDurable(chunks.last.message);
        }
      });
    });

    _scenario('trace a reply streaming at the tail', (tester) async {
      if (heap == null) return;
      final run = _Run(tester, total: 3000, latencyMs: 0);
      await run.open();
      var seq = 40000;
      var reply = 0;
      report['trace-stream-at-tail'] = await traced((milliseconds) async {
        final clock = Stopwatch()..start();
        while (clock.elapsedMilliseconds < milliseconds) {
          final chunks = fixtureStreamedReply(
            key: 'trace-tail-${reply++}',
            firstSeq: seq,
            chunks: 60,
          );
          seq += 100;
          for (final chunk in chunks) {
            run.broker.emitEvent(chunk);
            await _wait(33);
            if (clock.elapsedMilliseconds >= milliseconds) break;
          }
          run.broker.appendDurable(chunks.last.message);
        }
      });
    });
  }

  if (_wanted('stream-at-tail')) {
    _scenario('follow a reply streaming at the tail', (tester) async {
      final run = _Run(tester, total: 3000, latencyMs: 0);
      await run.open();
      var seq = 20000;
      final chunkTimes = <double>[];
      final clock = Stopwatch()..start();
      report['stream-at-tail'] =
          await measure(run, () async {
              for (var reply = 0; reply < 4 * _scale; reply++) {
                final chunks = fixtureStreamedReply(
                  key: 'tail-reply-$reply',
                  firstSeq: seq,
                  chunks: 60,
                );
                seq += 100;
                for (final chunk in chunks) {
                  final started = clock.elapsedMicroseconds;
                  run.broker.emitEvent(chunk);
                  chunkTimes.add((clock.elapsedMicroseconds - started) / 1000);
                  await _wait(33);
                }
                run.broker.appendDurable(chunks.last.message);
                run.sampleRows();
              }
            })
            ..['chunkApplyMs'] = summarizeMillis(chunkTimes);
    });
  }

  if (_wanted('memory-stream')) {
    _scenario('heap during a long stream', (tester) async {
      final run = _Run(tester, total: 3000, latencyMs: 0);
      await run.open();
      final curve = <Map<String, Object?>>[];
      Future<void> sample(int second) async {
        final heapNow = await heap?.sample();
        run.checkIntegrity();
        curve.add({'second': second, ...?heapNow, ...run.window()});
      }

      var seq = 30000;
      var turn = 0;
      report['memory-stream'] =
          await measure(run, () async {
              final clock = Stopwatch()..start();
              var nextSample = 0;
              const seconds = 90 * _scale;
              while (clock.elapsedMilliseconds < seconds * 1000) {
                if (clock.elapsedMilliseconds >= nextSample * 1000) {
                  await sample(nextSample);
                  nextSample += 10;
                }
                final prompt = AgentMessage.fromJson({
                  'type': 'user-message',
                  'key': 'stream-user-$turn',
                  'text': 'Turn $turn: keep going.',
                });
                run.broker
                  ..emitEvent(MessageWireEvent(seq: seq++, message: prompt))
                  ..appendDurable(prompt);
                final chunks = fixtureStreamedReply(
                  key: 'stream-reply-$turn',
                  firstSeq: seq,
                  chunks: 40,
                );
                seq += 100;
                for (final chunk in chunks) {
                  run.broker.emitEvent(chunk);
                  await _wait(33);
                }
                run.broker.appendDurable(chunks.last.message);
                for (final raw in [
                  {
                    'type': 'tool-call',
                    'callId': 'stream-call-$turn',
                    'name': 'bash',
                    'toolClass': 'execute',
                    'args': {'command': 'dart test --name turn$turn'},
                  },
                  {
                    'type': 'tool-result',
                    'callId': 'stream-call-$turn',
                    'name': 'bash',
                    'toolClass': 'execute',
                    'result': List.filled(30, 'turn $turn: all tests passed')
                        .join(
                          '\n',
                        ),
                  },
                ]) {
                  final message = AgentMessage.fromJson(raw);
                  run.broker
                    ..emitEvent(MessageWireEvent(seq: seq++, message: message))
                    ..appendDurable(message);
                }
                turn += 1;
              }
              await sample(seconds);
            })
            ..['heapCurve'] = curve
            ..['turns'] = turn;
    });
  }

  if (_wanted('memory-paging')) {
    _scenario('heap across repeated paging both ways', (tester) async {
      final run = _Run(tester, total: 3000, latencyMs: 0);
      await run.open();
      final curve = <Map<String, Object?>>[];
      // What grows between the second cycle (the window and the caches are
      // full by then) and the last.
      Map<String, ({int instances, int bytes})>? settled;
      Map<String, ({int instances, int bytes})>? last;
      report['memory-paging'] =
          await measure(run, () async {
              curve.add({
                'cycle': 0,
                ...?await heap?.sample(),
                ...run.window(),
              });
              for (var cycle = 1; cycle <= 4 * _scale; cycle++) {
                await _readBack(run, pages: 6, stroke: 900, strokeMs: 150);
                await _readForward(run, stroke: 900, strokeMs: 150);
                curve.add({
                  'cycle': cycle,
                  ...?await heap?.sample(),
                  ...run.window(),
                });
                if (cycle == 2) settled = await heap?.classes();
                if (cycle == 4 * _scale) last = await heap?.classes();
              }
            })
            ..['heapCurve'] = curve
            ..['classGrowthAfterCycle2'] = settled == null || last == null
                ? null
                : HeapSampler.growth(settled!, last!);
    });
  }

  if (_wanted('costs')) {
    _scenario('decode, reduce, parse, highlight and serialize costs', (
      tester,
    ) async {
      double timeMs(void Function() body, {int repeat = 1}) {
        final clock = Stopwatch()..start();
        for (var i = 0; i < repeat; i++) {
          body();
        }
        return clock.elapsedMicroseconds / 1000 / repeat;
      }

      final rows = [for (var i = 0; i < 1000; i++) fixtureRowJson(i)];
      final pageJson = jsonEncode({
        'kind': 'history-page',
        'messages': rows.sublist(0, 100),
        'cursor': 'b0',
        'hasMore': false,
        'endOfHistory': true,
      });
      final decodeMs = timeMs(
        () => WireEvent.fromJson(jsonDecode(pageJson) as Map<String, dynamic>),
        repeat: 20,
      );

      final messages = [for (final raw in rows) AgentMessage.fromJson(raw)];
      var window = TranscriptHistoryWindow.fromHistory(
        HistoryWireEvent(
          messages: messages.sublist(900, 1000),
          reset: true,
          cursor: 'r1000',
          olderCursor: 'b900',
          hasEarlier: true,
        ),
      );
      final prependMs = <double>[];
      for (var page = 8; page >= 0; page--) {
        final start = page * 100;
        final event = HistoryPageWireEvent(
          messages: messages.sublist(start, start + 100),
          cursor: start > 0 ? 'b$start' : null,
          hasMore: start > 0,
          endOfHistory: start == 0,
        );
        prependMs.add(
          timeMs(() {
            window = window
                .prependPage(event, requestedCursor: 'b${start + 100}')
                .window;
          }),
        );
      }
      final liveMs = <double>[];
      for (final chunk in fixtureStreamedReply(
        key: 'cost-reply',
        firstSeq: 50000,
        chunks: 200,
      )) {
        liveMs.add(
          timeMs(() {
            window = window.applyLiveMessage(chunk.message);
          }),
        );
      }

      final parseByKind = <String, List<double>>{};
      final highlightMs = <double>[];
      for (var i = 0; i < 1000; i++) {
        final raw = rows[i];
        final text = raw['text'];
        if (text is! String || raw['type'] != 'model-output') continue;
        final kind = fixtureRowIsOversized(i)
            ? 'oversized'
            : switch (i % 10) {
                2 => 'table',
                3 => 'code',
                _ => 'prose',
              };
        late List<MarkdownBlock> blocks;
        parseByKind
            .putIfAbsent(kind, () => [])
            .add(
              timeMs(() => blocks = parseTranscriptMarkdown(text)),
            );
        for (final block in blocks.whereType<MarkdownCodeBlock>()) {
          highlightMs.add(
            timeMs(
              () => highlightTranscriptCode(
                block.code,
                language: block.language,
              ),
            ),
          );
        }
      }
      final tail = messages.sublist(900, 1000);
      final serializeMs = timeMs(
        () => [for (final m in tail) jsonEncode(m.toJson())].join(','),
        repeat: 20,
      );
      report['costs'] = {
        'decodePage100Ms': decodeMs,
        'pageBytes': utf8.encode(pageJson).length,
        'prependPageMs': summarizeMillis(prependMs),
        'applyLiveChunkMs': summarizeMillis(liveMs),
        'parseMs': {
          for (final entry in parseByKind.entries)
            entry.key: summarizeMillis(entry.value),
        },
        'highlightMs': summarizeMillis(highlightMs),
        'serializeTail100Ms': serializeMs,
      };
    });
  }
}
