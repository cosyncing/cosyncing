import 'dart:convert';
import 'dart:typed_data';

import 'package:broker_contract/broker_contract.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';

/// Default broker chunked-upload cap; larger files are rejected before read.
const int sessionAttachmentMaxBytes = promptAttachmentMaxFileBytes;

/// Upload lifecycle for a session attachment.
enum SessionAttachmentUploadPhase {
  /// No attachment has been selected.
  idle,

  /// An attachment is selected but not currently uploading.
  selected,

  /// The selected attachment is being sent.
  uploading,

  /// The selected attachment was sent to the broker transport.
  sent,

  /// Sending failed; the same attachment can be retried.
  error,
}

/// Re-openable, range-readable bytes for a staged attachment.
///
/// The source is retained only in live composer/transfer state. It is never
/// serialized into drafts or the outbox, and it never crosses the broker
/// contract as a client filesystem path.
abstract interface class SessionAttachmentByteSource {
  /// Opens a byte stream for the half-open range `[start, end)`.
  Stream<List<int>> openRead({int start = 0, int? end});
}

/// Callback-backed attachment source used by platform adapters and tests.
final class CallbackSessionAttachmentByteSource
    implements SessionAttachmentByteSource {
  /// Creates a re-openable streaming source.
  const CallbackSessionAttachmentByteSource(this._openRead);

  final Stream<List<int>> Function({int start, int? end}) _openRead;

  @override
  Stream<List<int>> openRead({int start = 0, int? end}) =>
      _openRead(start: start, end: end);
}

/// Attachment payload ready for either an inline prompt or staged upload.
@immutable
class SessionAttachment {
  /// Creates a session attachment.
  const SessionAttachment({
    required this.name,
    required this.byteLength,
    this.data,
    this.byteSource,
    this.mimeType,
  }) : assert(
         (data != null) != (byteSource != null),
         'Provide exactly one inline payload or streaming byte source.',
       );

  /// Creates a large attachment backed by a re-openable chunk stream.
  factory SessionAttachment.streamed({
    required String name,
    required int byteLength,
    required Stream<List<int>> Function({int start, int? end}) openRead,
    String? mimeType,
  }) => SessionAttachment(
    name: name,
    byteLength: byteLength,
    byteSource: CallbackSessionAttachmentByteSource(openRead),
    mimeType: mimeType,
  );

  /// File name shown to the user and sent to the broker.
  final String name;

  /// Canonical base64 bytes for a bounded inline attachment only.
  final String? data;

  /// Live-only streaming source for a staged attachment.
  final SessionAttachmentByteSource? byteSource;

  /// Original byte length before base64 encoding.
  final int byteLength;

  /// Optional MIME type from the platform picker.
  final String? mimeType;

  /// Whether this payload is bounded inline data.
  bool get isInline => data != null;

  /// Opens the payload byte stream.
  ///
  /// Inline data is bounded by the inline limit and decoded on demand. Staged
  /// data is read from its re-openable source without whole-file retention.
  Stream<List<int>> openRead({int start = 0, int? end}) {
    final source = byteSource;
    if (source != null) {
      return source.openRead(start: start, end: end);
    }
    final bytes = base64Decode(data!);
    final safeEnd = end == null ? bytes.length : end.clamp(start, bytes.length);
    return Stream<List<int>>.value(
      Uint8List.sublistView(bytes, start, safeEnd),
    );
  }

  /// Human-readable size label.
  String get sizeLabel => byteLength == 1 ? '1 byte' : '$byteLength bytes';
}

/// Thrown when a selected attachment exceeds the send-over-WS size limit.
class SessionAttachmentTooLargeException implements Exception {
  /// Creates an exception for an oversized attachment.
  const SessionAttachmentTooLargeException({
    required this.fileName,
    required this.byteLength,
    required this.maxBytes,
  });

  /// Selected file name.
  final String fileName;

  /// Actual byte length.
  final int byteLength;

  /// Maximum permitted byte length.
  final int maxBytes;

  @override
  String toString() {
    return '$fileName is $byteLength bytes; maximum attachment size is '
        '$maxBytes bytes.';
  }
}

/// File-picking abstraction for one session attachment.
///
/// Kept internal to the adapter boundary so app UI code remains
/// testable without platform picker access.
// Injectable adapter boundaries intentionally use small interfaces.
// ignore: one_member_abstracts
abstract interface class SessionAttachmentFileSource {
  /// Picks files from platform UI in user-selected order.
  Future<List<SessionAttachmentSelectedFile>> pickFiles({
    required bool allowMultiple,
  });
}

/// Platform-agnostic representation of a selected file before encoding.
final class SessionAttachmentSelectedFile {
  /// Creates a selected file representation.
  const SessionAttachmentSelectedFile({
    required this.name,
    required this.path,
    required this.mimeType,
    required this.length,
    required this.openRead,
  });

  /// Candidate display name; may be empty before fallback resolution.
  final String name;

  /// Raw path used for file-name fallback.
  final String path;

  /// MIME type from platform selection.
  final String? mimeType;

