import 'package:broker_contract/broker_contract.dart';

/// Thrown by `BrokerClient.patchUploadChunk` when the broker rejects a chunk
/// because the client-supplied `x-cosyncing-upload-offset` did not match the
/// server's current byte offset (HTTP 409 `UPLOAD_OFFSET_MISMATCH`).
///
/// The broker echoes the authoritative next byte offset in the error body
/// (as `expectedOffset`, and equivalently `offset`). Callers should resync
/// from [expectedOffset] and continue patching with the **same** `uploadId` -
/// the staging upload is still alive; only the client's offset was stale.
///
/// Governing doc: `docs/protocol/contract-sync.md`.
class UploadOffsetMismatchException implements Exception {
  /// Creates an [UploadOffsetMismatchException].
  const UploadOffsetMismatchException({
    required this.expectedOffset,
    this.statusCode,
    this.error,
    this.message = 'Upload offset mismatch',
  });

  /// The server-authoritative next byte offset to resume from, when present in
  /// the broker error body. May be `null` if the broker omitted the detail.
  final int? expectedOffset;

  /// The HTTP status code (expected to be 409).
  final int? statusCode;

  /// The parsed broker error, if available.
  final BrokerError? error;

  /// Human-readable detail.
  final String message;

  @override
  String toString() {
    final buffer = StringBuffer('UploadOffsetMismatchException: $message');
    if (statusCode != null) buffer.write(' (status: $statusCode)');
    if (expectedOffset != null) {
      buffer.write(' [expectedOffset: $expectedOffset]');
    }
    if (error?.error != null) buffer.write(' - ${error!.error}');
    return buffer.toString();
  }
}
