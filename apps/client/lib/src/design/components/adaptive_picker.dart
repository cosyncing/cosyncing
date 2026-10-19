import 'dart:math' as math;

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// A named choice shared by settings and compact form controls.
class PickerOption<T> {
  /// Creates a choice.
  const PickerOption({
    required this.value,
    required this.label,
    this.leading,
    this.description,
    this.enabled = true,
    this.key,
  });

  /// Selected or selectable domain value.
  final T value;

  /// Localized choice label.
  final String label;

  /// Optional swatch or icon.
  final Widget? leading;

  /// Optional supporting explanation.
  final String? description;

  /// Disabled choices remain visible but cannot be selected.
  final bool enabled;

  /// Stable identity for this option when a form supplies one.
  final Key? key;
}

/// Quiet value control with a titled, button-width popup on every screen.
class AdaptivePicker<T> extends StatefulWidget {
  /// Creates a picker, optionally with a whole settings row as its trigger.
  const AdaptivePicker({
    required this.value,
    required this.options,
    required this.onChanged,
    this.title,
    this.trigger,
    this.placeholder = '',
    super.key,
  });

  /// Selected or selectable domain value.
  final T value;

  /// Choices in display order.
  final List<PickerOption<T>> options;

  /// Commits an explicit selection; null disables the trigger.
  final ValueChanged<T>? onChanged;

  /// Localized setting name for the popup heading.
  final String? title;

  /// Optional whole-row trigger content.
  final Widget? trigger;

  /// Localized placeholder when no value is selected.
  final String placeholder;

  @override
  State<AdaptivePicker<T>> createState() => _AdaptivePickerState<T>();
}

class _AdaptivePickerState<T> extends State<AdaptivePicker<T>> {
  final _focus = FocusNode();
  bool _open = false;

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  Future<void> _show() async {
    final box = context.findRenderObject()! as RenderBox;
    final anchor = box.localToGlobal(Offset.zero) & box.size;
    setState(() => _open = true);
    final next = await showDialog<T>(
      context: context,
      useSafeArea: false,
      requestFocus: MediaQuery.viewInsetsOf(context).bottom == 0,
      barrierColor: context.tokens.canvas.withValues(alpha: 0),
      builder: (context) => _PickerPopup<T>(
        anchor: anchor,
        value: widget.value,
        options: widget.options,
        title: widget.title,
      ),
    );
    if (!mounted) return;
    setState(() => _open = false);
    _focus.requestFocus();
    if (next != null && next != widget.value) widget.onChanged?.call(next);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final option = widget.options
        .where((o) => o.value == widget.value)
        .firstOrNull;
    return Semantics(
      button: true,
      expanded: _open,
      child: Material(
        color: _open
            ? t.accent.withValues(alpha: .12)
            : t.surface.withValues(alpha: 0),
        borderRadius: BorderRadius.circular(t.radiusMd),
        child: InkWell(
          focusNode: _focus,
          onTap: widget.onChanged == null ? null : _show,
          borderRadius: BorderRadius.circular(t.radiusMd),
          child:
              widget.trigger ??
              ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 8,
                  ),
                  child: Row(
                    children: [
                      if (option?.leading case final leading?) ...[
                        leading,
                        const SizedBox(width: 8),
                      ],
                      Expanded(
                        child: Text(
                          option?.label ?? widget.placeholder,
                          key: const Key('picker-current-value'),
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(
                                color: widget.onChanged == null
                                    ? t.textTertiary
                                    : t.accent,
                              ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Icon(
                        Icons.keyboard_arrow_down,
                        size: 16,
                        color: t.textTertiary,
                      ),
                    ],
                  ),
                ),
              ),
        ),
      ),
    );
  }
}

class _PickerPopup<T> extends StatefulWidget {
  const _PickerPopup({
    required this.anchor,
    required this.value,
    required this.options,
    this.title,
  });
  final Rect anchor;

  /// Selected or selectable domain value.
  final T value;

  /// Choices in display order.
  final List<PickerOption<T>> options;

  /// Localized setting name for the popup heading.
  final String? title;
  @override
  State<_PickerPopup<T>> createState() => _PickerPopupState<T>();
}

class _PickerPopupState<T> extends State<_PickerPopup<T>> {
  String _query = '';
  final Map<T, FocusNode> _optionFocus = {};
  @override
  void dispose() {
    for (final node in _optionFocus.values) {
      node.dispose();
    }
    super.dispose();
  }

  void _moveOption(List<PickerOption<T>> options, int step) {
    final enabled = options.where((option) => option.enabled).toList();
    if (enabled.isEmpty) return;
    final focused = enabled.indexWhere(
      (option) => _optionFocus[option.value]?.hasFocus ?? false,
    );
    final next = focused < 0
        ? (step > 0 ? 0 : enabled.length - 1)
        : (focused + step) % enabled.length;
    _optionFocus[enabled[next].value]?.requestFocus();
  }

