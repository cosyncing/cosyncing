import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';

/// The bundled brand mark for a harness, by its served tool id.
///
/// The marks live in `assets/agents/` and come from tokdash's own icon set —
/// see the `README.md` bundled beside them for the provenance of every mark.
/// All marks remain the property of their respective owners. Bundling them
/// means the client never makes a runtime request to a brand website.
///
/// An id with no mark gets a neutral letter chip, never a missing row: the
/// fallback is a rendering decision, not a data one.
class UsageAgentLogo extends StatelessWidget {
  /// Creates a logo badge for [tool].
  const UsageAgentLogo({required this.tool, this.size = 16, super.key});

  /// The served tool id, e.g. `codex`, `qoder_cli`.
  final String tool;

  /// Edge length of the badge.
  final double size;

  /// Tool id to bundled asset. Mirrors tokdash's `TOOL_META`.
  static const Map<String, String> _marks = {
    'opencode': 'assets/agents/opencode.png',
    'codex': 'assets/agents/codex.png',
    'claude': 'assets/agents/claude.png',
    'gemini_cli': 'assets/agents/gemini_cli.png',
    'antigravity_cli': 'assets/agents/antigravity_cli.png',
    'cursor': 'assets/agents/cursor.png',
    'amp': 'assets/agents/amp.png',
    'openclaw': 'assets/agents/openclaw.png',
    'kimi': 'assets/agents/kimi.png',
    'grok': 'assets/agents/grok.png',
    'pi_agent': 'assets/agents/pi_agent.png',
    'omp': 'assets/agents/omp.png',
    'kilocode': 'assets/agents/kilocode.png',
    'cline': 'assets/agents/cline.png',
    'copilot_cli': 'assets/agents/copilot_cli.png',
    'hermes': 'assets/agents/hermes.png',
    'mimo': 'assets/agents/mimo.png',
    'dsh': 'assets/agents/dsh.png',
    'reasonix': 'assets/agents/reasonix.png',
    'zcode': 'assets/agents/zcode.png',
    'workbuddy': 'assets/agents/workbuddy.png',
    'qoder': 'assets/agents/qoder.png',
    'qoder_cli': 'assets/agents/qoder_cli.png',
    'zed': 'assets/agents/zed.png',
    'qwen_code': 'assets/agents/qwen_code.png',
    'crush': 'assets/agents/crush.png',
  };

  /// Marks drawn dark-on-transparent that would vanish on a dark canvas;
  /// inverted in dark mode exactly as tokdash's `darkInvert` does.
  static const Set<String> _darkInvert = {
    'codex',
    'cursor',
    'grok',
    'omp',
    'cline',
    'zcode',
    'zed',
  };

  /// Wordmark marks are wider than tall and must not be squared.
  static const Set<String> _wordmark = {'mimo'};

  /// CSS `invert(1) hue-rotate(180deg)` as a single color matrix: lightness
  /// flips, hue survives, so a black glyph turns white without orange going
  /// blue. Channels are 0–255 in Flutter's matrix convention.
  static const List<double> _invertPreserveHue = [
    0.574, -1.43, -0.144, 0, 255, //
    -0.426, -0.43, -0.144, 0, 255, //
    -0.426, -1.43, 0.856, 0, 255, //
    0, 0, 0, 1, 0, //
  ];

  @override
  Widget build(BuildContext context) {
    final id = tool.toLowerCase();
    final asset = _marks[id];
    if (asset == null) return _FallbackChip(tool: tool, size: size);

    final dark = Theme.of(context).brightness == Brightness.dark;
    Widget image = Image.asset(
      asset,
      width: size,
      height: size,
      fit: BoxFit.contain,
      // A mark that fails to decode degrades to the same chip as an id with
      // no mark at all.
      errorBuilder: (context, error, stackTrace) =>
          _FallbackChip(tool: tool, size: size),
    );
    if (dark && _darkInvert.contains(id)) {
      image = ColorFiltered(
        colorFilter: const ColorFilter.matrix(_invertPreserveHue),
        child: image,
      );
    }
    if (_wordmark.contains(id)) {
      return SizedBox(
        width: size * 2.5,
        height: size,
        child: FittedBox(child: image),
      );
    }
    return SizedBox(width: size, height: size, child: image);
  }
}

class _FallbackChip extends StatelessWidget {
  const _FallbackChip({required this.tool, required this.size});

  final String tool;
  final double size;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final letter = tool.isEmpty ? '?' : tool.characters.first.toUpperCase();
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: tokens.surface2,
        borderRadius: BorderRadius.circular(tokens.radiusXs),
      ),
      child: Text(
        letter,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          fontSize: size * 0.62,
          fontWeight: FontWeight.w700,
          color: tokens.textSecondary,
        ),
      ),
    );
  }
}
