import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:typed_data';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/services.dart';

/// Longest one platform transfer operation may block composer intake.
const Duration sessionAttachmentIntakeTimeout = Duration(seconds: 10);

/// Maximum gestures that may retain source ownership at once.
const int sessionAttachmentMaxPendingGestures = 8;

/// Largest file-list snapshot needed to prove A1 selection overflow.
const int sessionAttachmentMaxSnapshotFiles = promptAttachmentMaxFiles + 1;

/// Platform events remembered for duplicate-delivery rejection.
const int sessionAttachmentEventMemoryCapacity = 32;

/// Largest decoded clipboard image the platform may encode on our behalf.
///
/// Distinct from [promptAttachmentMaxFileBytes], which bounds the *file* A1
/// would accept. macOS and Linux hand back PNG, and no pixel count predicts
/// how well an image compresses — a 20 MP screenshot can encode to a few MB —
/// so comparing decoded pixels against a file-size budget would refuse
/// ordinary screenshots. This is the other limit: what the platform plugin may
/// allocate before the encoded length is known. Set well past any real
/// screenshot (512 MiB admits roughly 134 megapixels at 4 bytes each) and far
/// below what an unbounded read would let a hostile clipboard demand.
const int sessionAttachmentMaxDecodedImageBytes = 512 * 1024 * 1024;

/// Bounded FIFO memory that admits each platform event identity exactly once.
///
/// Every intake path — native paste, browser paste, native drop, browser drop —
/// shares this so a long-lived session cannot retain unbounded event objects
/// (a browser `DragEvent` keeps its `DataTransfer` and file handles alive).
final class SessionAttachmentEventMemory {
  /// Creates a memory bounded at [capacity] identities.
  SessionAttachmentEventMemory({
    this.capacity = sessionAttachmentEventMemoryCapacity,
  }) : assert(capacity > 0, 'capacity must retain at least one identity');

  /// Maximum identities retained before the oldest is evicted.
  final int capacity;

  final Set<Object> _identities = HashSet.identity();
  final Queue<Object> _order = Queue<Object>();

  /// Identities currently retained; never exceeds [capacity].
  int get length => _order.length;

  /// Whether [identity] was already admitted and is still remembered.
  bool contains(Object identity) => _identities.contains(identity);

  /// Records [identity], returning `false` when it was already admitted.
  bool admit(Object identity) {
    if (!_identities.add(identity)) return false;
    _order.addLast(identity);
    if (_order.length > capacity) _identities.remove(_order.removeFirst());
    return true;
  }
}

/// Applies the plain-text fallback of a non-file paste like EditableText does.
///
/// Active IME composition and invalid selections remain untouched so the
/// platform editor keeps ownership of those gestures.
TextEditingValue applySessionComposerTextPaste(
  TextEditingValue value,
  String text,
) {
  final composing = value.composing;
  if (!value.selection.isValid ||
      (composing.isValid && !composing.isCollapsed)) {
    return value;
  }
  final selection = value.selection;
  return value
      .replaced(selection, text)
      .copyWith(
        selection: TextSelection.collapsed(
          offset: selection.start + text.length,
        ),
        composing: TextRange.empty,
      );
}

/// Maps [offset] in [before] onto the same logical point in [after].
///
/// A consumed paste chord may resolve after the user has typed, so the caret
/// it was made against no longer describes the live document. Treating the
/// difference as one contiguous edit — the common prefix and suffix pin it —
/// keeps the paste at the point the user actually pasted instead of trailing
/// whatever they typed since.
///
/// Returns `null` when the edit covers [offset] itself, which is the one case
/// where the paste point genuinely no longer exists.
int? mapSessionComposerOffset(String before, String after, int offset) {
  if (before == after) return offset;
  final shortest = before.length < after.length ? before.length : after.length;
  var prefix = 0;
  while (prefix < shortest &&
      before.codeUnitAt(prefix) == after.codeUnitAt(prefix)) {
    prefix += 1;
  }
  var suffix = 0;
  while (suffix < shortest - prefix &&
      before.codeUnitAt(before.length - 1 - suffix) ==
          after.codeUnitAt(after.length - 1 - suffix)) {
    suffix += 1;
  }
  if (offset <= prefix) return offset;
  final replacedEnd = before.length - suffix;
  if (offset >= replacedEnd) return offset + after.length - before.length;
  return null;
}

/// One rejected or unreadable desktop attachment representation.
final class SessionAttachmentIntakeException implements Exception {
  /// Creates a classified intake failure.
  const SessionAttachmentIntakeException(this.reason);

  /// Stable diagnostic classification; never shown directly to users.
  final String reason;

  @override
  String toString() => 'SessionAttachmentIntakeException($reason)';
}

/// Re-openable file offered by a clipboard or drag/drop platform adapter.
abstract interface class SessionAttachmentIntakeItem {
  /// Safe display name.
  String get name;

  /// Best available media type.
  String? get mimeType;

  /// Byte length checked before payload reads.
  int get byteLength;

  /// Opens a fresh stream over the half-open range `[start, end)`.
  Stream<List<int>> openRead({int start = 0, int? end});
}

