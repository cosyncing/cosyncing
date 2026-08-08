import 'dart:io';

import 'package:cosyncing_client/src/features/schedules/platform/device_time_zone_native.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('flutter_timezone');

  test('prefers the flutter_timezone IANA identifier', () async {
    MethodCall? observedCall;
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      channel,
      (call) async {
        observedCall = call;
        return <String, Object?>{
          'identifier': 'America/New_York',
          'localizedName': null,
          'locale': null,
        };
      },
    );
    addTearDown(
      () => binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );

    expect(await readDeviceIanaTimeZone(), 'America/New_York');
    expect(observedCall?.method, 'getLocalTimezone');
    expect(observedCall?.arguments, isNull);
  });

  test('falls back when the plug-in channel is unavailable', () async {
    final environmentZone = normalizeDeviceIanaTimeZoneCandidate(
      Platform.environment['TZ'],
    );
    var expected = environmentZone;
    if (expected == null && Platform.isLinux) {
      try {
        expected = normalizeDeviceIanaTimeZoneCandidate(
          await File('/etc/timezone').readAsString(),
        );
      } on Object {
        expected = null;
      }
    }

    expect(await readDeviceIanaTimeZone(), expected);
  });

  test('accepts canonical slash zones and IANA UTC/GMT links', () {
    expect(
      normalizeDeviceIanaTimeZoneCandidate(' Europe/London\n'),
      'Europe/London',
    );
    expect(normalizeDeviceIanaTimeZoneCandidate('UTC'), 'UTC');
    expect(normalizeDeviceIanaTimeZoneCandidate('GMT'), 'GMT');
  });

  test('rejects blank values and ambiguous abbreviations', () {
    expect(normalizeDeviceIanaTimeZoneCandidate(null), isNull);
    expect(normalizeDeviceIanaTimeZoneCandidate('  '), isNull);
    expect(normalizeDeviceIanaTimeZoneCandidate('BST'), isNull);
  });
}
