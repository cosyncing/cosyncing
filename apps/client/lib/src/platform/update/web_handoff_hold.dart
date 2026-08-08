import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/widgets.dart';

/// Holds a web-update handoff off while a surface owns text nothing persists.
///
/// [WebHandoffParticipants] reads an unregistered surface as "this tab owns
/// nothing losable" and moves the tab immediately, so every editor whose value
/// lives only in widget state has to say otherwise. This mixin is that
/// statement for the shape almost all of them have: a [State] with one or more
/// [TextEditingController]s that no repository ever sees.
///
/// It also reports readiness the moment the last field empties. Without that a
/// tab that deferred because of this surface would keep deferring until the
/// coordinator's retry cadence next came round — long after it became safe, and
/// on the slow tier that is a quarter of an hour of staying on the old build
/// for a field the user already cleared.
///
/// Surfaces the user opened deliberately — a sheet, a modal editor — should
/// call [WebHandoffParticipants.hold] instead and defer for as long as they are
/// open: a half-filled form is lost the same way a draft is, and its fields
/// being momentarily empty does not make discarding it acceptable.
mixin WebHandoffHold<T extends StatefulWidget> on State<T> {
  VoidCallback? _handoffRelease;
  List<TextEditingController> _watched = const <TextEditingController>[];

  /// The controllers whose content a handoff would discard.
  ///
  /// Read after `initState` has finished, so `late final` fields are safe.
  List<TextEditingController> get webHandoffControllers;

  /// Whether this surface currently holds something a handoff would discard.
  ///
  /// Defaults to "any watched controller is non-empty". Override when the
  /// answer depends on state that is not text — a selection, or a field that
  /// only counts while it is being edited.
  bool webHandoffHasContent() {
    for (final controller in webHandoffControllers) {
      if (controller.text.isNotEmpty) return true;
    }
    return false;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Not initState: a mixin's initState runs before the State that mixes it in
    // has created its controllers, and this has to read them.
    if (_handoffRelease != null) return;
    _handoffRelease = WebHandoffParticipants.instance.holdWhile(
      webHandoffHasContent,
    );
    _watchControllers();
  }

  /// Re-subscribes after [webHandoffControllers] changed identity or length.
  void refreshWebHandoffHold() {
    if (_handoffRelease == null) return;
    _watchControllers();
    webHandoffContentChanged();
  }

  /// Announces that this surface may have stopped holding anything.
  ///
  /// Wired to every watched controller automatically; call it directly when
  /// non-text state changes.
  void webHandoffContentChanged() {
    // Only the emptying transition is worth reporting: a surface that just
    // became free is exactly the deferral the coordinator is waiting on.
    if (webHandoffHasContent()) return;
    WebHandoffParticipants.instance.notifyReadinessChanged();
  }

  void _watchControllers() {
    for (final controller in _watched) {
      controller.removeListener(webHandoffContentChanged);
    }
    _watched = List<TextEditingController>.of(webHandoffControllers);
    for (final controller in _watched) {
      controller.addListener(webHandoffContentChanged);
    }
  }

  @override
  void dispose() {
    // Runs after the mixing State disposed its controllers, which is why this
    // only ever calls removeListener — it is documented to be safe afterwards,
    // while reading `text` would not be.
    for (final controller in _watched) {
      controller.removeListener(webHandoffContentChanged);
    }
    _watched = const <TextEditingController>[];
    _handoffRelease?.call();
    _handoffRelease = null;
    super.dispose();
  }
}
