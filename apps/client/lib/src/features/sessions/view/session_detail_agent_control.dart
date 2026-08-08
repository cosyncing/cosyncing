part of 'session_detail_page.dart';

/// The composer's agent/mode selector (e.g. opencode build/plan).
///
/// Renders ONLY from broker-advertised data: the button appears when the
/// session's `options` frame carried a non-empty `agents` list, and its label
/// is the broker-reported `currentAgent` name verbatim. The client never
/// branches on specific agent names and never invents a roster — a session
/// whose adapter advertises no agents shows no control at all (like the
/// context meter, absent beats fabricated).
///
/// Selecting an option asks the broker to switch the LIVE session's mode
/// (`set-agent`); the label updates when the broker pushes the resulting
/// `currentAgent`, which also covers switches made from the terminal side.
class _ComposerAgentControl extends StatelessWidget {
  const _ComposerAgentControl({
    required this.agents,
    required this.currentAgent,
    required this.enabled,
    required this.compact,
    required this.onSelected,
  });

  /// Broker-advertised selectable agents/modes for this session. Non-empty —
  /// the caller renders nothing otherwise.
  final List<AgentOption> agents;

  /// Broker-reported active agent name, or null when the session has not
  /// recorded one yet.
  final String? currentAgent;

  final bool enabled;

  /// Icon-plus-dot rendering below the composer collapse width, matching the
  /// permission selector's narrow behavior.
  final bool compact;

  final ValueChanged<AgentOption> onSelected;

  Future<void> _pick(BuildContext context) async {
    final selected = await showModalBottomSheet<AgentOption>(
      context: context,
      showDragHandle: true,
      builder: (context) => _AgentPickerSheet(
        agents: agents,
        selected: currentAgent,
      ),
    );
    if (!context.mounted || selected == null) return;
    onSelected(selected);
  }

  @override
  Widget build(BuildContext context) {
    AgentOption? active;
    for (final agent in agents) {
      if (agent.name == currentAgent) {
        active = agent;
        break;
      }
    }
    // The advertised name is the human label — AgentOption carries no separate
    // display string. An unadvertised-but-reported current name still renders
    // verbatim (broker data, not a fabrication).
    final l10n = AppLocalizations.of(context);
    final label = currentAgent ?? l10n.sessionComposerAgentModeGenericLabel;
    final description = active?.description;
    final tooltip = description == null || description.isEmpty
        ? l10n.sessionComposerAgentModeTooltip
        : '$label — $description';
    return _ComposerPickerButton(
      key: const Key('session-detail-agent-selector'),
      icon: Icons.smart_toy_outlined,
      label: label,
      tooltip: tooltip,
      compact: compact,
      onPressed: enabled ? () => unawaited(_pick(context)) : null,
    );
  }
}

/// Bottom sheet listing the broker-advertised agents/modes for this session.
class _AgentPickerSheet extends StatelessWidget {
  const _AgentPickerSheet({required this.agents, required this.selected});

  final List<AgentOption> agents;

  /// Currently active agent name, for the radio state. May be null or a name
  /// outside [agents]; nothing is preselected then.
  final String? selected;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              AppLocalizations.of(context).sessionComposerAgentModeSheetTitle,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            for (final agent in agents)
              ListTile(
                key: ValueKey('session-detail-agent-option-${agent.name}'),
                selected: agent.name == selected,
                leading: Icon(
                  agent.name == selected
                      ? Icons.radio_button_checked
                      : Icons.radio_button_off,
                ),
                title: Text(agent.name),
                subtitle:
                    agent.description == null || agent.description!.isEmpty
                    ? null
                    : Text(agent.description!),
                onTap: () => Navigator.of(context).pop(agent),
              ),
          ],
        ),
      ),
    );
  }
}

/// The `·` separator between adjacent composer picker buttons.
class _ComposerPickerDot extends StatelessWidget {
  const _ComposerPickerDot();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 1),
      child: Text(
        '·',
        style: theme.textTheme.labelMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.5),
        ),
      ),
    );
  }
}
