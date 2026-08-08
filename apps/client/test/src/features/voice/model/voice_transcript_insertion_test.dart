import 'package:cosyncing_client/src/features/voice/model/voice_transcript_insertion.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('insertVoiceTranscript', () {
    test('inserts at a collapsed caret with boundary spacing', () {
      const current = TextEditingValue(
        text: 'beforeafter',
        selection: TextSelection.collapsed(offset: 6),
      );

      final result = insertVoiceTranscript(current, ' dictated text ');

      expect(result.text, 'before dictated text after');
      expect(result.selection.baseOffset, 20);
    });

    test('replaces a selected range', () {
      const current = TextEditingValue(
        text: 'keep replace tail',
        selection: TextSelection(baseOffset: 5, extentOffset: 12),
      );

      final result = insertVoiceTranscript(current, 'spoken');

      expect(result.text, 'keep spoken tail');
      expect(result.selection.baseOffset, 11);
    });

    test('appends when the selection is invalid', () {
      const current = TextEditingValue(text: 'draft');

      final result = insertVoiceTranscript(current, 'more');

      expect(result.text, 'draft more');
      expect(result.selection.baseOffset, result.text.length);
    });

    test('does not alter the draft for a blank transcript', () {
      const current = TextEditingValue(
        text: 'draft',
        selection: TextSelection.collapsed(offset: 2),
      );

      expect(insertVoiceTranscript(current, '  \n '), current);
    });
  });
}
