import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_agent_logo.dart';
import 'package:flutter/material.dart';

/// Original harness artwork, with adapter aliases resolved independently of
/// usage-source support. Identity never carries execution status.
class SessionHarnessLogo extends StatelessWidget {
  /// Creates an unboxed harness mark.
  const SessionHarnessLogo({
    required this.tool,
    this.size = 14,
    this.tooltip = true,
    super.key,
  });

  /// Session adapter identity.
  final String tool;

  /// Artwork edge length in logical pixels.
  final double size;

  /// Whether hovering names the harness. A roster row already names it in its
  /// own tooltip, so its logo does not need a second one per row.
  final bool tooltip;

  @override
  Widget build(BuildContext context) {
    final id = switch (tool.toLowerCase()) {
      'pi' => 'pi_agent',
      'kilo' => 'kilocode',
      'agy' => 'antigravity_cli',
      'gemini' => 'gemini_cli',
      _ => tool.toLowerCase(),
    };
    final l10n = AppLocalizations.of(context);
    final label = switch (tool.toLowerCase()) {
      'claude' => l10n.sessionRosterAgentClaude,
      'codex' => l10n.sessionRosterAgentCodex,
      'opencode' => l10n.sessionRosterAgentOpenCode,
      'pi' => l10n.sessionRosterAgentPi,
      'omp' => l10n.sessionRosterAgentOmp,
      'reasonix' => l10n.sessionRosterAgentReasonix,
      'grok' => l10n.sessionRosterAgentGrok,
      'cline' => l10n.sessionRosterAgentCline,
      'kilo' => l10n.sessionRosterAgentKilo,
      'agy' => l10n.sessionRosterAgentAntigravity,
      _ => tool,
    };
    final logo = Semantics(
      image: true,
      label: label,
      child: UsageAgentLogo(tool: id, size: size),
    );
    return tooltip ? Tooltip(message: label, child: logo) : logo;
  }
}
