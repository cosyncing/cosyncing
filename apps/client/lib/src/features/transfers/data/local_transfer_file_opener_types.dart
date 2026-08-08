import 'package:flutter/foundation.dart';

/// Outcomes for transfer file action attempts.
enum LocalTransferFileActionOutcome {
  /// Action completed successfully.
  success,

  /// Action is not supported on the current platform.
  unsupported,

  /// Action failed because the command or launcher returned an error.
  failed,
}

/// Result of an attempt to open a local transfer file or folder.
@immutable
class LocalTransferFileActionResult {
  const LocalTransferFileActionResult._({
    required this.outcome,
    this.message = '',
  });

  /// Convenience constructor for success.
  const LocalTransferFileActionResult.success()
    : this._(outcome: LocalTransferFileActionOutcome.success);

  /// Convenience constructor for unsupported platforms.
  const LocalTransferFileActionResult.unsupported(String message)
    : this._(
        outcome: LocalTransferFileActionOutcome.unsupported,
        message: message,
      );

  /// Convenience constructor for failures.
  const LocalTransferFileActionResult.failed(String message)
    : this._(outcome: LocalTransferFileActionOutcome.failed, message: message);

  /// Action outcome.
  final LocalTransferFileActionOutcome outcome;

  /// Diagnostic detail for failures/unsupported states.
  ///
  /// Views must not render this in their primary path. Platform launchers may
  /// include command output or exception text here; use localized outcome copy
  /// for the user-facing message.
  final String message;

  /// Whether the action succeeded.
  bool get isSuccess => outcome == LocalTransferFileActionOutcome.success;

  /// Whether the action is unsupported.
  bool get isUnsupported =>
      outcome == LocalTransferFileActionOutcome.unsupported;

  /// Whether the action failed for reasons other than unsupported.
  bool get isFailure => outcome == LocalTransferFileActionOutcome.failed;
}

/// Outcomes for transfer text preview attempts.
enum LocalTransferTextPreviewOutcome {
  /// Preview text was successfully read.
  success,

  /// File content is unsupported on this platform.
  unsupported,

  /// File content appears to be binary and cannot be previewed as text.
  binary,

  /// Action failed because a read/write exception occurred.
  failed,
}

/// Result of a bounded local text preview attempt.
@immutable
class LocalTransferTextPreviewResult {
  const LocalTransferTextPreviewResult._({
    required this.outcome,
    required this.content,
    required this.isTruncated,
    this.message = '',
  });

  /// Convenience constructor for a successful preview.
  const LocalTransferTextPreviewResult.success(
    String content, {
    required bool isTruncated,
  }) : this._(
         outcome: LocalTransferTextPreviewOutcome.success,
         content: content,
         isTruncated: isTruncated,
       );

  /// Convenience constructor for unsupported platforms.
  const LocalTransferTextPreviewResult.unsupported(String message)
    : this._(
        outcome: LocalTransferTextPreviewOutcome.unsupported,
        content: '',
        isTruncated: false,
        message: message,
      );

  /// Convenience constructor for binary content.
  const LocalTransferTextPreviewResult.binary(String message)
    : this._(
        outcome: LocalTransferTextPreviewOutcome.binary,
        content: '',
        isTruncated: false,
        message: message,
      );

  /// Convenience constructor for failures.
  const LocalTransferTextPreviewResult.failed(String message)
    : this._(
        outcome: LocalTransferTextPreviewOutcome.failed,
        content: '',
        isTruncated: false,
        message: message,
      );

  /// Preview outcome.
  final LocalTransferTextPreviewOutcome outcome;

  /// Read text content, if available.
  final String content;

  /// Whether more bytes were available than read.
  final bool isTruncated;

  /// Diagnostic detail for unsupported/failure states.
  ///
  /// Views must map [outcome] to localized primary copy instead of rendering
  /// this value directly.
  final String message;

  /// Whether the preview succeeded.
  bool get isSuccess => outcome == LocalTransferTextPreviewOutcome.success;

  /// Whether the preview is unsupported.
  bool get isUnsupported =>
      outcome == LocalTransferTextPreviewOutcome.unsupported;

  /// Whether the preview content appears binary.
  bool get isBinary => outcome == LocalTransferTextPreviewOutcome.binary;

  /// Whether the preview failed for reasons other than unsupported/binary.
  bool get isFailure => outcome == LocalTransferTextPreviewOutcome.failed;
}

/// Abstraction for local transfer file operations.
abstract interface class LocalTransferFileOpener {
  /// Opens a local file in the OS default application.
  Future<LocalTransferFileActionResult> openFile(String localPath);

  /// Reveals the local file inside its parent folder.
  Future<LocalTransferFileActionResult> revealInFolder(String localPath);

  /// Reads a bounded preview of local text content.
  Future<LocalTransferTextPreviewResult> previewTextFile(
    String localPath, {
    int maxBytes = 64 * 1024,
  });
}
