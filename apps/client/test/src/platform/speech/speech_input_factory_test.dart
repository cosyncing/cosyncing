import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_factory.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('createSpeechInputForPlatform web override', () {
    test('Linux + isWeb true uses adapter (Chromium on Linux host)', () {
      final fake = _FakeSpeechInput();
      final input = createSpeechInputForPlatform(
        isWeb: true,
        platform: TargetPlatform.linux,
        isSecureContext: true,
        createSupportedAdapter: () => fake,
      );
      expect(input, same(fake));
    });

    test('Linux + isWeb false returns unavailable without constructing', () {
      var adapterCalled = false;
      final input = createSpeechInputForPlatform(
        isWeb: false,
        platform: TargetPlatform.linux,
        isSecureContext: true,
        createSupportedAdapter: () {
          adapterCalled = true;
          return _FakeSpeechInput();
        },
      );
      expect(adapterCalled, isFalse);
      expect(input, isA<UnavailableSpeechInput>());
      expect(input.capabilities.recognition, isFalse);
    });

    test('Fuchsia + isWeb false returns unavailable without constructing', () {
      var adapterCalled = false;
      final input = createSpeechInputForPlatform(
        isWeb: false,
        platform: TargetPlatform.fuchsia,
        isSecureContext: true,
        createSupportedAdapter: () {
          adapterCalled = true;
          return _FakeSpeechInput();
        },
      );
      expect(adapterCalled, isFalse);
      expect(input, isA<UnavailableSpeechInput>());
    });
  });

  group('web secure context', () {
    test('insecure web origin returns unavailable without constructing', () {
      var adapterCalled = false;
      final input = createSpeechInputForPlatform(
        isWeb: true,
        platform: TargetPlatform.android,
        isSecureContext: false,
        createSupportedAdapter: () {
          adapterCalled = true;
          return _FakeSpeechInput();
        },
      );
      expect(adapterCalled, isFalse);
      expect(input, isA<UnavailableSpeechInput>());
      expect(input.current, isA<SpeechInputUnavailable>());
      expect(
        (input.current as SpeechInputUnavailable).reason,
        contains('secure'),
      );
      // The typed kind lets the UI localize (Chinese would otherwise get the
      // English fallback).
      expect(
        (input.current as SpeechInputUnavailable).kind,
        SpeechInputFailureKind.secureContext,
      );
    });

    test('secure web origin (HTTPS) uses adapter', () {
      final fake = _FakeSpeechInput();
      final input = createSpeechInputForPlatform(
        isWeb: true,
        platform: TargetPlatform.linux,
        isSecureContext: true,
        createSupportedAdapter: () => fake,
      );
      expect(input, same(fake));
    });

    test('loopback dev origin uses adapter when isSecureContext true', () {
      final fake = _FakeSpeechInput();
      final input = createSpeechInputForPlatform(
        isWeb: true,
        platform: TargetPlatform.windows,
        isSecureContext: true,
        createSupportedAdapter: () => fake,
      );
      expect(input, same(fake));
    });
  });

  group('native whitelist', () {
    test('Android uses adapter', () {
      final fake = _FakeSpeechInput();
      final input = createSpeechInputForPlatform(
        isWeb: false,
        platform: TargetPlatform.android,
        isSecureContext: true,
        createSupportedAdapter: () => fake,
      );
      expect(input, same(fake));
    });

    test('iOS uses adapter', () {
      final fake = _FakeSpeechInput();
      final input = createSpeechInputForPlatform(
        isWeb: false,
        platform: TargetPlatform.iOS,
        isSecureContext: true,
        createSupportedAdapter: () => fake,
      );
      expect(input, same(fake));
    });

    test('macOS uses adapter', () {
      final fake = _FakeSpeechInput();
      final input = createSpeechInputForPlatform(
        isWeb: false,
        platform: TargetPlatform.macOS,
        isSecureContext: true,
        createSupportedAdapter: () => fake,
      );
      expect(input, same(fake));
    });

    test('Windows (beta) uses adapter', () {
      final fake = _FakeSpeechInput();
      final input = createSpeechInputForPlatform(
        isWeb: false,
        platform: TargetPlatform.windows,
        isSecureContext: true,
        createSupportedAdapter: () => fake,
      );
      expect(input, same(fake));
    });
  });

  group('construction failure', () {
    test('sync construction failure degrades to unavailable', () {
      final input = createSpeechInputForPlatform(
        isWeb: false,
        platform: TargetPlatform.android,
        isSecureContext: true,
        createSupportedAdapter: () => throw Exception('plugin missing'),
      );
      expect(input, isA<UnavailableSpeechInput>());
    });

    test('web construction failure degrades to unavailable', () {
      final input = createSpeechInputForPlatform(
        isWeb: true,
        platform: TargetPlatform.linux,
        isSecureContext: true,
        createSupportedAdapter: () => throw Exception('web plugin missing'),
      );
      expect(input, isA<UnavailableSpeechInput>());
    });
  });

  group('UnavailableSpeechInput behavior', () {
    test('reports unavailable capabilities', () {
      const input = UnavailableSpeechInput('test reason');
      expect(input.capabilities, SpeechInputCapabilities.unavailable);
    });

    test('current state is unavailable with reason', () {
      const input = UnavailableSpeechInput('not supported');
      expect(input.current, isA<SpeechInputUnavailable>());
      expect((input.current as SpeechInputUnavailable).reason, 'not supported');
    });

    test('all methods are safe no-ops', () async {
      const input = UnavailableSpeechInput('test');
      await input.requestPermission();
      await input.start(policy: SpeechRecognitionPolicy.onDeviceOnly);
      await input.stop();
      await input.cancel();
      expect(input.consumeReady(), isNull);
      await input.dispose();
    });
  });
}

class _FakeSpeechInput implements SpeechInput {
  @override
  SpeechInputCapabilities get capabilities =>
      SpeechInputCapabilities.unavailable;

  @override
  SpeechInputState get current => const SpeechInputIdle();

  @override
  Stream<SpeechInputState> get states => const Stream.empty();

  @override
  Future<void> requestPermission() async {}

  @override
  Future<void> start({required SpeechRecognitionPolicy policy}) async {}

  @override
  Future<void> stop() async {}

  @override
  Future<void> cancel() async {}

  @override
  String? consumeReady() => null;

  @override
  Future<void> dispose() async {}
}
