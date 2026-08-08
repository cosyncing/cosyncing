import 'dart:convert';

/// Error shown when free-form command args conflict with the typed model
/// selector.
const sessionCommandModelArgError =
    'Remove "model" from command arguments. Use the model selector instead.';

/// Parsed command-argument editor state.
class SessionCommandArgsParseResult {
  const SessionCommandArgsParseResult._({
    required this.args,
    required this.error,
  });

  /// Creates a successful parse result.
  const SessionCommandArgsParseResult.success(Map<String, dynamic>? args)
    : this._(args: args, error: null);

  /// Creates a failed parse result.
  const SessionCommandArgsParseResult.failure(String error)
    : this._(args: null, error: error);

  /// Parsed command args. Empty editor input is represented as `null`.
  final Map<String, dynamic>? args;

  /// Validation error to show to the user.
  final String? error;
}

/// The wire key that carries a command's free-text argument.
///
/// `OutboundFrame.command` spreads the parsed args map into the command frame,
/// so `{'args': 'finish the report'}` lands as a string at `msg.args` — exactly
/// what the broker forwards to an adapter's `runCommand(name, args)`. This is
/// the same key the goal card already sends its free text under.
const sessionCommandDefaultArgKey = 'args';

/// Converts command defaults into readable editor text.
String formatSessionCommandArgs(Map<String, dynamic>? args) {
  if (args == null || args.isEmpty) {
    return '';
  }

  return const JsonEncoder.withIndent('  ').convert(args);
}

/// Whether [text] is an attempt at structured JSON rather than free text.
///
/// Only a leading `{`/`[` opts into the JSON path. That keeps real JSON typos
/// (`{"path":`) reporting a parse error instead of being silently shipped as
/// prose, while plain prose never has to be quoted or escaped.
bool _looksLikeJson(String text) =>
    text.startsWith('{') || text.startsWith('[');

/// Parses the command argument editor into a command args payload.
///
/// Two accepted shapes:
/// * A JSON object (`{"path": "/tmp"}`) — the advanced path, passed through
///   key-for-key.
/// * Anything else — free text, wrapped as [sessionCommandDefaultArgKey] so
///   `/goal set finish the report` works without quoting.
SessionCommandArgsParseResult parseSessionCommandArgs(
  String text, {
  bool hasModelOverride = false,
}) {
  final argsText = text.trim();
  if (argsText.isEmpty) {
    return const SessionCommandArgsParseResult.success(null);
  }

  if (!_looksLikeJson(argsText)) {
    return SessionCommandArgsParseResult.success({
      sessionCommandDefaultArgKey: argsText,
    });
  }

  try {
    final decoded = jsonDecode(argsText);
    if (decoded is Map && decoded.keys.every((key) => key is String)) {
      final args = decoded.cast<String, dynamic>();
      final modelArgError = validateSessionCommandModelArg(
        args,
        hasModelOverride: hasModelOverride,
      );
      return modelArgError == null
          ? SessionCommandArgsParseResult.success(args)
          : SessionCommandArgsParseResult.failure(modelArgError);
    }

    return const SessionCommandArgsParseResult.failure(
      'Command arguments must be a JSON object.',
    );
  } on FormatException {
    return const SessionCommandArgsParseResult.failure(
      'Invalid JSON for command arguments.',
    );
  } on Object {
    return const SessionCommandArgsParseResult.failure(
      'Command arguments could not be read. Check the JSON and try again.',
    );
  }
}

/// Returns a clear validation error when [args] contains the legacy `model`
/// key while the typed model selector is active.
String? validateSessionCommandModelArg(
  Map<String, dynamic>? args, {
  required bool hasModelOverride,
}) {
  if (hasModelOverride && (args?.containsKey('model') ?? false)) {
    return sessionCommandModelArgError;
  }
  return null;
}
