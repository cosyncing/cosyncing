import 'package:flutter_test/flutter_test.dart';

/// Finds text that a renderer composed as spans rather than a plain `Text`.
///
/// Bounded structured rows (the tool fallback, truncated preview lines) render
/// through `Text.rich`, which `find.text` skips unless asked for rich text.
Finder richTextFinder(String text) => find.text(text, findRichText: true);
