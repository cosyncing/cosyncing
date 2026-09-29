import 'package:cosyncing_client/src/features/usage/view/usage_agent_logo.dart';
import 'package:flutter/material.dart';

/// Quota identities are separate from the session and usage source catalogs.
class QuotaProviderLogo extends StatelessWidget {
  /// Creates a locally bundled provider mark.
  const QuotaProviderLogo({required this.provider, this.size = 16, super.key});

  /// Normalized Tokdash provider id.
  final String provider;

  /// Mark edge in logical pixels.
  final double size;

  @override
  Widget build(BuildContext context) {
    final id = provider.toLowerCase();
    if (id == 'commandcode' || id == 'zai') {
      return Image.asset(
        'assets/agents/$id.png',
        width: size,
        height: size,
        fit: BoxFit.contain,
      );
    }
    return UsageAgentLogo(
      tool: switch (id) {
        'opencode_go' => 'opencode',
        'antigravity' => 'antigravity_cli',
        _ => id,
      },
      size: size,
    );
  }
}