  Size? _initialSize;
  double? _initialTextSize;
  bool _dismissing = false;
  void _dismissAfterLayout() {
    if (_dismissing) return;
    _dismissing = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && (ModalRoute.of(context)?.isCurrent ?? false)) {
        Navigator.pop(context);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final l10n = AppLocalizations.of(context);
    final media = MediaQuery.of(context);
    _initialSize ??= media.size;
    _initialTextSize ??= media.textScaler.scale(14);
    final available = math.max(
      widget.anchor.top - media.padding.top - 16,
      media.size.height -
          math.max(media.padding.bottom, media.viewInsets.bottom) -
          widget.anchor.bottom -
          16,
    );
    final minimum =
        56 +
        (widget.title == null ? 0 : 40) +
        (widget.options.length >= 8 ? 56 : 0);
    if (_initialSize != media.size ||
        _initialTextSize != media.textScaler.scale(14) ||
        widget.anchor.top < media.padding.top ||
        widget.anchor.bottom >
            media.size.height -
                math.max(media.padding.bottom, media.viewInsets.bottom) ||
        available < minimum) {
      _dismissAfterLayout();
      return const SizedBox.shrink();
    }
    final options = widget.options
        .where(
          (o) => '${o.label} ${o.description ?? ''}'.toLowerCase().contains(
            _query.toLowerCase(),
          ),
        )
        .toList();
    return CustomSingleChildLayout(
      delegate: _PickerLayout(
        widget.anchor,
        media.padding,
        media.viewInsets.bottom,
        options.length * 56.0 + minimum - 40,
      ),
      child: Material(
        key: const Key('adaptive-picker-popup'),
        color: t.surface,
        elevation: 8,
        shadowColor: t.textPrimary.withValues(alpha: .24),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(t.radiusMd),
          side: Theme.of(context).brightness == Brightness.dark
              ? BorderSide.none
              : BorderSide(color: t.separator),
        ),
        clipBehavior: Clip.antiAlias,
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (widget.title != null)
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        widget.title!,
                        style: Theme.of(context).textTheme.labelLarge,
                      ),
                    ),
                    IconButton(
                      tooltip: l10n.close,
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close, size: 16),
                      constraints: const BoxConstraints.tightFor(
                        width: 40,
                        height: 40,
                      ),
                      padding: EdgeInsets.zero,
                    ),
                  ],
                ),
              if (widget.options.length >= 8)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: TextField(
                    onChanged: (value) => setState(() => _query = value),
                    decoration: InputDecoration(
                      hintText: l10n.pickerSearchChoices,
                      isDense: true,
                      filled: true,
                      fillColor: t.surface2,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(t.radiusSm),
                        borderSide: BorderSide.none,
                      ),
                    ),
                  ),
                ),
              Flexible(
                child: CallbackShortcuts(
                  bindings: {
                    const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
                        _moveOption(options, 1),
                    const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
                        _moveOption(options, -1),
                  },
                  child: ListView(
                    shrinkWrap: true,
                    padding: EdgeInsets.zero,
                    children: [
                      if (options.isEmpty)
                        Padding(
                          padding: const EdgeInsets.all(12),
                          child: Text(l10n.pickerNoChoices),
                        ),
                      for (final option in options)
                        Builder(
                          builder: (context) {
                            final selected = option.value == widget.value;
                            return Semantics(
                              selected: selected,
                              checked: selected,
                              inMutuallyExclusiveGroup: true,
                              child: TextButton(
                                key: option.key,
                                autofocus:
                                    selected &&
                                    option.enabled &&
                                    media.viewInsets.bottom == 0,
                                focusNode: _optionFocus.putIfAbsent(
                                  option.value,
                                  FocusNode.new,
                                ),
                                onFocusChange: (focused) {
                                  if (focused) {
                                    WidgetsBinding.instance
                                        .addPostFrameCallback((_) {
                                          if (context.mounted) {
                                            Scrollable.ensureVisible(
                                              context,
                                              alignmentPolicy:
                                                  ScrollPositionAlignmentPolicy
                                                      .keepVisibleAtEnd,
                                            );
                                          }
                                        });
                                  }
                                },
                                style: TextButton.styleFrom(
                                  textStyle: Theme.of(
                                    context,
                                  ).textTheme.bodySmall,
                                  minimumSize: const Size(0, 56),
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 12,
                                    vertical: 8,
                                  ),
                                  alignment: Alignment.centerLeft,
                                  backgroundColor: selected
                                      ? t.accent.withValues(alpha: .12)
                                      : null,
                                  foregroundColor: selected
                                      ? t.accent
                                      : t.textPrimary,
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(
                                      t.radiusSm,
                                    ),
                                  ),
                                ),
                                onPressed: option.enabled
                                    ? () => Navigator.pop(context, option.value)
                                    : null,
                                child: Row(
                                  children: [
                                    if (option.leading case final leading?) ...[
                                      leading,
                                      const SizedBox(width: 8),
                                    ],
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(option.label),
                                          if (option.description
                                              case final description?)
                                            Text(
                                              description,
                                              style: Theme.of(context)
                                                  .textTheme
                                                  .labelSmall
                                                  ?.copyWith(
                                                    color: t.textSecondary,
                                                  ),
                                            ),
                                        ],
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    SizedBox(
                                      width: 16,
                                      child: selected
                                          ? Icon(
                                              Icons.check,
                                              size: 16,
                                              color: t.accent,
                                            )
                                          : null,
                                    ),
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PickerLayout extends SingleChildLayoutDelegate {
  _PickerLayout(this.anchor, this.safe, this.keyboard, this.preferredHeight);
  final Rect anchor;
  final EdgeInsets safe;
  final double keyboard;
  final double preferredHeight;
  bool _above(Size size) =>
      size.height - math.max(safe.bottom, keyboard) - anchor.bottom - 16 <
          math.min(preferredHeight, 200.0) &&
      anchor.top - safe.top >
          size.height - math.max(safe.bottom, keyboard) - anchor.bottom;
  @override
  BoxConstraints getConstraintsForChild(BoxConstraints constraints) {
    final size = constraints.biggest;
    final available = _above(size)
        ? anchor.top - safe.top - 16
        : size.height - math.max(safe.bottom, keyboard) - anchor.bottom - 16;
    final width = math
        .min(anchor.width, size.width - safe.horizontal - 16)
        .clamp(0.0, double.infinity);
    return BoxConstraints(
      minWidth: width,
      maxWidth: width,
      maxHeight: math.min(440, math.max(0, available)),
    );
  }

  @override
  Offset getPositionForChild(Size size, Size childSize) => Offset(
    anchor.left.clamp(
      safe.left + 8,
      math.max(safe.left + 8, size.width - safe.right - childSize.width - 8),
    ),
    _above(size) ? anchor.top - childSize.height - 8 : anchor.bottom + 8,
  );
  @override
  bool shouldRelayout(covariant _PickerLayout old) =>
      anchor != old.anchor ||
      safe != old.safe ||
      keyboard != old.keyboard ||
      preferredHeight != old.preferredHeight;
}

/// Form integration preserving validation, saved values and async defaults.
class AdaptivePickerFormField<T> extends FormField<T> {
  /// Creates an anchored selector that participates in a Form.
  AdaptivePickerFormField({
    required this.items,
    required this.onChanged,
    this.decoration = const InputDecoration(),
    Widget? hint,
    super.initialValue,
    super.validator,
    super.onSaved,
    super.key,
  }) : super(
         enabled: onChanged != null,
         builder: (state) => InputDecorator(
           decoration: decoration.copyWith(
             errorText: state.errorText,
             enabled: onChanged != null,
             border: InputBorder.none,
             enabledBorder: InputBorder.none,
           ),
           isEmpty: state.value == null,
           child: AdaptivePicker<T?>(
             value: state.value,
             title: decoration.labelText,
             placeholder: _pickerText(hint),
             options: [
               for (final item in items)
                 PickerOption(
                   value: item.value,
                   label: _pickerText(item.child),
                   enabled: item.enabled,
                   key: item.key,
                   description: item.child is Tooltip
                       ? (item.child as Tooltip).message
                       : null,
                 ),
             ],
             onChanged: onChanged == null
                 ? null
                 : (value) {
                     state.didChange(value);
                     onChanged(value);
                   },
           ),
         ),
       );

  @override
  FormFieldState<T> createState() => _AdaptivePickerFormFieldState<T>();

  /// Existing form choices; only their values and labels are reused.
  final List<DropdownMenuItem<T>> items;

  /// Form selection callback.
  final ValueChanged<T?>? onChanged;

  /// Form label, helper and validation decoration.
  final InputDecoration decoration;
}

class _AdaptivePickerFormFieldState<T> extends FormFieldState<T> {
  @override
  void didUpdateWidget(covariant AdaptivePickerFormField<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.initialValue != widget.initialValue) {
      setValue(widget.initialValue);
    }
  }
}

String _pickerText(Widget? widget) => switch (widget) {
  Text(:final data) => data ?? '',
  Tooltip(:final child) => _pickerText(child),
  _ => '',
};
