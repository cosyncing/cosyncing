import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// The DTO the broker actually builds, shared with the broker suite through
/// `contracts/generated/usage-report.sample.json`.
Map<String, dynamic> sampleReport() =>
    jsonDecode(
          File(
            '../../contracts/generated/usage-report.sample.json',
          ).readAsStringSync(),
        )
        as Map<String, dynamic>;

class _FakeUsageReportApi implements UsageReportApi {
  _FakeUsageReportApi({this.failure});

  /// The failure this fake raises, if any.
  ///
  /// Typed as [Exception]/[Error] rather than [Object] so the two cases the
  /// provider must tell apart stay expressible: a [BrokerException] is
  /// "unavailable" and anything else is a bug that must surface.
  final Object? failure;
  final List<({String from, String to})> windows = [];

  @override
  Future<UsageReportResponse> getReport({
    required String from,
    required String to,
  }) async {
    windows.add((from: from, to: to));
    final failure = this.failure;
    if (failure is Exception) throw failure;
    if (failure is Error) throw failure;
    return UsageReportResponse.fromJson({'ok': true, 'data': sampleReport()});
  }
}

void main() {
  final wednesday = DateTime(2026, 9, 2, 9);

  ProviderContainer containerWith(UsageReportApi? api) {
    final container = ProviderContainer(
      overrides: [
        usageNowProvider.overrideWithValue(() => wednesday),
        if (api != null) usageReportApiProvider.overrideWithValue(api),
        if (api == null)
          usageReportApiContextProvider.overrideWith((ref) async => null),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  test('no connected broker means unavailable, not an empty report', () async {
    final container = containerWith(null);
    expect(
      await container.read(usageReportProvider(UsagePeriod.month).future),
      isNull,
    );
  });

  test('a broker read failure is unavailable, never zeros', () async {
    // Tokdash down or the broker answering 502. Rendering 0 tokens for that
    // would tell the user they did no work, which is a different claim.
    final api = _FakeUsageReportApi(
      failure: const BrokerException(
        message: 'tokdash unreachable',
        statusCode: 502,
      ),
    );
    final container = containerWith(api);
    expect(
      await container.read(usageReportProvider(UsagePeriod.year).future),
      isNull,
    );
  });

  test('a programming error is not swallowed as unavailable', () async {
    final api = _FakeUsageReportApi(failure: StateError('decode bug'));
    final container = containerWith(api);
    await expectLater(
      container.read(usageReportProvider(UsagePeriod.month).future),
      throwsStateError,
    );
  });

  test('the resolved window is what reaches the broker', () async {
    final api = _FakeUsageReportApi();
    final container = containerWith(api);

    await container.read(usageReportProvider(UsagePeriod.month).future);
    expect(api.windows.single.from, '2026-09-01');
    expect(api.windows.single.to, '2026-09-02');
  });

  test('each period is its own window and its own cache entry', () async {
    final api = _FakeUsageReportApi();
    final container = containerWith(api);

    // Held so the auto-dispose family keeps every period alive at once, which
    // is what a user flipping the segmented control produces.
    final subscriptions = [
      for (final period in UsagePeriod.report)
        container.listen(usageReportProvider(period), (previous, next) {}),
    ];
    for (final period in UsagePeriod.report) {
      await container.read(usageReportProvider(period).future);
    }

    expect(api.windows, hasLength(4));
    expect(
      api.windows.map((window) => window.from).toList(),
      ['2026-08-31', '2026-09-01', '2026-01-01', usageAllTimeFloor],
    );
    // Every period ends today: the report is always a window that includes now.
    expect(api.windows.every((window) => window.to == '2026-09-02'), isTrue);

    // Re-reading a period already resolved costs no second broker call.
    await container.read(usageReportProvider(UsagePeriod.year).future);
    expect(api.windows, hasLength(4));
    for (final subscription in subscriptions) {
      subscription.close();
    }
  });

  test('a served report decodes through to its figures', () async {
    final api = _FakeUsageReportApi();
    final container = containerWith(api);

    final response = await container.read(
      usageReportProvider(UsagePeriod.month).future,
    );
    final report = response!.report!;
    expect(report.totals.tokens, 19893991786);
    expect(report.range.recognized, isTrue);
    expect(report.projectReconciliation, isNotNull);
  });
}
