// Frame, latency and heap measurement for the transcript scroll harness.
//
// Desktop only: it reads the isolate's heap through the VM service, which a
// profile build started by `flutter drive` exposes to the app itself.
import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:ui' show FramePhase, FrameTiming;

import 'package:flutter/scheduler.dart';

/// 60 Hz and 120 Hz frame budgets, in milliseconds.
const double kBudget60 = 1000 / 60;
const double kBudget120 = 1000 / 120;

/// Collects every frame the engine reports between [start] and [stop].
final class FrameRecorder {
  FrameRecorder() {
    SchedulerBinding.instance.addTimingsCallback(_onTimings);
  }

  final List<FrameTiming> _all = [];
  late int _startMicros;
  late int _stopMicros;

  void _onTimings(List<FrameTiming> timings) => _all.addAll(timings);

  /// Starts a measured interval.
  void start() {
    _all.clear();
    _startMicros = developer.Timeline.now;
  }

  /// Ends the interval and waits for the engine to report its last frames.
  Future<List<FrameTiming>> stop() async {
    _stopMicros = developer.Timeline.now;
    // Profile builds report frame timings in batches, about once a second.
    await Future<void>.delayed(const Duration(milliseconds: 1500));
    final start = _startMicros;
    final stop = _stopMicros;
    return [
      for (final timing in _all)
        if (timing.timestampInMicroseconds(FramePhase.buildStart) >= start &&
            timing.timestampInMicroseconds(FramePhase.buildStart) <= stop)
          timing,
    ];
  }

  void dispose() => SchedulerBinding.instance.removeTimingsCallback(_onTimings);
}