/// Callback-backed file shared by native clipboard, web clipboard, and drop.
final class CallbackSessionAttachmentIntakeItem
    implements SessionAttachmentIntakeItem {
  /// Creates a validated platform file representation.
  CallbackSessionAttachmentIntakeItem({
    required String name,
    required this.byteLength,
    required this.openReadCallback,
    this.currentByteLength,
    this.mimeType,
  }) : name = safeSessionAttachmentDisplayName(name, mimeType: mimeType);

  @override
  final String name;

  @override
  final int byteLength;

  @override
  final String? mimeType;

  /// Opens byte ranges for materialization.
  final Stream<List<int>> Function({int start, int? end}) openReadCallback;

  /// Optional recheck used to catch a native file that changed mid-read.
  ///
  /// Asynchronous on purpose: a synchronous stat of a UNC path or a slow
  /// network mount blocks the UI isolate for as long as the mount takes, and
  /// no timeout can interrupt it. The materializer bounds this call instead.
  final Future<int> Function()? currentByteLength;

  @override
  Stream<List<int>> openRead({int start = 0, int? end}) =>
      openReadCallback(start: start, end: end);
}

/// In-memory screenshot bytes captured from a clipboard gesture.
final class MemorySessionAttachmentIntakeItem
    implements SessionAttachmentIntakeItem {
  /// Creates a bounded memory-backed item.
  MemorySessionAttachmentIntakeItem({
    required this.bytes,
    String name = '',
    this.mimeType = 'image/png',
  }) : name = safeSessionAttachmentDisplayName(name, mimeType: mimeType);

  /// Captured screenshot bytes, bounded by A1 before staging.
  final Uint8List bytes;

  @override
  final String name;

  @override
  int get byteLength => bytes.length;

  @override
  final String? mimeType;

  @override
  Stream<List<int>> openRead({int start = 0, int? end}) {
    final safeEnd = end == null ? bytes.length : end.clamp(start, bytes.length);
    return Stream.value(Uint8List.sublistView(bytes, start, safeEnd));
  }
}

/// Converts platform transfer items into the exact payload A1 admits.
final class SessionAttachmentIntakeMaterializer {
  /// Creates the stateless materializer.
  const SessionAttachmentIntakeMaterializer({
    this.timeout = sessionAttachmentIntakeTimeout,
  });

  /// Maximum time allowed for one bounded inline stream read.
  final Duration timeout;

  /// Materializes adapter-neutral items in platform order.
  Future<List<SessionAttachment>> materialize(
    Iterable<SessionAttachmentIntakeItem> items,
  ) async {
    final attachments = <SessionAttachment>[];
    var aggregateBytes = 0;
    for (final item in items) {
      final byteLength = item.byteLength;
      if (byteLength < 0 || byteLength > promptAttachmentMaxFileBytes) {
        throw const SessionAttachmentIntakeException('file-size');
      }
      aggregateBytes += byteLength;
      if (attachments.length >= promptAttachmentMaxFiles ||
          aggregateBytes > promptAttachmentMaxPromptBytes) {
        throw const SessionAttachmentIntakeException('selection-size');
      }
      if (byteLength <= promptAttachmentInlineFileMaxBytes) {
        final bytes = await _readExactWithCancellation(
          item.openRead(end: byteLength),
          byteLength,
          timeout,
        );
        if (item case CallbackSessionAttachmentIntakeItem(
          currentByteLength: final recheck?,
        )) {
          final current = await recheck().timeout(timeout);
          if (current != byteLength) {
            throw const SessionAttachmentIntakeException(
              'changed-during-read',
            );
          }
        }
        attachments.add(
          SessionAttachment(
            name: item.name,
            byteLength: byteLength,
            data: base64Encode(bytes),
            mimeType: item.mimeType,
          ),
        );
      } else {
        attachments.add(
          SessionAttachment.streamed(
            name: item.name,
            byteLength: byteLength,
            mimeType: item.mimeType,
            openRead: ({int start = 0, int? end}) => item.openRead(
              start: start,
              end: end ?? byteLength,
            ),
          ),
        );
      }
    }
    if (attachments.isEmpty) {
      throw const SessionAttachmentIntakeException('unsupported');
    }
    return List.unmodifiable(attachments);
  }
}

/// Produces a safe leaf name without retaining a source path.
String safeSessionAttachmentDisplayName(
  String candidate, {
  String? mimeType,
}) {
  final normalized = candidate.replaceAll(RegExp(r'\\'), '/');
  final leaf = normalized
      .split('/')
      .last
      .trim()
      .replaceAll(RegExp(r'[\x00-\x1f\x7f]'), '');
  if (leaf.isNotEmpty) {
    return leaf.length <= 255 ? leaf : leaf.substring(0, 255);
  }
  return mimeType == 'image/png' ? 'screenshot.png' : 'attachment.bin';
}

Future<Uint8List> _readExactWithCancellation(
  Stream<List<int>> source,
  int expected,
  Duration timeout,
) {
  final completer = Completer<Uint8List>();
  final builder = BytesBuilder(copy: false);
  StreamSubscription<List<int>>? subscription;
  Timer? timer;
  var received = 0;

  void fail(Object error, [StackTrace? stackTrace]) {
    if (completer.isCompleted) return;
    timer?.cancel();
    unawaited(subscription?.cancel());
    completer.completeError(error, stackTrace);
  }

  subscription = source.listen(
    (chunk) {
      received += chunk.length;
      if (received > expected) {
        fail(const SessionAttachmentIntakeException('changed-during-read'));
        return;
      }
      builder.add(chunk);
    },
    onError: fail,
    onDone: () {
      if (completer.isCompleted) return;
      timer?.cancel();
      if (received != expected) {
        completer.completeError(
          const SessionAttachmentIntakeException('changed-during-read'),
        );
      } else {
        completer.complete(builder.takeBytes());
      }
    },
    cancelOnError: true,
  );
  timer = Timer(timeout, () {
    fail(const SessionAttachmentIntakeException('read-timeout'));
  });
  return completer.future;
}
