/// One plain-text utterance produced by the `SpeechTextCompiler` and handed to
/// a `SpeechOutput` synthesizer.
///
/// Each utterance is a clean cancellation boundary: the read-aloud controller
/// can stop between utterances. Long sentences or unbreakable tokens may be
/// split across boundaries to respect the maximum chunk length, so a boundary
/// does not guarantee a sentence edge. The synthesizer never receives raw
/// Markdown, message JSON, or arbitrary broker payloads - only these plain-text
/// chunks.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Speakable-text policy").
class SpeechUtterance {
  /// Creates a bounded plain-text utterance.
  const SpeechUtterance(this.text, {this.kind = SpeechUtteranceKind.prose});

  /// The speakable plain text. Never raw Markdown or JSON.
  final String text;

  /// Whether this chunk is ordinary prose or a documented omission marker such
  /// as "Code block omitted". Both are spoken as text; the kind lets a future
  /// adapter treat markers distinctly (e.g. lower rate) without re-parsing.
  final SpeechUtteranceKind kind;
}

/// The kind of a [SpeechUtterance].
enum SpeechUtteranceKind {
  /// Normal prose, headings, or list items in document order.
  prose,

  /// A short documented marker replacing an omitted code/table block.
  omissionMarker,
}
