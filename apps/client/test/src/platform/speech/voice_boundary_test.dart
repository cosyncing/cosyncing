import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Boundary test: no speech_to_text import outside lib/src/platform/speech,
/// and no audio/broker transport coupling in the voice feature.
void main() {
  final libDir = Directory('lib/src');

  test('no speech_to_text import outside lib/src/platform/speech', () {
    final violations = <String>[];
    for (final entity in libDir.listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      // The platform/speech directory is the only allowed location.
      if (entity.path.contains('platform/speech/')) continue;
      final content = entity.readAsStringSync();
      if (content.contains('package:speech_to_text/') ||
          content.contains("package:speech_to_text'")) {
        violations.add(entity.path);
      }
    }
    expect(
      violations,
      isEmpty,
      reason:
          'speech_to_text must not be imported outside '
          'lib/src/platform/speech/. Found in: $violations',
    );
  });

  test('no flutter_tts import outside lib/src/platform/speech', () {
    final violations = <String>[];
    for (final entity in libDir.listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      if (entity.path.contains('platform/speech/')) continue;
      final content = entity.readAsStringSync();
      if (content.contains('package:flutter_tts/') ||
          content.contains("package:flutter_tts'")) {
        violations.add(entity.path);
      }
    }
    expect(
      violations,
      isEmpty,
      reason:
          'flutter_tts must not be imported outside '
          'lib/src/platform/speech/. Found in: $violations',
    );
  });

  test('voice feature does not import broker client or transport', () {
    final voiceDir = Directory('lib/src/features/voice');
    if (!voiceDir.existsSync()) return;
    final violations = <String>[];
    for (final entity in voiceDir.listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      final content = entity.readAsStringSync();
      if (content.contains('package:broker_client/') ||
          content.contains('dart:io') ||
          content.contains('WebSocket') ||
          content.contains('HttpClient')) {
        violations.add(entity.path);
      }
    }
    expect(
      violations,
      isEmpty,
      reason:
          'Voice feature must not import broker client, dart:io, '
          'WebSocket, or HttpClient. Found in: $violations',
    );
  });

  test('no audio bytes cross broker boundaries', () {
    // Verify that no broker_contract or broker_client source references
    // audio, microphone, or speech recognition.
    for (final pkgDir in [
      '../../packages/dart/broker_contract',
      '../../packages/dart/broker_client',
    ]) {
      final dir = Directory('$pkgDir/lib');
      if (!dir.existsSync()) continue;
      for (final entity in dir.listSync(recursive: true)) {
        if (entity is! File || !entity.path.endsWith('.dart')) continue;
        final content = entity.readAsStringSync();
        expect(
          content.toLowerCase(),
          isNot(contains('audiobytes')),
          reason: '${entity.path} must not reference audio bytes',
        );
        expect(
          content.toLowerCase(),
          isNot(contains('microphone')),
          reason: '${entity.path} must not reference microphone',
        );
      }
    }
  });
}
