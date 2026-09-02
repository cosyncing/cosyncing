import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The workspace pane that owns keyboard input, shortcuts and the composer.
///
/// Exactly one at a time — that is what separates it from
/// `visibleAttentionSessionsProvider`, which is a set. "Focused" and "visible"
/// were one `activeKey` until the split pane needed them apart: a pane can be
/// on screen, ticking and suppressing its own notifications while a different
/// pane takes the keystrokes.
///
/// The value is a `WorkspacePaneKey.key`: a session pane's while the
/// transcript holds focus, a file pane's once the reader clicks into the
/// second pane. `workspacePaneSessionKey` recovers the session from either,
/// which is what the prompt-target signals read — a focused file does not move
/// where typing goes, and both surfaces say so rather than leaving the reader
/// to find out by pressing a key.
///
/// Null means no pane holds focus — an empty workspace, or a navigation branch
/// that is offstage.
final focusedPaneProvider = StateProvider<String?>((_) => null);

/// Claims workspace focus on a pointer down, and marks it while it holds.
///
/// The mark is a 2dp hairline across the pane's top edge, not an outline
/// around it: a pane already sits between two sashes, and four edges of accent
/// on top of that reads as a selected control rather than as "this is where
/// your keystrokes land".
class WorkspaceFocusablePane extends ConsumerWidget {
  /// Wraps [child] as the pane addressed by [paneKey].
  const WorkspaceFocusablePane({
    required this.paneKey,
    required this.child,
    this.enabled = true,
    super.key,
  });

  /// Thickness of the focus hairline.
  static const double hairlineHeight = 2;

  /// The `WorkspacePaneKey.key` this pane publishes when it takes focus, or
  /// null when there is no pane here to focus (an empty workspace).
  final String? paneKey;

  /// Whether the signal is drawn at all.
  ///
  /// False with one pane on screen. A hairline that is always lit names
  /// nothing — there is no second pane it could be distinguishing this one
  /// from — and permanent chrome is exactly the decoration the design's
  /// no-legend rule rejects. Focus is still claimed, so it is already correct
  /// the moment a file pane appears.
  final bool enabled;

  /// The pane content.
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final key = paneKey;
    final focused =
        enabled && key != null && ref.watch(focusedPaneProvider) == key;
    final pane = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: hairlineHeight,
          child: ColoredBox(
            key: focused ? Key('workspace-focus-hairline-$key') : null,
            color: focused ? context.tokens.accent : Colors.transparent,
          ),
        ),
        Expanded(child: child),
      ],
    );
    if (key == null) return pane;
    return Listener(
      // Pointer-down rather than a tap: focus has to move before the press
      // reaches whatever was clicked, and a translucent listener sees the
      // event without taking it, so the control underneath still gets it.
      behavior: HitTestBehavior.translucent,
      onPointerDown: (_) {
        final notifier = ref.read(focusedPaneProvider.notifier);
        if (notifier.state != key) notifier.state = key;
      },
      child: pane,
    );
  }
}
