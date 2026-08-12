import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_factory.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('createSpeechOutputForPlatform web override', () {
    test('Linux + isWeb true uses the adapter (Chromium on Linux host)', () {
      final fake = _FakeSpeechOutput();
      final output = createSpeechOutputForPlatform(
        isWeb: true,
        platform: TargetPlatform.linux,
        createSupportedAdapter: () => fake,
      );

      expect(output, same(fake));
    });

    test('Linux + isWeb false returns unavailable without calling adapter', () {
      var adapterCalled = false;
      final output = createSpeechOutputForPlatform(
        isWeb: false,
        platform: TargetPlatform.linux,
        createSupportedAdapter: () {
          adapterCalled = true;
          return _FakeSpeechOutput();
        },
      );

      expect(adapterCalled, isFalse);
      expect(output, isA<UnavailableSpeechOutput>());
      expect(output.capabilities.synthesis, isFalse);
    });

    test(
      'Fuchsia + isWeb false returns unavailable without calling adapter',
      () {
        var adapterCalled = false;
        final output = createSpeechOutputForPlatform(
          isWeb: false,
          platform: TargetPlatform.fuchsia,
          createSupportedAdapter: () {
            adapterCalled = true;
            return _FakeSpeechOutput();
          },
        );

        expect(adapterCalled, isFalse);
        expect(output, isA<UnavailableSpeechOutput>());
      },
    );

    test('Fuchsia + isWeb true uses the adapter', () {
      final fake = _FakeSpeechOutput();
      final output = createSpeechOutputForPlatform(
        isWeb: true,
        platform: TargetPlatform.fuchsia,
        createSupportedAdapter: () => fake,
      );

      expect(output, same(fake));
    });
  });

  group('createSpeechOutputForPlatform native whitelist', () {
    test('Android uses the adapter', () {
      final fake = _FakeSpeechOutput();
      final output = createSpeechOutputForPlatform(
        isWeb: false,
        platform: TargetPlatform.android,
        createSupportedAdapter: () => fake,
      );

      expect(output, same(fake));
    });

    test('iOS uses the adapter', () {
      final fake = _FakeSpeechOutput();
      final output = createSpeechOutputForPlatform(
        isWeb: false,
        platform: TargetPlatform.iOS,
        createSupportedAdapter: () => fake,
      );

      expect(output, same(fake));
    });

    test('macOS uses the adapter', () {
      final fake = _FakeSpeechOutput();
      final output = createSpeechOutputForPlatform(
        isWeb: false,
        platform: TargetPlatform.macOS,
        createSupportedAdapter: () => fake,
      );

      expect(output, same(fake));
    });

    test('Windows uses the adapter', () {
      final fake = _FakeSpeechOutput();
      final output = createSpeechOutputForPlatform(
        isWeb: false,
        platform: TargetPlatform.windows,
        createSupportedAdapter: () => fake,
      );

      expect(output, same(fake));
    });

    test(
      'construction failure on supported native degrades to unavailable',
      () {
        final output = createSpeechOutputForPlatform(
          isWeb: false,
          platform: TargetPlatform.android,
          createSupportedAdapter: () =>
              throw Exception('FlutterTts construction failed'),
        );

        expect(output, isA<UnavailableSpeechOutput>());
        expect(output.capabilities.synthesis, isFalse);
      },
    );

    test('construction failure on web degrades to unavailable', () {
      final output = createSpeechOutputForPlatform(
        isWeb: true,
        platform: TargetPlatform.linux,
        createSupportedAdapter: () =>
            throw Exception('FlutterTts construction failed'),
      );

      expect(output, isA<UnavailableSpeechOutput>());
    });
  });

  group('UnavailableSpeechOutput', () {
    test('reports no capabilities and never speaks', () async {
      const output = UnavailableSpeechOutput();
      expect(output.capabilities.synthesis, isFalse);
      expect(output.capabilities.pauseResume, isFalse);
      expect(output.current, isA<SpeechOutputIdle>());
      await output.speak(
        messageKey: 'm1',
        utterances: const [SpeechUtterance('hi')],
      );
    });

    test('dispose is a no-op', () async {
      const output = UnavailableSpeechOutput();
      await output.dispose();
      await output.dispose();
    });
  });
}

class _FakeSpeechOutput implements SpeechOutput {
  @override
  SpeechOutputCapabilities get capabilities => const SpeechOutputCapabilities(
    synthesis: true,
    pauseResume: false,
    installedLanguageVoiceAvailability: true,
  );

  @override
  SpeechOutputState get current => const SpeechOutputIdle();

  @override
  Stream<SpeechOutputState> get states => const Stream.empty();

  @override
  Future<void> speak({
    required String messageKey,
    required List<SpeechUtterance> utterances,
  }) async {}

  @override
  Future<void> setRate(double rate) async {}

  @override
  Future<void> pause() async {}

  @override
  Future<void> resume() async {}

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() async {}
}