double _percentile(List<double> sorted, double p) {
  if (sorted.isEmpty) return double.nan;
  final rank = (p / 100) * (sorted.length - 1);
  final low = rank.floor();
  final high = rank.ceil();
  if (low == high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

Map<String, Object?> _distribution(List<double> values) {
  if (values.isEmpty) {
    return {'p50': null, 'p95': null, 'p99': null, 'max': null, 'mean': null};
  }
  final sorted = [...values]..sort();
  double round(double value) => (value * 1000).round() / 1000;
  return {
    'p50': round(_percentile(sorted, 50)),
    'p95': round(_percentile(sorted, 95)),
    'p99': round(_percentile(sorted, 99)),
    'max': sorted.isEmpty ? null : round(sorted.last),
    'mean': sorted.isEmpty
        ? null
        : round(sorted.reduce((a, b) => a + b) / sorted.length),
  };
}

/// Summarizes [frames]: UI (build) and raster time distributions, frames over
/// the 60 Hz and 120 Hz budgets on either thread, the worst stalls, and gaps
/// between frames longer than one and a half display intervals.
Map<String, Object?> summarizeFrames(List<FrameTiming> frames) {
  double ms(Duration d) => d.inMicroseconds / 1000;
  final build = [for (final f in frames) ms(f.buildDuration)];
  final raster = [for (final f in frames) ms(f.rasterDuration)];
  final worst = [
    for (var i = 0; i < frames.length; i++) math.max(build[i], raster[i]),
  ];
  int over(double budget) => worst.where((v) => v > budget).length;
  final starts = [
    for (final f in frames) f.timestampInMicroseconds(FramePhase.vsyncStart),
  ]..sort();
  final intervals = [
    for (var i = 1; i < starts.length; i++) (starts[i] - starts[i - 1]) / 1000,
  ];
  final sortedIntervals = [...intervals]..sort();
  final period = sortedIntervals.isEmpty
      ? kBudget60
      : _percentile(sortedIntervals, 50);
  final stalls = [...worst]..sort((a, b) => b.compareTo(a));
  return {
    'frames': frames.length,
    'ui': _distribution(build),
    'raster': _distribution(raster),
    'worstOfUiAndRaster': _distribution(worst),
    'over16_7ms': over(kBudget60),
    'over8_3ms': over(kBudget120),
    'within16_7msShare': frames.isEmpty
        ? null
        : (frames.length - over(kBudget60)) / frames.length,
    'within8_3msShare': frames.isEmpty
        ? null
        : (frames.length - over(kBudget120)) / frames.length,
    'worstStallsMs': [
      for (final value in stalls.take(5)) (value * 1000).round() / 1000,
    ],
    'medianFrameIntervalMs': (period * 1000).round() / 1000,
    'intervalsOver1_5Periods': intervals
        .where((value) => value > period * 1.5)
        .length,
  };
}

/// Summarizes a list of durations in milliseconds.
Map<String, Object?> summarizeMillis(List<double> values) => {
  'count': values.length,
  ..._distribution(values),
};

/// The isolate's heap, read through the VM service after a full collection.
final class HeapSampler {
  HeapSampler._(this._socket, this._isolateId) {
    _socket.listen((data) {
      final message = jsonDecode(data as String) as Map<String, Object?>;
      final id = message['id'];
      final pending = _pending.remove(id);
      if (pending == null) return;
      if (message['error'] case final Object error) {
        pending.completeError(StateError('$error'));
      } else {
        pending.complete(message['result']! as Map<String, Object?>);
      }
    });
  }

  final WebSocket _socket;
  final String _isolateId;
  final Map<Object?, Completer<Map<String, Object?>>> _pending = {};
  int _nextId = 0;

  /// Connects to this isolate's VM service, or returns null without one.
  static Future<HeapSampler?> connect() async {
    final info = await developer.Service.getInfo();
    final uri = info.serverWebSocketUri;
    final isolateId = developer.Service.getIsolateId(Isolate.current);
    if (uri == null || isolateId == null) return null;
    final socket = await WebSocket.connect(uri.toString());
    return HeapSampler._(socket, isolateId);
  }

  Future<Map<String, Object?>> _call(
    String method,
    Map<String, Object?> params,
  ) {
    final id = '${_nextId++}';
    final completer = Completer<Map<String, Object?>>();
    _pending[id] = completer;
    _socket.add(
      jsonEncode({
        'jsonrpc': '2.0',
        'id': id,
        'method': method,
        'params': params,
      }),
    );
    return completer.future;
  }

  /// Live instances and bytes per class after a full garbage collection,
  /// keyed by library and class name.
  Future<Map<String, ({int instances, int bytes})>> classes() async {
    final profile = await _call('getAllocationProfile', {
      'isolateId': _isolateId,
      'gc': true,
    });
    final out = <String, ({int instances, int bytes})>{};
    for (final member in (profile['members'] as List<Object?>? ?? const [])) {
      if (member is! Map<String, Object?>) continue;
      final cls = member['class'];
      if (cls is! Map<String, Object?>) continue;
      final library = cls['library'];
      final libraryUri = library is Map<String, Object?>
          ? library['uri']
          : null;
      final name = '${libraryUri ?? '?'}::${cls['name']}';
      out[name] = (
        instances: (member['instancesCurrent'] as num? ?? 0).toInt(),
        bytes: (member['bytesCurrent'] as num? ?? 0).toInt(),
      );
    }
    return out;
  }

  /// The [limit] classes whose live bytes grew most from [before] to
  /// [after].
  static List<Map<String, Object?>> growth(
    Map<String, ({int instances, int bytes})> before,
    Map<String, ({int instances, int bytes})> after, {
    int limit = 30,
  }) {
    final rows = [
      for (final MapEntry(:key, :value) in after.entries)
        (
          name: key,
          bytes: value.bytes - (before[key]?.bytes ?? 0),
          instances: value.instances - (before[key]?.instances ?? 0),
        ),
    ]..sort((a, b) => b.bytes.compareTo(a.bytes));
    return [
      for (final row in rows.take(limit))
        {'class': row.name, 'bytes': row.bytes, 'instances': row.instances},
    ];
  }

  /// Heap usage after a full garbage collection, and the process RSS.
  Future<Map<String, int>> sample() async {
    final profile = await _call('getAllocationProfile', {
      'isolateId': _isolateId,
      'gc': true,
    });
    final usage = profile['memoryUsage']! as Map<String, Object?>;
    return {
      'heapUsageBytes': (usage['heapUsage']! as num).toInt(),
      'heapCapacityBytes': (usage['heapCapacity']! as num).toInt(),
      'externalUsageBytes': (usage['externalUsage']! as num).toInt(),
      'rssBytes': ProcessInfo.currentRss,
    };
  }

  /// Starts recording the Dart and embedder timeline streams afresh.
  Future<void> startTimeline() async {
    await _call('setVMTimelineFlags', {
      'recordedStreams': ['Dart', 'Embedder', 'GC'],
    });
    await _call('clearVMTimeline', {});
  }

  /// Stops recording and summarizes what was recorded: per event name, how
  /// many times it ran and its total inclusive and self time (its own time,
  /// without the events nested in it on the same thread), the [top] names by
  /// self time.
  Future<Map<String, Object?>> stopTimeline({int top = 40}) async {
    final timeline = await _call('getVMTimeline', {});
    await _call('setVMTimelineFlags', {'recordedStreams': <String>[]});
    final events = (timeline['traceEvents']! as List<Object?>)
        .cast<Map<String, Object?>>();
    return summarizeTimeline(events, top: top);
  }

  Future<void> close() => _socket.close();
}

/// See [HeapSampler.stopTimeline].
Map<String, Object?> summarizeTimeline(
  List<Map<String, Object?>> events, {
  int top = 40,
}) {
  final intervals = <({Object? tid, int start, int end, String name})>[];
  final open = <Object?, List<({String name, int start})>>{};
  for (final event in events) {
    final phase = event['ph'];
    final name = '${event['name']}';
    final ts = (event['ts'] as num?)?.toInt();
    final tid = event['tid'];
    if (ts == null) continue;
    if (phase == 'X') {
      final dur = (event['dur'] as num?)?.toInt() ?? 0;
      intervals.add((tid: tid, start: ts, end: ts + dur, name: name));
    } else if (phase == 'B') {
      (open[tid] ??= []).add((name: name, start: ts));
    } else if (phase == 'E') {
      final stack = open[tid];
      if (stack == null || stack.isEmpty) continue;
      final begin = stack.removeLast();
      intervals.add((tid: tid, start: begin.start, end: ts, name: begin.name));
    }
  }
  intervals.sort((a, b) {
    final byThread = '${a.tid}'.compareTo('${b.tid}');
    if (byThread != 0) return byThread;
    final byStart = a.start.compareTo(b.start);
    if (byStart != 0) return byStart;
    return b.end.compareTo(a.end);
  });
  final count = <String, int>{};
  final inclusive = <String, int>{};
  final self = <String, int>{};
  final stack = <({Object? tid, int start, int end, String name})>[];
  final childTime = <int>[];
  void pop() {
    final done = stack.removeLast();
    final children = childTime.removeLast();
    final duration = done.end - done.start;
    self[done.name] = (self[done.name] ?? 0) + duration - children;
    if (childTime.isNotEmpty) childTime[childTime.length - 1] += duration;
  }

  for (final interval in intervals) {
    while (stack.isNotEmpty &&
        (stack.last.tid != interval.tid || stack.last.end <= interval.start)) {
      pop();
    }
    stack.add(interval);
    childTime.add(0);
    count[interval.name] = (count[interval.name] ?? 0) + 1;
    inclusive[interval.name] =
        (inclusive[interval.name] ?? 0) + interval.end - interval.start;
  }
  while (stack.isNotEmpty) {
    pop();
  }
  final names = self.keys.toList()
    ..sort((a, b) => self[b]!.compareTo(self[a]!));
  return {
    'events': intervals.length,
    'bySelfTime': [
      for (final name in names.take(top))
        {
          'name': name,
          'count': count[name],
          'selfMs': self[name]! / 1000,
          'inclusiveMs': inclusive[name]! / 1000,
        },
    ],
  };
}