  /// File length loader, used to reject oversized selections before reading.
  final Future<int> Function() length;

  /// Re-openable, range-readable byte stream.
  final Stream<List<int>> Function({int start, int? end}) openRead;
}

/// Production file source backed by `file_selector`.
final class FileSelectorSessionAttachmentSource
    implements SessionAttachmentFileSource {
  /// Creates a `file_selector`-backed file source.
  const FileSelectorSessionAttachmentSource();

  @override
  Future<List<SessionAttachmentSelectedFile>> pickFiles({
    required bool allowMultiple,
  }) async {
    final files = allowMultiple
        ? await openFiles()
        : <XFile>[if (await openFile() case final file?) file];
    return files
        .map(
          (file) => SessionAttachmentSelectedFile(
            name: file.name,
            path: file.path,
            mimeType: file.mimeType,
            length: file.length,
            openRead: ({int start = 0, int? end}) => file.openRead(start, end),
          ),
        )
        .toList(growable: false);
  }
}

/// File picker boundary for session attachments.
// Injectable adapter boundaries intentionally use small interfaces.
// ignore: one_member_abstracts
abstract interface class SessionAttachmentPicker {
  /// Picks and encodes attachments, or returns an empty list on cancellation.
  Future<List<SessionAttachment>> pickAttachments({bool allowMultiple = true});
}

/// Provides the production attachment picker.
final class FileSelectorSessionAttachmentPicker
    implements SessionAttachmentPicker {
  /// Creates a file-selector-backed picker.
  const FileSelectorSessionAttachmentPicker({
    this.maxBytes = sessionAttachmentMaxBytes,
    this.maxFiles = promptAttachmentMaxFiles,
    this.maxAggregateBytes = promptAttachmentMaxPromptBytes,
    this.source = const FileSelectorSessionAttachmentSource(),
  });

  /// Maximum bytes accepted before base64 encoding.
  final int maxBytes;

  /// Maximum files accepted from one picker transaction.
  final int maxFiles;

  /// Maximum decoded bytes retained across one picker transaction.
  final int maxAggregateBytes;

  /// Abstraction to provide an attachment file without app-level tests
  /// invoking platform UI.
  final SessionAttachmentFileSource source;

  @override
  Future<List<SessionAttachment>> pickAttachments({
    bool allowMultiple = true,
  }) async {
    final selectedFiles = await source.pickFiles(allowMultiple: allowMultiple);
    if (selectedFiles.isEmpty) {
      return const [];
    }
    if (selectedFiles.length > maxFiles) {
      throw SessionAttachmentTooLargeException(
        fileName: 'selection',
        byteLength: selectedFiles.length,
        maxBytes: maxFiles,
      );
    }

    final attachments = <SessionAttachment>[];
    var aggregateBytes = 0;
    for (final selectedFile in selectedFiles) {
      final fileName = _displayNameFor(selectedFile);
      final byteLength = await selectedFile.length();
      if (byteLength > maxBytes) {
        throw SessionAttachmentTooLargeException(
          fileName: fileName,
          byteLength: byteLength,
          maxBytes: maxBytes,
        );
      }
      aggregateBytes += byteLength;
      if (aggregateBytes > maxAggregateBytes) {
        throw SessionAttachmentTooLargeException(
          fileName: 'selection',
          byteLength: aggregateBytes,
          maxBytes: maxAggregateBytes,
        );
      }
      if (byteLength <= promptAttachmentInlineFileMaxBytes) {
        final bytes = await _readInlineBytes(selectedFile, byteLength);
        attachments.add(
          SessionAttachment(
            name: fileName,
            data: base64Encode(bytes),
            byteLength: byteLength,
            mimeType: selectedFile.mimeType,
          ),
        );
      } else {
        attachments.add(
          SessionAttachment.streamed(
            name: fileName,
            byteLength: byteLength,
            mimeType: selectedFile.mimeType,
            openRead: selectedFile.openRead,
          ),
        );
      }
    }
    return List.unmodifiable(attachments);
  }

  String _displayNameFor(SessionAttachmentSelectedFile file) {
    if (file.name.isNotEmpty) {
      return file.name;
    }
    final normalized = file.path.replaceAll(RegExp(r'\\'), '/');
    final lastSlash = normalized.lastIndexOf('/');
    if (lastSlash >= 0 && lastSlash + 1 < normalized.length) {
      return normalized.substring(lastSlash + 1);
    }
    return normalized.isEmpty ? 'attachment.bin' : normalized;
  }

  Future<Uint8List> _readInlineBytes(
    SessionAttachmentSelectedFile file,
    int expectedLength,
  ) async {
    final builder = BytesBuilder(copy: false);
    var received = 0;
    await for (final chunk in file.openRead(end: expectedLength)) {
      received += chunk.length;
      if (received > expectedLength) {
        throw StateError('Selected attachment grew while being read.');
      }
      builder.add(chunk);
    }
    if (received != expectedLength) {
      throw StateError('Selected attachment changed while being read.');
    }
    return builder.takeBytes();
  }
}
