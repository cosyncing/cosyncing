@TestOn('browser')
library;

import 'package:cosyncing_client/src/features/schedules/platform/device_time_zone.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('reads an IANA time zone from the browser Intl API', () async {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final zone = await container.read(deviceTimeZoneResolverProvider)();

    expect(zone, isNotNull);
    expect(zone, isNotEmpty);
    expect(zone == 'UTC' || zone!.contains('/'), isTrue);
  });
}
