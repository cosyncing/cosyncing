@TestOn('browser')
library;

import 'package:cosyncing_client/src/features/schedules/platform/device_time_zone.dart';
import 'package:cosyncing_client/src/features/schedules/platform/device_time_zone_web.dart'
    as web;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Executes the real `Intl.DateTimeFormat` js_interop path in a browser.
///
/// This is the runtime evidence the Part 3 closure item required: the web
/// resolver had only ever been read, never run. `Intl` must yield a canonical
/// IANA identifier — a `Region/City` pair or the `UTC`/`Etc/*` forms a
/// containerized host reports.
void main() {
  bool looksLikeIanaZone(String value) =>
      value == 'UTC' || value.startsWith('Etc/') || value.contains('/');

  test('web Intl interop resolves a canonical IANA zone', () async {
    final zone = await web.readDeviceIanaTimeZone();

    expect(zone, isNotNull);
    expect(zone, isNotEmpty);
    expect(looksLikeIanaZone(zone!), isTrue, reason: 'got: $zone');
  });

  test('the injectable resolver provider yields the web zone', () async {
    final container = ProviderContainer();
    addTearDown(container.dispose);

    final zone = await container.read(deviceTimeZoneResolverProvider)();

    expect(zone, isNotNull);
    expect(looksLikeIanaZone(zone!.trim()), isTrue, reason: 'got: $zone');
  });
}
