import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The workspace pane that owns keyboard input, shortcuts and the composer.
///
/// Exactly one at a time — that is what separates it from
/// `visibleAttentionSessionsProvider`, which is a set. "Focused" and "visible"
/// were one `activeKey` until the split pane needed them apart: a pane can be
/// on screen, ticking and suppressing its own notifications while a different
/// pane takes the keystrokes.
///
/// The value is a `SessionRef.key`, because every pane is a session pane at
/// this commit. The `WorkspacePaneKey` migration replaces the `String` without
/// changing what the provider means.
///
/// Null means no pane holds focus — an empty workspace, or a navigation branch
/// that is offstage.
final focusedPaneProvider = StateProvider<String?>((_) => null);
