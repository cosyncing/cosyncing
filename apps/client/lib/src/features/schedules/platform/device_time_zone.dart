import 'package:cosyncing_client/src/features/schedules/platform/device_time_zone_native.dart'
    if (dart.library.js_interop) 'package:cosyncing_client/src/features/schedules/platform/device_time_zone_web.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Resolves the device's current IANA time-zone identifier.
typedef DeviceTimeZoneResolver = Future<String?> Function();

/// Injectable resolver used only for repeating schedules.
final deviceTimeZoneResolverProvider = Provider<DeviceTimeZoneResolver>((ref) {
  return readDeviceIanaTimeZone;
});
