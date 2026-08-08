import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/widgets.dart';

/// Blocks every pointer and keyboard interaction while this tab is inside a
/// web-update commit window (N3b).
///
/// Between this tab reporting `done` and the coordinator sending `go`, several
/// seconds pass. The commit snapshot proved every registered surface safe, but
/// a verified-empty field is still an editable field, and an editor opened
/// after the snapshot was never asked at all. Only a lock above the whole tree
/// closes both: a keystroke that cannot land is a keystroke that cannot be
/// lost.
///
/// Two layers, because the declarative one is not synchronous:
///
/// * The page raises a capture-phase DOM guard before it invokes the commit
///   hook, so on web no input event reaches the framework at all during the
///   window. That is the enforcement layer.
/// * This widget revokes descendant focusability SYNCHRONOUSLY when the
///   registry freezes — inside `commit()`'s own turn, below the rebuild
///   boundary — and then rebuilds into `ExcludeFocus` + `AbsorbPointer` as
///   the visual and accessibility layer. The imperative step matters: the
///   rebuild lands a frame later, and an input event dispatched before that
///   frame would otherwise still find a focusable field.
///
/// Mounted once in the root `MaterialApp`'s builder, above the router
/// Navigator and the app-level overlay, so dialogs and notices freeze with
/// everything else. The window is bounded by the page's own deadlines — the
/// coordinator releases or moves the tab within seconds, and the page-side
/// lock deadline unfreezes unconditionally after that — so this cannot wedge
/// the app.
class WebHandoffFreeze extends StatefulWidget {
  /// Creates the commit-window input lock over [child].
  const WebHandoffFreeze({required this.child, super.key});

  /// The application subtree the lock covers.
  final Widget child;

  @override
  State<WebHandoffFreeze> createState() => _WebHandoffFreezeState();
}

class _WebHandoffFreezeState extends State<WebHandoffFreeze> {
  final FocusNode _gate = FocusNode(debugLabel: 'WebHandoffFreeze');

  @override
  void initState() {
    super.initState();
    WebHandoffParticipants.instance.frozen.addListener(_onFrozenChanged);
  }

  void _onFrozenChanged() {
    final frozen = WebHandoffParticipants.instance.frozen.value;
    _gate.descendantsAreFocusable = !frozen;
    if (frozen) {
      // Apply the revocation NOW. Setting the flag only schedules the focus
      // change; the focused field would keep its input connection until the
      // next microtask, and a keystroke can be delivered before then.
      FocusManager.instance.applyFocusChangesIfNeeded();
    }
  }

  @override
  void dispose() {
    WebHandoffParticipants.instance.frozen.removeListener(_onFrozenChanged);
    _gate.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: WebHandoffParticipants.instance.frozen,
      child: widget.child,
      builder: (context, frozen, child) => Focus(
        focusNode: _gate,
        canRequestFocus: false,
        skipTraversal: true,
        includeSemantics: false,
        // Same value the listener sets imperatively, so a rebuild never
        // reopens what the freeze just closed.
        descendantsAreFocusable: !frozen,
        child: AbsorbPointer(absorbing: frozen, child: child),
      ),
    );
  }
}
