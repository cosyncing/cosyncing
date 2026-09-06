import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';

/// A quiet one-line explanation that stands in for content that is not there.
///
/// The app says "this is unavailable" in several places — the quota panel, the
/// usage card, the report's own sections — and each of them used to say it with
/// its own private copy of the same [Row]. They must look identical, because
/// they are the same statement: an icon, a short line of secondary text, and
/// deliberately no card, border, or colour that would make absence look like an
/// error.
///
/// Reach for this over an empty state with a zero in it. "No reading" and
/// "measured zero" are different claims, and only one of them is ever true when
/// a source cannot be read.
///
/// The text is a [SelectableText], not a [Text]. What a notice says is exactly
/// the thing a reader wants to paste into a search box or a bug report — it
/// names a version, a command, a tool that could not be read — and a plain
/// [Text] cannot be copied at all on the web client, which is where these are
/// most often read.
///
/// Selectable at the leaf rather than by wrapping the callers in a
/// [SelectionArea]: on the web a selection region registers a platform view
/// whose placeholder reads `localToGlobal` from an unguarded post-frame
/// callback, and this repo has already traced a release-mode `RenderErrorBox`
/// over a scrolling list to exactly that mechanism on the 3.44.3 branch it pins
/// (see `session_list_pane.dart`). A leaf that selects its own text needs none
/// of that machinery, and no notice in the app sits inside a selection region
/// it would otherwise have joined.
class InlineNotice extends StatelessWidget {
  /// Creates a notice.
  const InlineNotice({
    required this.text,
    this.icon,
    this.showSpinner = false,
    super.key,
  });

  /// The explanation. One sentence, already localized.
  final String text;

  /// Leading glyph. Ignored while [showSpinner] is set.
  final IconData? icon;

  /// Shows a spinner in the icon's place, for a read still in flight.
  final bool showSpinner;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Row(
      children: [
        if (showSpinner)
          const SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          )
        else
          Icon(icon, size: 16, color: tokens.textTertiary),
        const SizedBox(width: 8),
        Expanded(
          child: SelectableText(
            text,
            style: theme.textTheme.bodySmall?.copyWith(
              color: tokens.textSecondary,
            ),
          ),
        ),
      ],
    );
  }
}
