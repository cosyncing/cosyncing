part of 'message_renderer_registry.dart';

/// The keyboard/pointer/screen-reader base shared by every transcript link.
///
/// Both link kinds — the http(s) link and the workspace file link — are built
/// from this one widget rather than two look-alikes, so they cannot drift:
/// whatever Tab, Enter, VoiceOver, or a right-click does to one, it does to the
/// other.
///
/// The gesture shape is deliberately a [GestureDetector] over a [WidgetSpan]
/// child rather than a `TapGestureRecognizer`: it keeps the render layer free
/// of any launcher or recognizer dependency, and it is the shape already proven
/// to coexist with the transcript-level [SelectionArea]. Any secondary menu is
/// Flutter-drawn — `BrowserContextMenu.enabled` is settled once before the
/// first frame in `bootstrap.dart`, and flipping it mid-life re-inflates every
/// live selectable region.
class _TranscriptLinkBase extends StatefulWidget {
  const _TranscriptLinkBase({
    required this.semanticsLabel,
    required this.onActivate,
    required this.child,
    this.tooltip,
    this.onSecondary,
    super.key,
  });

  /// What a screen reader announces instead of the visible run.
  final String semanticsLabel;

  /// Invoked by a tap, by Enter/Space while focused, and by the semantics
  /// action a screen reader raises.
  final VoidCallback onActivate;

  /// The visible run.
  final Widget child;

  /// Hover-only tooltip. Manual trigger mode keeps a long-press free for
  /// [onSecondary] on touch, where the two would otherwise both fire.
  final String? tooltip;

  /// Right-click, long-press, or the context-menu key, in global coordinates.
  final void Function(Offset globalPosition)? onSecondary;

  @override
  State<_TranscriptLinkBase> createState() => _TranscriptLinkBaseState();
}

class _TranscriptLinkBaseState extends State<_TranscriptLinkBase> {
  bool _focused = false;

  void _onSecondary(Offset globalPosition) {
    widget.onSecondary?.call(globalPosition);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // A focus ring rather than a colour change: the link is already coloured,
    // so focus has to be visible without relying on colour alone.
    final content = _focused
        ? DecoratedBox(
            decoration: BoxDecoration(
              border: Border.all(color: theme.colorScheme.primary),
              borderRadius: BorderRadius.circular(3),
            ),
            child: widget.child,
          )
        : widget.child;

    Widget link = FocusableActionDetector(
      mouseCursor: SystemMouseCursors.click,
      onShowFocusHighlight: (value) {
        if (value != _focused) setState(() => _focused = value);
      },
      shortcuts: const <ShortcutActivator, Intent>{
        SingleActivator(LogicalKeyboardKey.enter): ActivateIntent(),
        SingleActivator(LogicalKeyboardKey.numpadEnter): ActivateIntent(),
        SingleActivator(LogicalKeyboardKey.space): ActivateIntent(),
      },
      actions: <Type, Action<Intent>>{
        ActivateIntent: CallbackAction<ActivateIntent>(
          onInvoke: (_) {
            widget.onActivate();
            return null;
          },
        ),
      },
      child: Semantics(
        link: true,
        label: widget.semanticsLabel,
        excludeSemantics: true,
        onTap: widget.onActivate,
        child: GestureDetector(
          onTap: widget.onActivate,
          onSecondaryTapUp: widget.onSecondary == null
              ? null
              : (details) => _onSecondary(details.globalPosition),
          onLongPressStart: widget.onSecondary == null
              ? null
              : (details) => _onSecondary(details.globalPosition),
          child: content,
        ),
      ),
    );

    final tooltip = widget.tooltip;
    if (tooltip != null && tooltip.isNotEmpty) {
      link = Tooltip(
        message: tooltip,
        // Hover still shows it; long-press does not, so touch keeps the
        // secondary menu.
        triggerMode: TooltipTriggerMode.manual,
        excludeFromSemantics: true,
        child: link,
      );
    }
    return link;
  }
}

/// A workspace path rendered as a link into this session's Files surface.
///
/// Degrades to exactly today's plain text — no colour, no glyph, no tap
/// target — whenever the enclosing [SessionFileLinkScope] is absent or reports
/// a closed gate. That is the whole point of the once-per-attach probe: on a
/// default host the broker refuses every workspace file request, and a styled
/// link that 403s on tap teaches the reader the feature is broken rather than
/// that their host has filesystem access switched off.
class _TranscriptFileLink extends StatelessWidget {
  const _TranscriptFileLink({
    required this.reference,
    required this.text,
    required this.style,
    this.linkKey,
    this.maxLines,
    this.overflow,
  });

  /// The unclipped, resolvable reference. Never derived from [text].
  final SessionFileReference reference;

