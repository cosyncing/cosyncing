import 'package:cosyncing_client/src/features/sessions/data/session_attachment_intake.dart';

/// Clipboard result captured for one owned native paste gesture.
sealed class SessionAttachmentClipboardRead {
  const SessionAttachmentClipboardRead();
}

/// Clipboard files or screenshot bytes to stage through A1.
final class SessionAttachmentClipboardFiles
    extends SessionAttachmentClipboardRead {
  /// Creates a file-bearing clipboard result.
  const SessionAttachmentClipboardFiles(this.items);

  /// Files in platform clipboard order.
  final List<SessionAttachmentIntakeItem> items;
}

/// Ordinary clipboard text that remains composer draft input.
final class SessionAttachmentClipboardText
    extends SessionAttachmentClipboardRead {
  /// Creates a text-only clipboard result.
  const SessionAttachmentClipboardText(this.text);

  /// Plain fallback text supplied by the platform.
  final String? text;
}

/// One browser paste event observed without claiming normal text paste.
abstract interface class SessionAttachmentWebPasteEvent {
  /// Stable identity used to reject duplicate delivery of the same DOM event.
  Object get identity;

  /// Whether this event contains real File objects, not text MIME aliases.
  bool get hasFiles;

  /// Prevents browser fallback and snapshots file handles synchronously.
  List<SessionAttachmentIntakeItem> claimFiles();

  /// Prevents browser fallback without retaining file handles.
  void rejectFiles();
}

/// Browser paste event callback.
typedef SessionAttachmentWebPasteListener =
    void Function(SessionAttachmentWebPasteEvent event);

/// Browser drag event phase observed by the composer-owned adapter.
enum SessionAttachmentWebDragPhase {
  /// Pointer entered the owned surface.
  enter,

  /// Pointer moved within the owned surface.
  over,

  /// Pointer left the owned surface.
  leave,

  /// Transfer was dropped on the owned surface.
  drop,
}

/// A browser drag snapshot that has not yet been claimed from normal content.
abstract interface class SessionAttachmentWebDropEvent {
  /// Stable DOM identity for duplicate-delivery rejection.
  Object get identity;

  /// Current drag phase.
  SessionAttachmentWebDragPhase get phase;

  /// Viewport coordinates used to prove exact composer ownership.
  double get clientX;

  /// Vertical viewport coordinate used to prove exact composer ownership.
  double get clientY;

  /// Whether the transfer exposes at least one local file item.
  bool get hasFiles;

  /// Whether any file item is a directory, checked without enumeration.
  bool get hasDirectory;

  /// Claims drag navigation while leaving file handles untouched.
  void acceptOperation();

  /// Rejects browser fallback without enumerating directory contents.
  void reject();

  /// Claims and snapshots only direct File objects.
  List<SessionAttachmentIntakeItem> claimFiles();
}

/// Browser drag event callback.
typedef SessionAttachmentWebDropListener =
    void Function(SessionAttachmentWebDropEvent event);

/// Clipboard boundary used only after an owned paste gesture.
abstract interface class SessionAttachmentClipboard {
  /// Whether this platform delivers clipboard files through browser events.
  bool get usesWebPasteEvents;

  /// Whether browser drag events arrive without plugin recursion.
  bool get usesWebDropEvents;

  /// Registers a browser paste observer. Native implementations are no-ops.
  void addWebPasteListener(SessionAttachmentWebPasteListener listener);

  /// Removes a browser paste observer. Native implementations are no-ops.
  void removeWebPasteListener(SessionAttachmentWebPasteListener listener);

  /// Registers an exact-surface browser drag observer.
  void addWebDropListener(SessionAttachmentWebDropListener listener);

  /// Removes a browser drag observer.
  void removeWebDropListener(SessionAttachmentWebDropListener listener);

  /// Reads one native clipboard snapshot after its owned keyboard gesture.
  ///
  /// [isActive] is consulted between bounded per-file operations so a
  /// cancelled, replaced, or expired gesture stops touching the filesystem.
  /// Throws [SessionAttachmentIntakeException] when the clipboard held files
  /// this composer refuses, and any other error when the probe itself failed
  /// and the clipboard contents remain unknown.
  Future<SessionAttachmentClipboardRead> readNative({
    bool Function()? isActive,
  });

  /// Reads only the plain-text representation of an already-owned gesture.
  ///
  /// Finishes an ordinary text paste whose chord this composer consumed before
  /// [readNative] failed. Never called speculatively.
  Future<String?> readNativeText();
}
