import 'package:flutter/services.dart';

/// Inserts a recognized transcript into an editable composer value.
///
/// A selected range is replaced; a collapsed selection receives the text at
/// the caret; an invalid selection appends it. Boundary spaces are introduced
/// only when needed. This helper never submits the resulting draft.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Composer UX").
TextEditingValue insertVoiceTranscript(
  TextEditingValue current,
  String transcript,
) {
  final recognized = transcript.trim();
  if (recognized.isEmpty) return current;

  final text = current.text;
  final selection = current.selection;
  final selectionIsUsable =
      selection.isValid && selection.start >= 0 && selection.end <= text.length;
  final start = selectionIsUsable ? selection.start : text.length;
  final end = selectionIsUsable ? selection.end : text.length;
  final before = text.substring(0, start);
  final after = text.substring(end);
  final prefix =
      before.isNotEmpty && !_isWhitespace(before.codeUnitAt(before.length - 1))
      ? ' '
      : '';
  final suffix = after.isNotEmpty && !_isWhitespace(after.codeUnitAt(0))
      ? ' '
      : '';

  return TextEditingValue(
    text: '$before$prefix$recognized$suffix$after',
    selection: TextSelection.collapsed(
      offset: before.length + prefix.length + recognized.length,
    ),
  );
}

bool _isWhitespace(int codeUnit) {
  return codeUnit == 0x20 ||
      codeUnit == 0x09 ||
      codeUnit == 0x0A ||
      codeUnit == 0x0D;
}
