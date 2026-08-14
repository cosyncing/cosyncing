part of 'session_detail_page.dart';

/// Ceiling on rows built for one palette pass.
///
/// A broker may advertise a large command/skill registry; the palette scrolls,
/// so this only stops a pathological registry from building thousands of nodes
/// on every keystroke.
const int _slashPaletteMaxItems = 50;

/// Strips the leading `/` that brokers may or may not include in a command
/// name, so matching and completion agree on one spelling.
String _slashCommandName(SlashCommand command) =>
    command.name.startsWith('/') ? command.name.substring(1) : command.name;

/// The in-progress command-name token, or null when [text] is not a
/// leading-slash command.
///
/// Deliberately scoped to the *leading* character: a `/` typed mid-sentence
/// ("and/or", a path like `lib/src`) must never hijack the composer. Once the
/// name is followed by whitespace the user has moved on to arguments, so the
/// palette closes rather than hovering over `/goal set finish the report`.
String? _slashPaletteQuery(String text) {
  if (!text.startsWith('/')) {
    return null;
  }
  final rest = text.substring(1);
  return rest.contains(RegExp(r'\s')) ? null : rest;
}

/// Commands whose name prefix-matches [query], capped at
/// [_slashPaletteMaxItems]. An empty query (a bare `/`) matches everything.
List<SlashCommand> _matchSlashCommands(
  List<SlashCommand> commands,
  String query,
) {
  final lower = query.toLowerCase();
  final matches = commands
      .where(
        (command) => _slashCommandName(command).toLowerCase().startsWith(lower),
      )
      .toList(growable: false);
  return matches.length <= _slashPaletteMaxItems
      ? matches
      : matches.sublist(0, _slashPaletteMaxItems);
}

/// Inline slash-command palette behaviour for [_PromptComposer].
///
/// Mirrors the PoC's `updatePalette` (`apps/poc-ui/public/app.js`): typing `/`
/// as the first character opens the list, further typing filters it, ↑/↓ move
/// the selection, Enter/Tab complete the name into the composer, and Esc
/// dismisses. Kept in its own mixin so the composer file stays under its
/// line ceiling.
mixin _SlashPaletteHost on ConsumerState<_PromptComposer> {
  List<SlashCommand> _paletteMatches = const <SlashCommand>[];
  int _paletteIndex = 0;

  /// Composer text the palette was dismissed for.
  ///
  /// Esc hides the palette without clearing what the user typed, so the open
  /// condition alone would immediately re-open it. Recording the exact text
  /// keeps it shut until the next edit — the same "dismiss until you type
  /// again" contract the PoC gets for free from its input event.
  String? _paletteDismissedFor;

  bool get _paletteOpen => _paletteMatches.isNotEmpty;

  void _attachPaletteListener() =>
      widget.controller.addListener(_syncSlashPalette);

  void _detachPaletteListener() =>
      widget.controller.removeListener(_syncSlashPalette);

  /// Recomputes the palette from the composer's current text.
  void _syncSlashPalette() {
    if (!mounted) {
      return;
    }
    final text = widget.controller.text;
    final query = widget.enabled ? _slashPaletteQuery(text) : null;
    if (query == null) {
      // No longer a command in progress — a later `/` should open cleanly.
      _paletteDismissedFor = null;
    }
    final matches = query == null || text == _paletteDismissedFor
        ? const <SlashCommand>[]
        : _matchSlashCommands(widget.commands, query);
    if (_sameMatches(matches, _paletteMatches)) {
      return;
    }
    setState(() {
      _paletteMatches = matches;
      _paletteIndex = 0;
    });
  }

  bool _sameMatches(List<SlashCommand> a, List<SlashCommand> b) {
    if (a.length != b.length) {
      return false;
    }
    for (var index = 0; index < a.length; index++) {
      if (!identical(a[index], b[index])) {
        return false;
      }
    }
    return true;
  }

  void _closePalette({String? dismissedFor}) {
    setState(() {
      _paletteDismissedFor = dismissedFor;
      _paletteMatches = const <SlashCommand>[];
      _paletteIndex = 0;
    });
  }

  /// Completes the composer to `/name ` and hands focus back to the field so
  /// the user can type arguments. Never sends — matching the PoC, where Tab and
  /// a partial Enter only complete the text.
  void _completeSlashCommand(SlashCommand command) {
    final text = '/${_slashCommandName(command)} ';
    widget.controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    _closePalette(dismissedFor: text);
    widget.focusNode.requestFocus();
  }

  /// Key handling for the composer field while the palette is open.
  ///
  /// Installed on a [Focus] ancestor of the `TextField`, which sits below the
  /// app-level default shortcuts in the focus chain, so returning `handled`
  /// preempts caret movement (↑/↓), a newline (Enter) and traversal (Tab).
  KeyEventResult _onPaletteKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.escape) {
      if (!_paletteOpen) {
        return KeyEventResult.ignored;
      }
      _closePalette(dismissedFor: widget.controller.text);
      return KeyEventResult.handled;
    }
    if (!_paletteOpen) {
      return KeyEventResult.ignored;
    }
    if (key == LogicalKeyboardKey.arrowDown ||
        key == LogicalKeyboardKey.arrowUp) {
      final delta = key == LogicalKeyboardKey.arrowDown ? 1 : -1;
      final length = _paletteMatches.length;
      setState(() => _paletteIndex = (_paletteIndex + delta + length) % length);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.enter || key == LogicalKeyboardKey.tab) {
      _completeSlashCommand(_paletteMatches[_paletteIndex]);
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  /// The palette list, or null when it is closed.
  Widget? _buildSlashPalette() => _paletteOpen
      ? _SlashCommandPalette(
          matches: _paletteMatches,
          selectedIndex: _paletteIndex,
          onPicked: _completeSlashCommand,
        )
      : null;
}

/// The palette list itself: name plus description, one row per match, with the
/// keyboard selection tinted.
class _SlashCommandPalette extends StatelessWidget {
  const _SlashCommandPalette({
    required this.matches,
    required this.selectedIndex,
    required this.onPicked,
  });

  final List<SlashCommand> matches;
  final int selectedIndex;
  final ValueChanged<SlashCommand> onPicked;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 176),
      child: ListView.builder(
        key: const Key('session-detail-slash-palette'),
        shrinkWrap: true,
        padding: const EdgeInsets.symmetric(vertical: 4),
        itemCount: matches.length,
        itemBuilder: (context, index) {
          final command = matches[index];
          final name = _slashCommandName(command);
          final selected = index == selectedIndex;
          final description = command.description ?? '';
          return InkWell(
            key: ValueKey('session-detail-slash-palette-item-$name'),
            onTap: () => onPicked(command),
            child: ColoredBox(
              color: selected
                  ? scheme.primary.withValues(alpha: 0.12)
                  : Colors.transparent,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 8,
                  vertical: 6,
                ),
                child: Row(
                  children: [
                    Text(
                      '/$name',
                      style: theme.textTheme.bodySmall?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: selected ? scheme.primary : scheme.onSurface,
                      ),
                    ),
                    if (description.isNotEmpty) ...[
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          description,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: scheme.onSurfaceVariant,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
