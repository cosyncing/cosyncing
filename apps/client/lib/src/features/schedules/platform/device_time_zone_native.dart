import 'dart:io';

import 'package:flutter_timezone/flutter_timezone.dart';

/// Resolves the device's IANA zone without guessing from a UTC offset.
Future<String?> readDeviceIanaTimeZone() async {
  try {
    final info = await FlutterTimezone.getLocalTimezone();
    final zone = normalizeDeviceIanaTimeZoneCandidate(info.identifier);
    if (zone != null) return zone;
  } on Object {
    // The plug-in channel is unavailable in headless Flutter tests. Preserve
    // the native fallbacks for that lane and for unsupported host setups.
  }
  final environmentZone = normalizeDeviceIanaTimeZoneCandidate(
    Platform.environment['TZ'],
  );
  if (environmentZone != null) return environmentZone;
  if (!Platform.isLinux) return null;
  try {
    final value = await File('/etc/timezone').readAsString();
    return normalizeDeviceIanaTimeZoneCandidate(value);
  } on Object {
    return null;
  }
}

/// Normalizes a native zone candidate without guessing from a UTC offset.
///
/// `UTC` and `GMT` are IANA links despite not containing a slash. The broker
/// remains the final authority and validates the submitted identifier.
String? normalizeDeviceIanaTimeZoneCandidate(String? value) {
  final trimmed = value?.trim();
  if (trimmed == null || trimmed.isEmpty) {
    return null;
  }
  return trimmed == 'UTC' || trimmed == 'GMT' || trimmed.contains('/')
      ? trimmed
      : null;
}
