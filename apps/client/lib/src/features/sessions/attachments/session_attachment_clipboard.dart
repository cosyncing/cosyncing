import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_clipboard_native.dart'
    if (dart.library.js_interop) 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_clipboard_web.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_clipboard_types.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

export 'session_attachment_clipboard_types.dart';

/// Platform clipboard adapter, overrideable by deterministic widget tests.
final sessionAttachmentClipboardProvider = Provider<SessionAttachmentClipboard>(
  (ref) => createSessionAttachmentClipboard(),
);
