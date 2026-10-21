import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/errors/diagnostic_details.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

/// Adds contextual diagnostics without replacing the child's normal action.
/// Embedded selection/editing recognizers retain their own gestures.
class ContextualDetails extends StatefulWidget {
  /// Wraps the owning item; null/empty details add no focus or gesture target.
  const ContextualDetails({
    required this.label,
    required this.child,
    this.detail,
    this.detailsBuilder,
    super.key,
  });

  /// Human label of the item being diagnosed.
  final String label;

  /// Previously captured error, if available.
  final String? detail;

  /// Deferred formatting for non-error metadata.
  final String Function()? detailsBuilder;

  /// Original item, including its primary action and selectable content.
  final Widget child;

  @override
  State<ContextualDetails> createState() => _ContextualDetailsState();
}

class _ContextualDetailsState extends State<ContextualDetails> {
  final _focus = FocusNode();
  bool _showing = false;

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  Future<void> _show() async {
    if (_showing) return;
    _showing = true;
    try {
      await showContextualDetails(
        context,
        label: widget.label,
        detail: widget.detailsBuilder?.call() ?? widget.detail ?? '',
        returnFocus: _focus,
      );
    } finally {
      _showing = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.detailsBuilder == null &&
        (widget.detail?.trim().isEmpty ?? true)) {
      return widget.child;
    }
    final l10n = AppLocalizations.of(context);
    return Focus(
      focusNode: _focus,
      onKeyEvent: (node, event) {
        if (event is KeyDownEvent &&
            (event.logicalKey == LogicalKeyboardKey.contextMenu ||
                (event.logicalKey == LogicalKeyboardKey.f10 &&
                    HardwareKeyboard.instance.isShiftPressed))) {
          unawaited(_show());
          return KeyEventResult.handled;
        }
        return KeyEventResult.ignored;
      },
      child: Semantics(
        hint: l10n.technicalDetailsHint,
        customSemanticsActions: {
          CustomSemanticsAction(label: l10n.showTechnicalDetails): _show,
        },
        child: GestureDetector(
          behavior: HitTestBehavior.translucent,
          onLongPress: _show,
          onSecondaryTap: _show,
          child: widget.child,
        ),
      ),
    );
  }
}

/// Shared menu action and presenter. Captures once, before opening the route.
Future<void> showContextualDetails(
  BuildContext context, {
  required String label,
  required String detail,
  FocusNode? returnFocus,
}) async {
  final snapshot = DiagnosticDetails.capture(label: label, detail: detail);
  final previousFocus = returnFocus ?? FocusManager.instance.primaryFocus;
  final fallback = FocusScope.of(context);
  final l10n = AppLocalizations.of(context);
  final compact = WindowSizeClass.of(context) == WindowSizeClass.compact;
  Widget content(BuildContext context) => Padding(
    padding: EdgeInsets.all(compact ? 16 : 24),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(snapshot.label, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 16),
        Flexible(
          child: SingleChildScrollView(
            child: SelectableText(
              snapshot.text,
              key: const Key('contextual-details-text'),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ),
        const SizedBox(height: 16),
        Wrap(
          alignment: WrapAlignment.end,
          spacing: 8,
          children: [
            TextButton(
              key: const Key('contextual-details-copy'),
              onPressed: () =>
                  Clipboard.setData(ClipboardData(text: snapshot.text)),
              child: Text(l10n.copyDetails),
            ),
            TextButton(
              key: const Key('contextual-details-close'),
              onPressed: () => Navigator.of(context).pop(),
              child: Text(l10n.close),
            ),
          ],
        ),
      ],
    ),
  );
  if (compact) {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      constraints: BoxConstraints(
        maxWidth: MediaQuery.sizeOf(context).width - 32,
        maxHeight: MediaQuery.sizeOf(context).height * .8,
      ),
      builder: content,
    );
  } else {
    await showDialog<void>(
      context: context,
      builder: (context) => Dialog(
        insetPadding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: 560,
            maxHeight: MediaQuery.sizeOf(context).height * .8,
          ),
          child: content(context),
        ),
      ),
    );
  }
  if (previousFocus?.context?.mounted ?? false) {
    previousFocus!.requestFocus();
  } else if (fallback.context?.mounted ?? false) {
    fallback.requestFocus();
  }
}
