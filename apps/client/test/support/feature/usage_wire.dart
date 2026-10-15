// The broker's usage-report surface for feature tests (F10): one stateful fake
// in place of the five private `_StubApi` copies the legacy usage tests
// carried.
//
// It serves `GET /api/tokdash/report?from&to` through a `FakeBroker`, so the
// app's real `BrokerClient`, identity-bound API context and broker-scope key
// run against it, and it records every window the app asked for.
import 'dart:convert';
import 'dart:io';

import 'fake_broker.dart';

/// The DTO the broker actually builds, shared with the broker suite through
/// `contracts/generated/usage-report.sample.json`.
Map<String, Object?> usageSample() =>
    (jsonDecode(
              File(
                '../../contracts/generated/usage-report.sample.json',
              ).readAsStringSync(),
            )
            as Map<String, dynamic>)
        .cast<String, Object?>();

/// A window the app asked the broker for.
typedef UsageWindow = ({String from, String to});

/// Usage reports of one broker.
class UsageDesk {
  /// Serves `/api/tokdash/report` of [broker].
  UsageDesk(this.broker) {
    broker.routes.add(_route);
  }

  /// The broker.
  final FakeBroker broker;

  /// Windows asked for, oldest first.
  final List<UsageWindow> windows = [];

  /// What a window is answered with: the report body (`data`). Defaults to
  /// the committed sample whatever the window.
  Map<String, Object?> Function(UsageWindow window) serve = (_) =>
      usageSample();

  /// Answer every read with this broker failure (Tokdash down).
  FakeBrokerResponse? failure;

  Future<FakeBrokerResponse?> _route(FakeBrokerRequest request) async {
    if (request.method != 'GET' || request.path != '/api/tokdash/report') {
      return null;
    }
    final window = (
      from: request.uri.queryParameters['from']!,
      to: request.uri.queryParameters['to']!,
    );
    windows.add(window);
    return failure ??
        FakeBrokerResponse(200, {'ok': true, 'data': serve(window)});
  }
}