  /// The run exactly as this surface already displays it.
  final String text;

  /// The surface's own text style; the link decoration is layered onto it so a
  /// path keeps the monospace face it reads in.
  final TextStyle? style;

  final Key? linkKey;
  final int? maxLines;
  final TextOverflow? overflow;

  @override
  Widget build(BuildContext context) {
    final scope = SessionFileLinkScope.maybeOf(context);
    if (scope == null || !scope.linksEnabled) {
      if (scope != null && scope.gate == SessionFileLinkGate.unknown) {
        // First mention to reach the screen raises the one probe this attach
        // gets. Post-frame because a build must not mutate provider state, and
        // idempotent in the controller, so a screenful of mentions asks once.
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => scope.onProbeNeeded(),
        );
      }
      return Text(
        text,
        key: linkKey,
        style: style,
        maxLines: maxLines,
        overflow: overflow,
      );
    }

    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final base = style ?? const TextStyle();
    final linkStyle = base.copyWith(
      color: theme.colorScheme.primary,
      decoration: TextDecoration.underline,
      decorationColor: theme.colorScheme.primary,
    );
    // The glyph is what distinguishes a path link from a URL link without
    // relying on colour, and it says which of the two shapes this is.
    final glyphSize = (base.fontSize ?? 12) + 1;

    return _TranscriptLinkBase(
      key: linkKey,
      semanticsLabel: l10n.transcriptFileLinkSemantics(reference.displayPath),
      tooltip: reference.displayPath,
      onActivate: () => scope.onOpen(reference),
      onSecondary: (position) => unawaited(
        _showTranscriptFileLinkMenu(
          context: context,
          position: position,
          reference: reference,
          onOpen: scope.onOpen,
        ),
      ),
      child: Text.rich(
        TextSpan(
          children: [
            WidgetSpan(
              alignment: PlaceholderAlignment.middle,
              child: Padding(
                padding: const EdgeInsets.only(right: 3),
                child: Icon(
                  reference.kind == SessionFileReferenceKind.directory
                      ? Icons.folder_outlined
                      : Icons.insert_drive_file_outlined,
                  size: glyphSize,
                  color: theme.colorScheme.primary,
                ),
              ),
            ),
            TextSpan(text: text),
          ],
        ),
        style: linkStyle,
        maxLines: maxLines,
        overflow: overflow ?? TextOverflow.clip,
      ),
    );
  }
}

enum _TranscriptFileLinkAction {
  /// Copy the path exactly as the agent recorded it.
  copyPath,

  /// Open the containing directory in the Files surface.
  openFolder,
}

/// The Flutter-drawn secondary menu for one file link.
///
/// Deliberately short. "Copy workspace-relative path" is absent because the
/// client cannot compute one: since the broker gained `toWorkspaceRelative`,
/// only the session's host knows what an absolute or `~` path relativizes to,
/// and offering a locally-guessed answer would either be wrong on a symlinked
/// workspace or require a hidden round-trip. Download is absent for the same
/// class of reason — it needs a stat'd directory entry — and the Files surface
/// the link lands on already offers it per entry.
Future<void> _showTranscriptFileLinkMenu({
  required BuildContext context,
  required Offset position,
  required SessionFileReference reference,
  required void Function(SessionFileReference reference) onOpen,
}) async {
  final l10n = AppLocalizations.of(context);
  final messenger = ScaffoldMessenger.maybeOf(context);
  final copied = l10n.transcriptFileLinkPathCopied;
  final size = MediaQuery.sizeOf(context);
  final action = await showMenu<_TranscriptFileLinkAction>(
    context: context,
    position: RelativeRect.fromLTRB(
      position.dx,
      position.dy,
      size.width - position.dx,
      size.height - position.dy,
    ),
    items: [
      PopupMenuItem(
        value: _TranscriptFileLinkAction.copyPath,
        child: ListTile(
          key: const Key('transcript-file-link-copy-path'),
          dense: true,
          leading: const Icon(Icons.copy_outlined),
          title: Text(l10n.transcriptFileLinkCopyPath),
        ),
      ),
      PopupMenuItem(
        value: _TranscriptFileLinkAction.openFolder,
        child: ListTile(
          key: const Key('transcript-file-link-open-folder'),
          dense: true,
          leading: const Icon(Icons.folder_open_outlined),
          title: Text(l10n.transcriptFileLinkOpenFolder),
        ),
      ),
    ],
  );
  switch (action) {
    case _TranscriptFileLinkAction.copyPath:
      await Clipboard.setData(ClipboardData(text: reference.displayPath));
      messenger?.showSnackBar(SnackBar(content: Text(copied)));
    case _TranscriptFileLinkAction.openFolder:
      onOpen(reference.parent);
    case null:
      break;
  }
}
