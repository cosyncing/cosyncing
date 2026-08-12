import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

/// Selectable text content that preserves its host's short-tap action.
///
/// Flutter's selectable region owns pointer gestures over its text. In a
/// tappable row that means a plain [SelectionArea] can prevent the row's
/// [InkWell] from seeing a short tap. This boundary restores only a stationary,
/// short tap; drag selection and touch long-press remain owned by selection.
///
/// This deliberately does NOT create a [SelectionArea] of its own. It used to,
/// once per instance, which made every roster row its own selection island: a
/// [SelectionArea] only clears the selection it owns, so selecting text in one
/// row left every previously selected row still painted with its highlight, and
/// a drag could never range across rows. The transcript already states the rule
/// this now follows — one selection region per list, plain text inside it.
///
/// Callers must therefore provide an ancestor [SelectionArea], one per list or
/// pane rather than one per item.
class SelectableTapRegion extends StatefulWidget {
  /// Creates a selectable region with an optional short-tap action.
  const SelectableTapRegion({required this.child, this.onTap, super.key});

  /// Static text content that participates in the ancestor selection region.
  final Widget child;

  /// Action performed for a stationary tap shorter than a long press.
  final VoidCallback? onTap;

  @override
  State<SelectableTapRegion> createState() => _SelectableTapRegionState();
}

class _SelectableTapRegionState extends State<SelectableTapRegion> {
  int? _pointer;
  Offset? _downPosition;
  Timer? _longPressTimer;
  bool _moved = false;
  bool _longPressed = false;

  void _handleDown(PointerDownEvent event) {
    if (_pointer != null) return;
    _pointer = event.pointer;
    _downPosition = event.position;
    _moved = false;
    _longPressed = false;
    _longPressTimer = Timer(kLongPressTimeout, () {
      if (_pointer == event.pointer) _longPressed = true;
    });
  }

  void _handleMove(PointerMoveEvent event) {
    if (event.pointer != _pointer || _moved) return;
    final downPosition = _downPosition;
    if (downPosition == null) return;
    _moved =
        (event.position - downPosition).distanceSquared >
        kTouchSlop * kTouchSlop;
  }

  void _handleUp(PointerUpEvent event) {
    if (event.pointer != _pointer) return;
    final shouldTap = !_moved && !_longPressed;
    _clearPointer();
    if (shouldTap) widget.onTap?.call();
  }

  void _handleCancel(PointerCancelEvent event) {
    if (event.pointer == _pointer) _clearPointer();
  }

  void _clearPointer() {
    _pointer = null;
    _downPosition = null;
    _longPressTimer?.cancel();
    _longPressTimer = null;
    _moved = false;
    _longPressed = false;
  }

  @override
  void dispose() {
    _longPressTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: _handleDown,
      onPointerMove: _handleMove,
      onPointerUp: _handleUp,
      onPointerCancel: _handleCancel,
      child: widget.child,
    );
  }
}
