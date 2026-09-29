/// Independent transcript choices; interface density never changes these.
class ConversationDisplayPreferences {
  /// Creates the approved conversation defaults.
  const ConversationDisplayPreferences({
    this.fontSize = 15,
    this.messageSpacing = 12,
    this.readingWidth = false,
  });

  /// Decodes persisted choices, validating each field independently.
  factory ConversationDisplayPreferences.fromJson(Map<String, dynamic> json) {
    final fontSize = json['fontSize'] is num
        ? (json['fontSize']! as num).toDouble()
        : null;
    final spacing = json['messageSpacing'] is num
        ? (json['messageSpacing']! as num).toDouble()
        : null;
    return ConversationDisplayPreferences(
      fontSize: const [14.0, 15.0, 17.0, 19.0].contains(fontSize)
          ? fontSize!
          : 15,
      messageSpacing: const [8.0, 12.0, 20.0].contains(spacing) ? spacing! : 12,
      readingWidth: json['readingWidth'] == true,
    );
  }

  /// Conversation text size before the user's accessibility text scaling.
  final double fontSize;

  /// Vertical separation between messages.
  final double messageSpacing;

  /// Whether long transcripts use a 900 logical pixel reading width.
  final bool readingWidth;

  /// Returns an updated set of choices.
  ConversationDisplayPreferences copyWith({
    double? fontSize,
    double? messageSpacing,
    bool? readingWidth,
  }) => ConversationDisplayPreferences(
    fontSize: fontSize ?? this.fontSize,
    messageSpacing: messageSpacing ?? this.messageSpacing,
    readingWidth: readingWidth ?? this.readingWidth,
  );

  /// Encodes only display choices; no session data is stored here.
  Map<String, dynamic> toJson() => {
    'fontSize': fontSize,
    'messageSpacing': messageSpacing,
    'readingWidth': readingWidth,
  };
}
