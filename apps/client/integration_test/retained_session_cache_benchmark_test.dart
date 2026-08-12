import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/view/retained_session_pages.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'support/benchmark_memory.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const selectedScenario = String.fromEnvironment(
    'RETAINED_BENCHMARK_SCENARIO',
    defaultValue: 'all',
  );

  testWidgets('retained session switch and memory benchmark', (tester) async {
    final results = <String, Object?>{};
    for (final scenario in const [
      (name: 'ordinary', payloadRows: 40),
      (name: 'large', payloadRows: 4000),
    ]) {
      if (selectedScenario != 'all' && selectedScenario != scenario.name) {
        continue;
      }
      final active = ValueNotifier<String>(_refs.first.key);
      final openRefs = <SessionRef>[];

      // Warm the common retained-host/render pipeline before the memory
      // baseline so its one-time engine allocations are not attributed to the
      // scenario's page payload.
      await tester.pumpWidget(
        _benchmarkApp(
          active: active,
          openRefs: openRefs,
          payloadRows: 0,
        ),
      );
      for (final session in _refs) {
        openRefs.add(session);
        active.value = session.key;
        await tester.pump();
      }
      for (var index = 0; index < 10; index++) {
        active.value = _refs[index.isEven ? 4 : 5].key;
        await tester.pump();
      }
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();

      openRefs.clear();
      active.value = _refs.first.key;
      await tester.pumpWidget(
        _benchmarkApp(
          active: active,
          openRefs: openRefs,
          payloadRows: scenario.payloadRows,
        ),
      );
      await tester.pump();

      final memoryBefore = benchmarkMemoryBytes();
      for (final session in _refs) {
        openRefs.add(session);
        active.value = session.key;
        await tester.pump();
      }
      expect(
        find.byType(_BenchmarkPage, skipOffstage: false),
        findsNWidgets(retainedSessionPageBudget),
      );
      final memoryRetained = benchmarkMemoryBytes();

      final stopwatch = Stopwatch();
      await binding.watchPerformance(
        () async {
          stopwatch.start();
          for (var index = 0; index < 60; index++) {
            final destination = _refs[index.isEven ? 4 : 5];
            active.value = destination.key;
            await tester.pump();
            expect(
              find.text('BENCH ${destination.key}').hitTestable(),
              findsOneWidget,
            );
          }
          stopwatch.stop();
        },
        reportKey: '${scenario.name}_frames',
      );

      results[scenario.name] = <String, Object?>{
        'payloadRowsPerPage': scenario.payloadRows,
        'retainedPages': retainedSessionPageBudget,
        'switches': 60,
        'elapsedMicroseconds': stopwatch.elapsedMicroseconds,
        'meanSwitchMicroseconds': stopwatch.elapsedMicroseconds / 60,
        'memoryBeforeBytes': memoryBefore,
        'memoryRetainedBytes': memoryRetained,
        'memoryDeltaBytes': memoryBefore == null || memoryRetained == null
            ? null
            : memoryRetained - memoryBefore,
      };

      await tester.pumpWidget(const SizedBox.shrink());
      active.dispose();
      await tester.pump();
    }
    binding.reportData ??= <String, dynamic>{};
    binding.reportData!['retained_session_cache'] = results;
  });
}

Widget _benchmarkApp({
  required ValueNotifier<String> active,
  required List<SessionRef> openRefs,
  required int payloadRows,
}) => ProviderScope(
  child: MaterialApp(
    home: Scaffold(
      body: ValueListenableBuilder<String>(
        valueListenable: active,
        builder: (context, activeKey, _) => RetainedSessionPages(
          source: _source,
          open: OpenSessionsState(refs: openRefs, activeKey: activeKey),
          builder: (context, session) => _BenchmarkPage(
            session: session,
            payloadRows: payloadRows,
          ),
        ),
      ),
    ),
  ),
);

const _source = RosterSource(
  profileId: 'benchmark',
  endpoint: 'http://benchmark.invalid',
);

const _refs = <SessionRef>[
  SessionRef(tool: 'codex', id: '1', title: '1', status: SessionStatus.idle),
  SessionRef(tool: 'codex', id: '2', title: '2', status: SessionStatus.idle),
  SessionRef(tool: 'codex', id: '3', title: '3', status: SessionStatus.idle),
  SessionRef(tool: 'codex', id: '4', title: '4', status: SessionStatus.idle),
  SessionRef(tool: 'codex', id: '5', title: '5', status: SessionStatus.idle),
  SessionRef(tool: 'codex', id: '6', title: '6', status: SessionStatus.idle),
];

final class _BenchmarkPage extends StatefulWidget {
  const _BenchmarkPage({required this.session, required this.payloadRows});

  final SessionRef session;
  final int payloadRows;

  @override
  State<_BenchmarkPage> createState() => _BenchmarkPageState();
}

final class _BenchmarkPageState extends State<_BenchmarkPage> {
  late final List<String> payload;

  @override
  void initState() {
    super.initState();
    payload = List<String>.generate(
      widget.payloadRows,
      (index) => '${widget.session.key}:$index:retained-benchmark-payload',
      growable: false,
    );
  }

  @override
  Widget build(BuildContext context) => ListView.builder(
    itemCount: payload.length,
    itemExtent: 28,
    itemBuilder: (context, index) => Text(
      index == 0 ? 'BENCH ${widget.session.key}' : payload[index],
    ),
  );
}
