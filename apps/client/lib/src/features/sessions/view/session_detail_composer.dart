part of 'session_detail_page.dart';

/// Control-row width below which the composer collapses.
///
/// Measured on the control row's own constraints, not the window: the composer
/// sits inside a readable-width column, so the row is narrower than the
/// viewport. Below this the permission button drops to icon + dot and the
/// context meter drops from `verbose` to `ring`.
const double kComposerCollapseWidth = 420;

/// Observe ownership-choice bar threshold, intentionally independent from the
/// general composer control collapse policy above.
const double kObserveComposerActionCollapseWidth = 420;

/// Glyph for the slash-command affordance.
///
/// `Icons.terminal` muddies into a filled rectangle at control-row sizes and
/// read as "shell", not "commands". The bolt is legible at 16px and matches the
/// quick-action sense of a slash command.
const IconData kSlashCommandIcon = Icons.bolt;

/// The composer's left cluster: model and permission selectors, then the
/// context meter.
///
/// Transcript toggles live in the top strip's overflow menu.
class _ComposerBottomBar extends StatelessWidget {
  const _ComposerBottomBar({
    required this.enabled,
    required this.connectionStatus,
    required this.models,
    required this.agents,
    required this.modes,
    required this.effectiveModel,
    required this.currentAgent,
    required this.selectedPermissionMode,
    required this.legacyModel,
    required this.telemetry,
    required this.onModelAndEffortSelected,
    required this.onAgentSelected,
    required this.onPermissionModeSelected,
    required this.onReattach,
    required this.onOpenCommandPicker,
    required this.collapsed,
    required this.touch,
  });

  final bool enabled;
  final SessionDetailConnectionStatus connectionStatus;
  final List<ModelOption> models;

  /// Broker-advertised agents/modes; the mode control renders only when
  /// non-empty (see [_ComposerAgentControl]).
  final List<AgentOption> agents;
  final List<ModeOption> modes;
  final SessionCurrentModel? effectiveModel;

  /// Broker-reported active agent/mode name for the mode control's label.
  final String? currentAgent;
  final String? selectedPermissionMode;
  final String? legacyModel;

  /// Feeds the context meter. Renders nothing unless the broker reported a
  /// real used/max pair, which today only codex does.
  final SessionTelemetry telemetry;

  final void Function(ModelOption model, String? effort)
  onModelAndEffortSelected;

  /// Asks the broker to switch the live session's agent/mode.
  final ValueChanged<AgentOption> onAgentSelected;
  final ValueChanged<ModeOption> onPermissionModeSelected;

  /// Re-attaches the session when the connection is detached.
  final VoidCallback onReattach;

  /// Opens the slash-command sheet. Null when no commands are available.
  final VoidCallback? onOpenCommandPicker;

  /// Below 420dp: permission degrades to an icon + status dot (label moves to
  /// the tooltip) and the context meter drops to its ring form.
  final bool collapsed;

  /// Whether the host is a touch platform (drives minimum hit-target size).
  final bool touch;

  Future<void> _pickModelAndEffort(BuildContext context) async {
    final selectedModel = await showModalBottomSheet<ModelOption>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => FractionallySizedBox(
        heightFactor: 0.72,
        child: _ModelPickerSheet(
          models: models,
          selected: effectiveModel,
        ),
      ),
    );
    if (!context.mounted || selectedModel == null) {
      return;
    }
    final efforts = selectedModel.reasoningEfforts ?? const <ReasoningEffort>[];
    if (efforts.isEmpty) {
      onModelAndEffortSelected(selectedModel, null);
      return;
    }
    final selectedEffort = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => FractionallySizedBox(
        heightFactor: 0.72,
        child: _EffortPickerSheet(
          efforts: efforts,
          selected: _sameModel(selectedModel, effectiveModel)
              ? effectiveModel?.reasoningEffort
              : selectedModel.defaultReasoningEffort,
          showBack: true,
        ),
      ),
    );
    if (!context.mounted || selectedEffort == null) {
      return;
    }
    if (selectedEffort.isEmpty) {
      await _pickModelAndEffort(context);
      return;
    }
    onModelAndEffortSelected(selectedModel, selectedEffort);
  }

  Future<void> _pickPermissionMode(BuildContext context) async {
    final selected = await showModalBottomSheet<ModeOption>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) => _PermissionModePickerSheet(
        modes: modes,
        selected: selectedPermissionMode,
      ),
    );
    if (!context.mounted || selected == null) return;
    onPermissionModeSelected(selected);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final option = _findModelOption(models, effectiveModel);
    final efforts = option?.reasoningEfforts ?? const <ReasoningEffort>[];
    final rawModelID = effectiveModel?.modelID ?? legacyModel;
    // Never surface the raw model id in the bar — that is what makes the
    // composer read like a debug console. The advertised label is preferred but
    // NOT trusted: it comes straight from broker JSON and real brokers ship
    // labels that embed the id ("Opus · claude-opus-4-8"), so it is sanitized
    // first, then derived from the id, then generic. The full id and the effort
    // both live in the tooltip.
    final modelLabel =
        _humanModelLabel(option?.label, rawModelID) ??
        _shortModelLabel(rawModelID) ??
        l10n.sessionComposerModelGenericLabel;
    final effortValue = effectiveModel?.reasoningEffort;
    final effortLabel = efforts
        .where((item) => item.effort == effortValue)
        .map((item) => item.label)
        .firstOrNull;
    final showModel =
        models.isNotEmpty || effectiveModel != null || legacyModel != null;
    final modelTooltip = _modelTooltip(
      l10n,
      rawModelID,
      effortLabel ?? effortValue,
    );
    ModeOption? modeOption;
    for (final mode in modes) {
      if (mode.value == selectedPermissionMode) {
        modeOption = mode;
        break;
      }
    }
    final detached =
        connectionStatus == SessionDetailConnectionStatus.disconnected ||
        connectionStatus == SessionDetailConnectionStatus.closed;

    final left = SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (showModel)
            _ComposerPickerButton(
              key: const Key('session-detail-model-selector'),
              icon: Icons.tune,
              label: modelLabel,
              tooltip: modelTooltip,
              onPressed: enabled && models.isNotEmpty
                  ? () => unawaited(_pickModelAndEffort(context))
                  : null,
            ),
          if (showModel && (agents.isNotEmpty || modes.isNotEmpty))
            const _ComposerPickerDot(),
          // Agent/mode control (e.g. opencode build/plan): advertised-data
          // only — absent when the adapter advertises no agents.
          if (agents.isNotEmpty)
            _ComposerAgentControl(
              agents: agents,
              currentAgent: currentAgent,
              enabled: enabled,
              compact: collapsed,
              onSelected: onAgentSelected,
            ),
          if (agents.isNotEmpty && modes.isNotEmpty) const _ComposerPickerDot(),
          if (modes.isNotEmpty)
            _ComposerPickerButton(
              key: const Key('session-detail-permission-selector'),
              icon: Icons.shield_outlined,
              // The "· commands" qualifier moves to the tooltip; the bar shows
              // the bare mode label (icon + status dot when collapsed).
              label: modeOption?.label ?? l10n.sessionPermissionModeFallback,
              tooltip: l10n.sessionPermissionModeTooltip,
              compact: collapsed,
              onPressed: enabled
                  ? () => unawaited(_pickPermissionMode(context))
                  : null,
            ),
          // Information, not an action, so it stays left of the action
          // cluster. Renders nothing when the agent advertises no context
          // window — a missing meter is correct, an invented one is not.
          Padding(
            padding: const EdgeInsets.only(left: 8),
            child: SessionContextMeter(
              telemetry: telemetry,
              style: collapsed
                  ? SessionContextMeterStyle.ring
                  : SessionContextMeterStyle.verbose,
            ),
          ),
        ],
      ),
    );

    final rightCluster = <Widget>[
      _ComposerIconButton(
        buttonKey: const Key('session-detail-command-picker-button'),
        tooltip: AppLocalizations.of(context).sessionComposerMenuSlashCommands,
        touch: touch,
        onPressed: onOpenCommandPicker,
        icon: const Icon(kSlashCommandIcon, size: 16),
      ),
      if (detached)
        _ComposerIconButton(
          buttonKey: const Key('session-detail-composer-attach'),
          tooltip: AppLocalizations.of(context).sessionAttach,
          touch: touch,
          onPressed: onReattach,
          icon: const Icon(Icons.link, size: 16),
        ),
    ];

    return Row(
      key: const Key('session-detail-composer-bottom-bar'),
      children: [
        Expanded(
          child: Align(alignment: Alignment.centerLeft, child: left),
        ),
        ...rightCluster,
      ],
    );
  }
}

/// Quiet control-row icon button: 16px glyph, 28dp box on desktop and a 40dp
/// minimum hit target on touch.
///
/// The glyph is 16px rather than 18px so it sits level with the adjacent
/// `labelMedium`/`bodyMedium` text instead of out-weighing it; the box and hit
/// target are unchanged, so tap affordance is untouched. The [buttonKey] is
/// applied to the inner [IconButton] so callers can still
/// `find.byKey(...).widget<IconButton>`.
class _ComposerIconButton extends StatelessWidget {
  const _ComposerIconButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.buttonKey,
    this.isSelected = false,
    this.selectedColor,
    this.touch = false,
  });

  final Widget icon;
  final String tooltip;
  final VoidCallback? onPressed;
  final Key? buttonKey;
  final bool isSelected;
  final Color? selectedColor;
  final bool touch;

  @override
  Widget build(BuildContext context) {
    final dim = touch ? 40.0 : 28.0;
    return IconButton(
      key: buttonKey,
      tooltip: tooltip,
      onPressed: onPressed,
      isSelected: isSelected,
      color: isSelected ? selectedColor : null,
      iconSize: 16,
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
      constraints: BoxConstraints(minWidth: dim, minHeight: dim),
      icon: icon,
    );
  }
}

/// Borderless model/permission selector: a leading 14px glyph, a `labelMedium`
/// label, and a 14px chevron. When [compact] (permission below 420dp) it drops
/// to an icon plus a status dot, with the full label living in the tooltip.
class _ComposerPickerButton extends StatelessWidget {
  const _ComposerPickerButton({
    required this.icon,
    required this.label,
    required this.tooltip,
    required this.onPressed,
    this.compact = false,
    super.key,
  });

  final IconData icon;
  final String label;
  final String tooltip;
  final VoidCallback? onPressed;

  /// Icon-only rendering with a status dot (permission at narrow width).
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final labelStyle = theme.textTheme.labelMedium?.copyWith(
      fontWeight: FontWeight.w500,
      color: scheme.onSurfaceVariant,
    );
    final Widget child = compact
        ? Stack(
            clipBehavior: Clip.none,
            children: [
              Icon(icon, size: 16, color: scheme.onSurfaceVariant),
              Positioned(
                right: -2,
                top: -1,
                child: Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    color: scheme.primary,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            ],
          )
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 14, color: scheme.onSurfaceVariant),
              const SizedBox(width: 5),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 1),
              Icon(
                Icons.keyboard_arrow_down,
                size: 14,
                color: scheme.onSurfaceVariant.withValues(alpha: 0.7),
              ),
            ],
          );
    return Tooltip(
      message: tooltip,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 220),
        child: TextButton(
          onPressed: onPressed,
          style: TextButton.styleFrom(
            visualDensity: VisualDensity.compact,
            padding: EdgeInsets.symmetric(
              horizontal: compact ? 6 : 8,
              vertical: 4,
            ),
            minimumSize: Size.zero,
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            foregroundColor: scheme.onSurfaceVariant,
            textStyle: labelStyle,
          ),
          child: child,
        ),
      ),
    );
  }
}

class _ModelPickerSheet extends StatefulWidget {
  const _ModelPickerSheet({required this.models, required this.selected});

  final List<ModelOption> models;
  final SessionCurrentModel? selected;

  @override
  State<_ModelPickerSheet> createState() => _ModelPickerSheetState();
}

class _ModelPickerSheetState extends State<_ModelPickerSheet> {
  late final TextEditingController _filterController;

  @override
  void initState() {
    super.initState();
    _filterController = TextEditingController()..addListener(_onFilterChanged);
  }

  @override
  void dispose() {
    _filterController
      ..removeListener(_onFilterChanged)
      ..dispose();
    super.dispose();
  }

  void _onFilterChanged() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final query = _filterController.text.trim().toLowerCase();
    final visible = widget.models
        .where((model) {
          if (query.isEmpty) {
            return true;
          }
          return model.label.toLowerCase().contains(query) ||
              model.modelID.toLowerCase().contains(query) ||
              model.providerID.toLowerCase().contains(query) ||
              (model.variant?.toLowerCase().contains(query) ?? false);
        })
        .toList(growable: false);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l10n.chooseModel,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('session-detail-model-filter'),
              controller: _filterController,
              autofocus: true,
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search),
                hintText: l10n.searchModels,
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: visible.isEmpty
                  ? Center(child: SelectableText(l10n.noMatchingModels))
                  : ListView.builder(
                      itemCount: visible.length,
                      itemBuilder: (context, index) {
                        final model = visible[index];
                        final selected = _sameModel(model, widget.selected);
                        final variant = model.variant;
                        return ListTile(
                          key: ValueKey(
                            'session-detail-model-option-'
                            '${model.providerID}/${model.modelID}/${variant ?? ''}',
                          ),
                          selected: selected,
                          leading: Icon(
                            selected
                                ? Icons.radio_button_checked
                                : Icons.radio_button_off,
                          ),
                          title: Text(model.label),
                          subtitle: Text(
                            [
                              model.providerID,
                              model.modelID,
                              if (variant != null && variant.isNotEmpty)
                                variant,
                            ].join(' · '),
                          ),
                          onTap: () => Navigator.of(context).pop(model),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EffortPickerSheet extends StatelessWidget {
  const _EffortPickerSheet({
    required this.efforts,
    required this.selected,
    this.showBack = false,
  });

  final List<ReasoningEffort> efforts;
  final String? selected;
  final bool showBack;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                if (showBack)
                  IconButton(
                    key: const Key('session-detail-effort-back'),
                    tooltip: l10n.backToModels,
                    onPressed: () => Navigator.of(context).pop(''),
                    icon: const Icon(Icons.arrow_back),
                  ),
                Text(
                  l10n.reasoningEffort,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ],
            ),
            const SizedBox(height: 8),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final effort in efforts)
                    ListTile(
                      key: ValueKey(
                        'session-detail-effort-option-${effort.effort}',
                      ),
                      leading: Icon(
                        selected == effort.effort
                            ? Icons.radio_button_checked
                            : Icons.radio_button_off,
                      ),
                      title: Text(effort.label),
                      subtitle: effort.description == null
                          ? Text(effort.effort)
                          : Text(effort.description!),
                      onTap: () => Navigator.of(context).pop(effort.effort),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PermissionModePickerSheet extends StatelessWidget {
  const _PermissionModePickerSheet({
    required this.modes,
    required this.selected,
  });

  final List<ModeOption> modes;
  final String? selected;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final grouped = <String, List<ModeOption>>{};
    for (final mode in modes) {
      grouped.putIfAbsent(mode.category ?? 'custom', () => []).add(mode);
    }
    return SafeArea(
      child: FractionallySizedBox(
        heightFactor: 0.68,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          children: [
            Text(
              l10n.sessionPermissionModeSheetTitle,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(
              l10n.sessionPermissionModeSheetBody,
              key: const Key('session-detail-permission-command-only-copy'),
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 8),
            for (final group in grouped.entries) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Text(
                  _permissionModeCategoryLabel(l10n, group.key),
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              for (final mode in group.value)
                ListTile(
                  key: ValueKey(
                    'session-detail-permission-option-${mode.value}',
                  ),
                  selected: mode.value == selected,
                  leading: Icon(
                    mode.value == selected
                        ? Icons.radio_button_checked
                        : Icons.radio_button_off,
                  ),
                  title: Text(mode.label),
                  subtitle: mode.description == null
                      ? null
                      : Text(mode.description!),
                  onTap: () => Navigator.of(context).pop(mode),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

String _permissionModeCategoryLabel(
  AppLocalizations l10n,
  String category,
) => switch (category) {
  'ask-permission' => l10n.sessionPermissionModeAsk,
  'approve-for-me' => l10n.sessionPermissionModeApprove,
  'full-access' => l10n.sessionPermissionModeFullAccess,
  _ => l10n.sessionPermissionModeCustom,
};

ModelOption? _findModelOption(
  List<ModelOption> models,
  SessionCurrentModel? selected,
) {
  if (selected == null) {
    return null;
  }
  for (final model in models) {
    if (_sameModel(model, selected)) {
      return model;
    }
  }
  return null;
}

bool _sameModel(ModelOption model, SessionCurrentModel? selected) =>
    selected != null &&
    model.providerID == selected.providerID &&
    model.modelID == selected.modelID &&
    (model.variant ?? '') == (selected.variant ?? '');

class _PromptComposer extends ConsumerStatefulWidget {
  const _PromptComposer({
    required this.controller,
    required this.focusNode,
    required this.enabled,
    required this.controlsEnabled,
    required this.canSend,
    required this.isSubmitting,
    required this.canInterrupt,
    required this.interruptPhase,
    required this.isPickingAttachments,
    required this.isAttachmentIntakeBusy,
    required this.attachmentEnabled,
    required this.stagedAttachments,
    required this.onAttachFiles,
    required this.onBeginAttachmentIntake,
    required this.onReplaceAttachment,
    required this.onRemoveAttachment,
    required this.onSend,
    required this.onInterrupt,
    required this.connectionStatus,
    required this.models,
    required this.agents,
    required this.modes,
    required this.effectiveModel,
    required this.currentAgent,
    required this.selectedPermissionMode,
    required this.legacyModel,
    required this.telemetry,
    required this.onModelAndEffortSelected,
    required this.onAgentSelected,
    required this.onPermissionModeSelected,
    required this.onReattach,
    required this.onOpenCommandPicker,
    this.commands = const <SlashCommand>[],
  });

  /// Slash commands advertised for this session, used by the inline palette
  /// that opens when the prompt starts with `/`.
  final List<SlashCommand> commands;
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool enabled;

  /// Whether broker-bound composer controls may mutate the session.
  ///
  /// [enabled] governs only local text editing. Observing, Working, and
  /// reconnecting windows keep a durable local staging surface while Send,
  /// attachment transfer, and model/mode changes remain gated here.
  final bool controlsEnabled;
  final bool canSend;
  final bool isSubmitting;
  final bool canInterrupt;
  final SessionInterruptPhase interruptPhase;
  final bool isPickingAttachments;
  final bool isAttachmentIntakeBusy;
  final bool attachmentEnabled;
  final List<SessionStagedAttachment> stagedAttachments;
  final VoidCallback onAttachFiles;
  final _SessionAttachmentIntakeLease? Function() onBeginAttachmentIntake;
  final ValueChanged<String> onReplaceAttachment;
  final ValueChanged<String> onRemoveAttachment;
  final VoidCallback onSend;
  final VoidCallback onInterrupt;
  final SessionDetailConnectionStatus connectionStatus;
  final List<ModelOption> models;
  final List<AgentOption> agents;
  final List<ModeOption> modes;
  final SessionCurrentModel? effectiveModel;
  final String? currentAgent;
  final String? selectedPermissionMode;
  final String? legacyModel;
  final SessionTelemetry telemetry;
  final void Function(ModelOption model, String? effort)
  onModelAndEffortSelected;
  final ValueChanged<AgentOption> onAgentSelected;
  final ValueChanged<ModeOption> onPermissionModeSelected;
  final VoidCallback onReattach;
  final VoidCallback? onOpenCommandPicker;
  @override
  ConsumerState<_PromptComposer> createState() => _PromptComposerState();
}

/// Explains why prompt mutation is unavailable while preserving the editable
/// durable-draft surface directly below it.
class _ObserveComposerBar extends ConsumerStatefulWidget {
  const _ObserveComposerBar({
    required this.control,
    required this.sessionKey,
    required this.conflict,
  });

  final SessionControlView control;
  final SessionDetailKey sessionKey;
  final SessionDriveRestoreConflict? conflict;

  @override
  ConsumerState<_ObserveComposerBar> createState() =>
      _ObserveComposerBarState();
}

class _ObserveComposerBarState extends ConsumerState<_ObserveComposerBar> {
  bool _takeOverPending = false;
  bool _copyPending = false;

  Future<void> _takeOver() async {
    if (_takeOverPending || _copyPending) return;
    setState(() => _takeOverPending = true);
    try {
      await _confirmAndTakeOver(context, ref, widget.sessionKey);
    } finally {
      if (mounted) setState(() => _takeOverPending = false);
    }
  }

  Future<void> _copySyncCommand(String command) async {
    if (_copyPending || _takeOverPending) return;
    setState(() => _copyPending = true);
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);
    try {
      await Clipboard.setData(ClipboardData(text: command));
      if (!mounted) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(l10n.sessionSyncCommandCopied)),
        );
    } on PlatformException {
      if (!mounted) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(l10n.sessionCopyCommandFailed)),
        );
    } finally {
      if (mounted) setState(() => _copyPending = false);
    }
  }

  Widget _takeOverButton(AppLocalizations l10n) {
    return FilledButton(
      key: const Key('session-detail-composer-take-over-button'),
      onPressed: _takeOverPending || _copyPending
          ? null
          : () => unawaited(_takeOver()),
      child: Text(l10n.sessionTakeOver),
    );
  }

  Widget _copyButton(
    AppLocalizations l10n,
    String command, {
    required bool labeled,
  }) {
    final enabled = !_copyPending && !_takeOverPending;
    return Semantics(
      key: const Key('session-detail-composer-copy-sync-command'),
      label: l10n.sessionCopyTerminalSyncCommand,
      button: true,
      enabled: enabled,
      onTap: enabled ? () => unawaited(_copySyncCommand(command)) : null,
      child: ExcludeSemantics(
        child: labeled
            ? TextButton.icon(
                onPressed: enabled
                    ? () => unawaited(_copySyncCommand(command))
                    : null,
                icon: const Icon(Icons.content_copy_outlined, size: 16),
                label: Text(l10n.sessionCopySyncCommand),
              )
            : Tooltip(
                message: l10n.sessionCopyTerminalSyncCommand,
                child: IconButton(
                  onPressed: enabled
                      ? () => unawaited(_copySyncCommand(command))
                      : null,
                  icon: const Icon(Icons.content_copy_outlined, size: 16),
                  style: IconButton.styleFrom(
                    padding: EdgeInsets.zero,
                    minimumSize: const Size.square(40),
                    maximumSize: const Size.square(40),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                ),
              ),
      ),
    );
  }

  Widget _syncChoiceBar(
    BuildContext context,
    AppLocalizations l10n,
    String command,
    BoxConstraints constraints,
    String? takeoverRefusal,
  ) {
    final tokens = context.tokens;
    final compact = constraints.maxWidth <= kObserveComposerActionCollapseWidth;
    final roomy = constraints.maxWidth >= 600;
    final largeText = MediaQuery.textScalerOf(context).scale(1) >= 1.5;
    final hasTakeOver = widget.control.canTakeOver;
    final description =
        takeoverRefusal ??
        (roomy
            ? l10n.sessionComposerTerminalNotSynced
            : l10n.sessionComposerTerminalNotSyncedCompact);
    final showPersistentRefusal = takeoverRefusal != null;
    final copy = _copyButton(l10n, command, labeled: !compact);
    final takeOver = hasTakeOver ? _takeOverButton(l10n) : null;

    List<Widget> actionChildren({required bool showOr}) => [
      copy,
      if (showOr && takeOver != null)
        Text(
          l10n.sessionChoiceOr,
          style: Theme.of(
            context,
          ).textTheme.bodySmall?.copyWith(color: tokens.textSecondary),
        ),
      if (takeOver != null) takeOver,
    ];

    Widget actions({required bool showOr, required bool allowWrap}) {
      final children = actionChildren(showOr: showOr);
      return allowWrap
          ? Wrap(
              alignment: WrapAlignment.end,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 8,
              runSpacing: 8,
              children: children,
            )
          : Row(
              mainAxisSize: MainAxisSize.min,
              spacing: 8,
              children: children,
            );
    }

    final explanation = SelectionArea(
      child: Text(
        description,
        key: Key(
          showPersistentRefusal
              ? 'session-detail-observe-composer-refusal'
              : 'session-detail-observe-composer-description',
        ),
        style:
            Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(
              color: showPersistentRefusal
                  ? tokens.statusError
                  : tokens.textSecondary,
            ),
      ),
    );

    final stackContent = largeText || showPersistentRefusal;

    return Semantics(
      container: true,
      label: description,
      child: Container(
        key: const Key('session-detail-observe-composer-bar'),
        constraints: BoxConstraints(minHeight: stackContent ? 64 : 40),
        height: stackContent ? null : 40,
        padding: EdgeInsets.symmetric(
          horizontal: 12,
          vertical: stackContent ? 8 : 0,
        ),
        decoration: BoxDecoration(
          color: tokens.surface,
          borderRadius: BorderRadius.circular(tokens.radiusLg),
        ),
        child: stackContent
            ? Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  explanation,
                  const SizedBox(height: 8),
                  Align(
                    alignment: AlignmentDirectional.centerEnd,
                    child: actions(showOr: compact, allowWrap: true),
                  ),
                ],
              )
            : Row(
                children: [
                  Expanded(child: explanation),
                  const SizedBox(width: 8),
                  actions(showOr: compact, allowWrap: false),
                ],
              ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final conflict = widget.conflict;
    final takeoverRefusal = conflict?.reason == kDriveAttachReasonTakeover
        ? _driveConflictFeedback(l10n, conflict!)
        : null;
    final joinCommand = _usableJoinCommand(widget.control);
    final takeOverOnly =
        joinCommand == null &&
        widget.control.action == SessionControlAction.join &&
        widget.control.canTakeOver;
    final joinUnavailable =
        joinCommand == null &&
        widget.control.action == SessionControlAction.join &&
        !widget.control.canTakeOver;
    final description =
        takeoverRefusal ??
        (joinUnavailable
            ? l10n.sessionControlUnavailableDescription
            : takeOverOnly
            ? l10n.sessionControlObservingDescription
            : _controlStatusDescription(l10n, widget.control));
    final stateLabel = switch (widget.control.pill) {
      SessionControlPill.synced => l10n.sessionControlSynced,
      SessionControlPill.driving => l10n.sessionControlDriving,
      SessionControlPill.syncAvailable => l10n.sessionControlSyncAvailable,
      SessionControlPill.observing => l10n.sessionControlObserving,
      SessionControlPill.unavailable => l10n.sessionControlUnavailable,
      SessionControlPill.unknown => l10n.sessionControlUnknownDescription,
    };
    final icon = switch (widget.control.pill) {
      SessionControlPill.observing => Icons.visibility_outlined,
      SessionControlPill.synced => Icons.sync,
      SessionControlPill.syncAvailable when !takeOverOnly => Icons.sync,
      SessionControlPill.syncAvailable => Icons.visibility_outlined,
      _ => Icons.block_outlined,
    };

    return LayoutBuilder(
      builder: (context, constraints) {
        if (joinCommand != null) {
          return _syncChoiceBar(
            context,
            l10n,
            joinCommand,
            constraints,
            takeoverRefusal,
          );
        }
        final compact =
            constraints.maxWidth <= kObserveComposerActionCollapseWidth;
        Widget? action;
        if (widget.control.canTakeOver) {
          final button = _takeOverButton(l10n);
          action = compact
              ? Tooltip(message: description, child: button)
              : button;
        }
        final hideDescription = compact && action != null;
        return Semantics(
          container: true,
          label: '$stateLabel. $description',
          child: Container(
            key: const Key('session-detail-observe-composer-bar'),
            height: 40,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              color: tokens.surface,
              borderRadius: BorderRadius.circular(tokens.radiusLg),
            ),
            child: Row(
              children: [
                Icon(icon, size: 16, color: tokens.textSecondary),
                const SizedBox(width: 8),
                if (!hideDescription)
                  Expanded(
                    child: ExcludeSemantics(
                      child: SelectionArea(
                        child: Text(
                          description,
                          key: Key(
                            takeoverRefusal != null
                                ? 'session-detail-observe-composer-refusal'
                                : 'session-detail-observe-composer-description',
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(
                                color: takeoverRefusal != null
                                    ? tokens.statusError
                                    : tokens.textSecondary,
                              ),
                        ),
                      ),
                    ),
                  )
                else
                  const Spacer(),
                if (action != null) action,
              ],
            ),
          ),
        );
      },
    );
  }
}

class _PromptComposerState extends ConsumerState<_PromptComposer>
    with _SlashPaletteHost, _SessionAttachmentIntakeComposerHost {
  bool _voiceWasRequested = false;
  bool _focused = false;
  bool _hovered = false;
  @override
  void initState() {
    super.initState();
    _focused = widget.focusNode.hasFocus;
    _initializeAttachmentIntake();
    widget.focusNode.addListener(_onFocusChanged);
    _attachPaletteListener();
  }

  @override
  void didUpdateWidget(covariant _PromptComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.focusNode != widget.focusNode) {
      oldWidget.focusNode.removeListener(_onFocusChanged);
      widget.focusNode.addListener(_onFocusChanged);
      _focused = widget.focusNode.hasFocus;
    }
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_syncSlashPalette);
      _attachPaletteListener();
      _moveAttachmentPasteAnchors(oldWidget.controller);
    }
  }

  @override
  void dispose() {
    widget.focusNode.removeListener(_onFocusChanged);
    _disposeAttachmentIntake();
    _detachPaletteListener();
    super.dispose();
  }

  void _onFocusChanged() {
    final focused = widget.focusNode.hasFocus;
    if (focused != _focused && mounted) {
      setState(() => _focused = focused);
    }
  }

  void _setHovered(bool hovered) {
    if (hovered != _hovered && mounted) {
      setState(() => _hovered = hovered);
    }
  }

  Future<void> _onMicTap() async {
    final voiceState = ref.read(voiceInputControllerProvider);
    if (!voiceState.capabilities.recognition) return;
    if (voiceState.isActive) return;
    var policy = voiceState.chosenPolicy;
    if (policy == null) {
      policy = await showVoicePolicyChooser(
        context,
        onDeviceAvailable: voiceState.capabilities.onDeviceRecognition,
      );
      if (policy == null || !mounted) return;
    }
    setState(() => _voiceWasRequested = true);
    await ref.read(voiceInputControllerProvider.notifier).begin(policy);
  }

  void _insertTranscript(String transcript) {
    final controller = widget.controller;
    controller.value = insertVoiceTranscript(controller.value, transcript);
    widget.focusNode.requestFocus();
  }

  bool _canSend(VoiceInputState voiceState) =>
      widget.canSend &&
      widget.interruptPhase == SessionInterruptPhase.idle &&
      !voiceState.isActive;
  bool _isPlatformSendChord() {
    final keyboard = HardwareKeyboard.instance;
    final platform = Theme.of(context).platform;
    final usesMeta = !kIsWeb && platform == TargetPlatform.macOS;
    if (usesMeta) {
      return keyboard.isMetaPressed &&
          !keyboard.isControlPressed &&
          !keyboard.isAltPressed &&
          !keyboard.isShiftPressed;
    }
    final usesControl =
        kIsWeb ||
        platform == TargetPlatform.windows ||
        platform == TargetPlatform.linux;
    return usesControl &&
        keyboard.isControlPressed &&
        !keyboard.isMetaPressed &&
        !keyboard.isAltPressed &&
        !keyboard.isShiftPressed;
  }

  KeyEventResult _onComposerKey(FocusNode node, KeyEvent event) {
    // Slash completion owns Enter/Tab while its palette is open.
    final paletteResult = _onPaletteKey(node, event);
    if (paletteResult == KeyEventResult.handled) {
      return paletteResult;
    }
    final pasteResult = _handleAttachmentPasteKey(event);
    if (pasteResult != null) return pasteResult;
    if (event.logicalKey != LogicalKeyboardKey.enter ||
        !_isPlatformSendChord()) {
      return KeyEventResult.ignored;
    }
    // Consume repeats and blocked chords so they cannot insert a newline or
    // accidentally submit twice while the first action is in flight.
    if (event is KeyRepeatEvent) {
      return KeyEventResult.handled;
    }
    if (event is! KeyDownEvent) {
      return KeyEventResult.ignored;
    }
    final composing = widget.controller.value.composing;
    if (!composing.isValid || composing.isCollapsed) {
      final voiceState = ref.read(voiceInputControllerProvider);
      if (_canSend(voiceState)) {
        widget.onSend();
      }
    }
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);

    ref.listen<VoiceInputState>(voiceInputControllerProvider, (previous, next) {
      if (next.isReady && !(previous?.isReady ?? false)) {
        final transcript = ref
            .read(voiceInputControllerProvider.notifier)
            .consumeReady();
        if (transcript != null && transcript.isNotEmpty) {
          _insertTranscript(transcript);
        }
      }
    });

    final voiceState = ref.watch(voiceInputControllerProvider);
    final voiceActive = voiceState.isActive;
    final voiceStatus = _voiceWasRequested
        ? switch (voiceState.inputState) {
            SpeechInputError(:final kind, :final reason) =>
              _voiceFailureMessage(l10n, kind, reason),
            SpeechInputUnavailable(:final kind, :final reason) =>
              _voiceFailureMessage(l10n, kind, reason),
            _ => null,
          }
        : null;

    final scheme = theme.colorScheme;
    final isDark = theme.brightness == Brightness.dark;
    final platform = theme.platform;
    final touch =
        platform == TargetPlatform.android ||
        platform == TargetPlatform.iOS ||
        platform == TargetPlatform.fuchsia;

    final canAttach =
        widget.controlsEnabled &&
        !widget.isSubmitting &&
        !widget.isPickingAttachments &&
        widget.attachmentEnabled;
    final hasAttachments = widget.stagedAttachments.isNotEmpty;

    final canMic =
        widget.enabled &&
        !widget.isSubmitting &&
        !widget.isPickingAttachments &&
        !voiceActive &&
        voiceState.capabilities.recognition;

    final effectiveCanSend = _canSend(voiceState);
    final effectiveCanAttach = canAttach && !voiceActive;

    // Variant A: one rounded container reads as a single object. The 1dp
    // separator border only shows on focus/hover; a transparent 1dp border at
    // rest keeps the size stable so the field does not jump.
    final borderActive = (_focused || _hovered) && widget.enabled;

    // Non-null only while the prompt is a leading-slash command in progress.
    final slashPalette = _buildSlashPalette();

    final sendIcon = widget.isSubmitting
        ? const SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          )
        : const Icon(Icons.arrow_upward, size: 16);

    final sendButton = Tooltip(
      message: l10n.sessionComposerSendTooltip,
      child: IconButton(
        key: const Key('session-detail-send-button'),
        onPressed: effectiveCanSend ? widget.onSend : null,
        icon: sendIcon,
        padding: EdgeInsets.zero,
        visualDensity: VisualDensity.compact,
        constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
        style: IconButton.styleFrom(
          backgroundColor: scheme.primary,
          foregroundColor: scheme.onPrimary,
          disabledBackgroundColor: scheme.surfaceContainerHighest,
          disabledForegroundColor: scheme.onSurfaceVariant.withValues(
            alpha: 0.5,
          ),
          minimumSize: const Size(32, 32),
          fixedSize: const Size(32, 32),
          padding: EdgeInsets.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: const CircleBorder(),
        ),
      ),
    );
    final interruptBusy =
        widget.interruptPhase == SessionInterruptPhase.sending;
    final interruptButton = Tooltip(
      message: l10n.sessionComposerInterruptTooltip,
      child: IconButton(
        key: const Key('session-detail-interrupt-button'),
        onPressed: widget.interruptPhase == SessionInterruptPhase.idle
            ? widget.onInterrupt
            : null,
        icon: interruptBusy
            ? const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.stop, size: 16),
        padding: EdgeInsets.zero,
        visualDensity: VisualDensity.compact,
        constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
        style: IconButton.styleFrom(
          backgroundColor: tokens.statusError,
          foregroundColor: scheme.onError,
          disabledBackgroundColor: tokens.surface2,
          disabledForegroundColor: tokens.textTertiary,
          minimumSize: const Size(32, 32),
          fixedSize: const Size(32, 32),
          padding: EdgeInsets.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: const CircleBorder(),
        ),
      ),
    );

    final controlRow = LayoutBuilder(
      builder: (context, constraints) {
        final collapsed = constraints.maxWidth < kComposerCollapseWidth;
        return ConstrainedBox(
          constraints: BoxConstraints(minHeight: touch ? 40 : 32),
          child: Row(
            children: [
              Expanded(
                child: _ComposerBottomBar(
                  enabled: widget.controlsEnabled,
                  connectionStatus: widget.connectionStatus,
                  models: widget.models,
                  agents: widget.agents,
                  modes: widget.modes,
                  effectiveModel: widget.effectiveModel,
                  currentAgent: widget.currentAgent,
                  selectedPermissionMode: widget.selectedPermissionMode,
                  legacyModel: widget.legacyModel,
                  telemetry: widget.telemetry,
                  onModelAndEffortSelected: widget.onModelAndEffortSelected,
                  onAgentSelected: widget.onAgentSelected,
                  onPermissionModeSelected: widget.onPermissionModeSelected,
                  onReattach: widget.onReattach,
                  onOpenCommandPicker: widget.onOpenCommandPicker,
                  collapsed: collapsed,
                  touch: touch,
                ),
              ),
              const SizedBox(width: 4),
              _ComposerIconButton(
                buttonKey: const Key('session-detail-attach-button'),
                tooltip: widget.attachmentEnabled
                    ? l10n.sessionAttachmentAddTooltip
                    : l10n.sessionAttachmentUnsupportedTooltip,
                touch: touch,
                onPressed: effectiveCanAttach ? widget.onAttachFiles : null,
                icon: widget.isPickingAttachments
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.attach_file, size: 16),
              ),
              _ComposerIconButton(
                buttonKey: const Key('session-detail-voice-input-button'),
                tooltip: l10n.sessionVoiceInputTooltip,
                touch: touch,
                isSelected: voiceState.isListening,
                selectedColor: scheme.primary,
                onPressed: canMic ? _onMicTap : null,
                icon: Icon(
                  voiceState.isListening ? Icons.mic : Icons.mic_none,
                  size: 16,
                ),
              ),
              const SizedBox(width: 4),
              // During a working turn on an interrupt-capable agent, show both
              // Send (queues a steer/follow-up) and Stop (interrupts). The
              // controller and broker support queueing - hiding Send during
              // working made steer impossible. Stop stays rightmost as the
              // urgent/destructive action; Send sits to its left and remains
              // gated by effectiveCanSend (text non-empty, not mid-HTTP-send).
              if (widget.canInterrupt) ...[
                sendButton,
                const SizedBox(width: 4),
                interruptButton,
              ] else if (widget.controlsEnabled)
                sendButton,
            ],
          ),
        );
      },
    );

    final composer = MouseRegion(
      onEnter: (_) => _setHovered(true),
      onExit: (_) => _setHovered(false),
      child: Container(
        key: const Key('session-detail-composer'),
        decoration: BoxDecoration(
          color: isDark ? scheme.surfaceContainerHigh : scheme.surface,
          borderRadius: BorderRadius.circular(tokens.radiusLg),
          border: Border.all(
            color: borderActive
                ? scheme.outlineVariant.withValues(alpha: 0.6)
                : tokens.surface.withValues(alpha: 0),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (slashPalette != null) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
                child: slashPalette,
              ),
              Divider(
                height: 8,
                thickness: 1,
                color: scheme.outlineVariant.withValues(alpha: 0.5),
              ),
            ],
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              child: Focus(
                // Sits below the app-level default shortcuts in the focus
                // chain, so palette keys win over caret/newline/traversal.
                canRequestFocus: false,
                skipTraversal: true,
                onKeyEvent: _onComposerKey,
                child: TextField(
                  key: const Key('session-detail-prompt-input'),
                  controller: widget.controller,
                  focusNode: widget.focusNode,
                  minLines: 1,
                  maxLines: 6,
                  // Keep drafting the next turn while the submitted snapshot
                  // waits for its terminal receipt. Send/attachment controls
                  // remain guarded by [isSubmitting].
                  enabled: widget.enabled,
                  keyboardType: TextInputType.multiline,
                  textInputAction: TextInputAction.newline,
                  style: theme.textTheme.bodyMedium,
                  decoration: InputDecoration(
                    hintText: widget.controlsEnabled
                        ? l10n.sessionComposerPromptHint
                        : l10n.sessionComposerDraftHint,
                    hintStyle: theme.textTheme.bodyMedium?.copyWith(
                      color: scheme.onSurfaceVariant.withValues(alpha: 0.7),
                    ),
                    // Borderless: the container edge is the only boundary.
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    disabledBorder: InputBorder.none,
                    filled: false,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 4),
                  ),
                ),
              ),
            ),
            if (voiceState.isListening || voiceState.isProcessing)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                child: VoiceInputPanel(
                  state: voiceState,
                  onStop: () =>
                      ref.read(voiceInputControllerProvider.notifier).stop(),
                  onCancel: () =>
                      ref.read(voiceInputControllerProvider.notifier).cancel(),
                ),
              ),
            if (voiceStatus != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                child: SelectableText(
                  key: const Key('voice-input-status'),
                  voiceStatus,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.error,
                  ),
                ),
              ),
            // DR1: text past the durable-draft cap is never truncated to fit —
            // persistence is refused and the user is told the recovery copies
            // do not cover it. Derived from the live controller value so it
            // needs no controller round trip and can never go stale.
            ValueListenableBuilder<TextEditingValue>(
              valueListenable: widget.controller,
              builder: (context, value, _) {
                if (value.text.length <= maxLocalDraftTextChars) {
                  return const SizedBox.shrink();
                }
                return Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                  child: Text(
                    key: const Key('session-draft-too-long-status'),
                    l10n.sessionDraftTooLongStatus,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                );
              },
            ),
            if (hasAttachments)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                child: _AttachmentChipWrap(
                  attachments: widget.stagedAttachments,
                  touch: touch,
                  busy: widget.isSubmitting || widget.isPickingAttachments,
                  onReplace: widget.onReplaceAttachment,
                  onRemove: widget.onRemoveAttachment,
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 8, 4),
              child: controlRow,
            ),
          ],
        ),
      ),
    );
    return _wrapAttachmentDropTarget(composer);
  }
}

class _AttachmentChipWrap extends StatelessWidget {
  const _AttachmentChipWrap({
    required this.attachments,
    required this.touch,
    required this.busy,
    required this.onReplace,
    required this.onRemove,
  });

  final List<SessionStagedAttachment> attachments;
  final bool touch;
  final bool busy;
  final ValueChanged<String> onReplace;
  final ValueChanged<String> onRemove;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final attachment in attachments)
          _AttachmentChip(
            key: ValueKey(attachment.localId),
            attachment: attachment,
            touch: touch,
            busy: busy,
            onReplace: () => onReplace(attachment.localId),
            onRemove: () => onRemove(attachment.localId),
          ),
      ],
    );
  }
}

class _AttachmentChip extends StatelessWidget {
  const _AttachmentChip({
    required this.attachment,
    required this.touch,
    required this.busy,
    required this.onReplace,
    required this.onRemove,
    super.key,
  });

  final SessionStagedAttachment attachment;
  final bool touch;
  final bool busy;
  final VoidCallback onReplace;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final isError = attachment.phase == SessionAttachmentUploadPhase.error;
    final status = switch (attachment.phase) {
      SessionAttachmentUploadPhase.uploading =>
        l10n.sessionAttachmentStagingStatus,
      SessionAttachmentUploadPhase.sent => l10n.sessionAttachmentStagedStatus,
      SessionAttachmentUploadPhase.error => l10n.sessionAttachmentFailedStatus,
      _ when attachment.isInline => l10n.sessionAttachmentInlineStatus,
      _ => l10n.sessionAttachmentReadyStatus,
    };
    final statusColor = isError ? tokens.statusError : tokens.textSecondary;
    final target = touch ? 40.0 : 28.0;
    final semanticLabel = l10n.sessionAttachmentSemanticLabel(
      attachment.attachment.name,
      attachment.attachment.byteLength,
      status,
    );

    return Semantics(
      container: true,
      label: semanticLabel,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: tokens.surface2,
          borderRadius: BorderRadius.circular(tokens.radiusSm),
          border: Border.all(
            color: isError ? tokens.statusError : tokens.separator,
          ),
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: target, maxWidth: 360),
          child: Padding(
            padding: const EdgeInsets.only(left: 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  isError ? Icons.error_outline : Icons.attach_file,
                  size: 16,
                  color: statusColor,
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        attachment.attachment.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.labelMedium,
                      ),
                      Text(
                        l10n.sessionAttachmentSizeAndStatus(
                          attachment.attachment.byteLength,
                          status,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: statusColor,
                        ),
                      ),
                    ],
                  ),
                ),
                _ComposerIconButton(
                  buttonKey: ValueKey(
                    'session-detail-attachment-replace-${attachment.localId}',
                  ),
                  tooltip: l10n.sessionAttachmentReplaceTooltip,
                  touch: touch,
                  onPressed: busy ? null : onReplace,
                  icon: const Icon(Icons.swap_horiz, size: 16),
                ),
                _ComposerIconButton(
                  buttonKey: ValueKey(
                    'session-detail-attachment-remove-${attachment.localId}',
                  ),
                  tooltip: l10n.sessionAttachmentRemoveTooltip,
                  touch: touch,
                  onPressed: busy ? null : onRemove,
                  icon: const Icon(Icons.close, size: 16),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The slash-command picker, hosted in a modal sheet.
///
/// It used to sit permanently above the composer, costing ~70px of vertical
/// space on every session whether or not commands were ever used. The sheet is
/// opened from the composer bar's terminal icon instead.
///
/// Selection and args parsing stay owned by `_SessionDetailPageState` — the
/// shared [argsController] is the same object the page validates and sends
/// from, and [onCommandSelected] runs the page's default-args prefill. The
/// local mirrors here exist only because a route pushed onto the Navigator
/// does not rebuild when the page calls `setState`.
class _CommandPickerSheet extends StatefulWidget {
  const _CommandPickerSheet({
    required this.commands,
    required this.initialCommandName,
    required this.argsController,
    required this.isEnabled,
    required this.hasModelOverride,
    required this.onCommandSelected,
    required this.onSend,
  });

  final List<SlashCommand> commands;
  final String? initialCommandName;
  final TextEditingController argsController;
  final bool isEnabled;

  /// Mirrors the page's model-override state so args validation here reaches
  /// the same verdict as `_sendCommand`.
  final bool hasModelOverride;

  final ValueChanged<String?> onCommandSelected;

  /// Sends the selected command; resolves true when the broker accepted it.
  final Future<bool> Function() onSend;

  @override
  State<_CommandPickerSheet> createState() => _CommandPickerSheetState();
}

class _CommandPickerSheetState extends State<_CommandPickerSheet> {
  String? _selectedName;
  bool _isSubmitting = false;

  /// Defers a web-update handoff while this sheet is open (N3b).
  ///
  /// The selected command and its arguments live only here; returning to the
  /// underlying route after a handoff would discard both silently.
  VoidCallback? _releaseHandoffHold;

  @override
  void initState() {
    super.initState();
    _selectedName = widget.initialCommandName;
    widget.argsController.addListener(_onArgsChanged);
    _releaseHandoffHold = WebHandoffParticipants.instance.hold();
  }

  @override
  void dispose() {
    _releaseHandoffHold?.call();
    _releaseHandoffHold = null;
    widget.argsController.removeListener(_onArgsChanged);
    super.dispose();
  }

  void _onArgsChanged() {
    if (mounted) setState(() {});
  }

  bool get _hasCommands => widget.commands.isNotEmpty;

  SlashCommand? get _selectedCommand {
    final name = _selectedName;
    if (name == null) return null;
    for (final command in widget.commands) {
      if (command.name == name) return command;
    }
    return null;
  }

  String? get _argsError => parseSessionCommandArgs(
    widget.argsController.text,
    hasModelOverride: widget.hasModelOverride,
  ).error;

  bool get _canSend =>
      widget.isEnabled &&
      !_isSubmitting &&
      _hasCommands &&
      _selectedCommand != null &&
      _argsError == null;

  void _select(String? name) {
    setState(() => _selectedName = name);
    widget.onCommandSelected(name);
  }

  Future<void> _send() async {
    if (!_canSend) return;
    setState(() => _isSubmitting = true);
    final sent = await widget.onSend();
    if (!mounted) return;
    setState(() => _isSubmitting = false);
    if (sent) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final sortedNames =
        widget.commands.map((command) => command.name).toSet().toList()..sort();
    final selectedCommand = _selectedCommand;
    final argsError = _argsError;

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          16,
          0,
          16,
          16 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(l10n.slashCommand, style: theme.textTheme.titleMedium),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    key: const Key('session-detail-command-picker'),
                    isExpanded: true,
                    hint: Text(
                      _hasCommands
                          ? l10n.selectCommand
                          : l10n.noCommandsAvailable,
                    ),
                    initialValue: _selectedName,
                    items: sortedNames
                        .map(
                          (name) => DropdownMenuItem<String>(
                            value: name,
                            child: Text(
                              name,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        )
                        .toList(),
                    onChanged:
                        widget.isEnabled && _hasCommands && !_isSubmitting
                        ? _select
                        : null,
                  ),
                ),
                const SizedBox(width: 6),
                IconButton(
                  key: const Key('session-detail-command-send-button'),
                  tooltip: l10n.sendCommand,
                  icon: _isSubmitting
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(kSlashCommandIcon),
                  onPressed: _canSend ? () => unawaited(_send()) : null,
                ),
              ],
            ),
            if (selectedCommand != null) ...[
              const SizedBox(height: 6),
              TextField(
                key: const Key('session-detail-command-args-input'),
                controller: widget.argsController,
                minLines: 1,
                maxLines: 3,
                enabled: widget.isEnabled && !_isSubmitting,
                keyboardType: TextInputType.multiline,
                style: theme.textTheme.bodySmall,
                decoration: InputDecoration(
                  hintText: l10n.sessionComposerCommandArgsHint,
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                  border: const OutlineInputBorder(),
                  errorText: argsError,
                ),
              ),
              if ((selectedCommand.description ?? '').isNotEmpty ||
                  (selectedCommand.usage ?? '').isNotEmpty) ...[
                const SizedBox(height: 8),
                SelectionArea(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if ((selectedCommand.description ?? '').isNotEmpty)
                        Text(
                          selectedCommand.description!,
                          style: theme.textTheme.bodySmall,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      if ((selectedCommand.usage ?? '').isNotEmpty)
                        Text(
                          selectedCommand.usage!,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                    ],
                  ),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

/// Maps a classified speech-input failure to a localized, actionable message.
///
/// Falls back to the platform-provided [reason] for the `unknown` kind so a
/// directly-emitted reason still surfaces. The raw diagnostic (`detail`) stays
/// out of this primary message and is reserved for Debug/logs.
String _voiceFailureMessage(
  AppLocalizations l10n,
  SpeechInputFailureKind kind,
  String reason,
) => switch (kind) {
  SpeechInputFailureKind.secureContext => l10n.voiceErrorSecureContext,
  SpeechInputFailureKind.permissionDenied => l10n.voiceErrorPermission,
  SpeechInputFailureKind.noCaptureDevice => l10n.voiceErrorNoDevice,
  SpeechInputFailureKind.serviceUnavailable => l10n.voiceErrorService,
  SpeechInputFailureKind.network => l10n.voiceErrorNetwork,
  SpeechInputFailureKind.noSpeech => l10n.voiceErrorNoSpeech,
  SpeechInputFailureKind.recognizerBusy => l10n.voiceErrorBusy,
  SpeechInputFailureKind.alreadyActive => l10n.voiceErrorAlreadyActive,
  SpeechInputFailureKind.startFailed => l10n.voiceErrorStartFailed,
  SpeechInputFailureKind.unsupported => l10n.voiceErrorUnsupported,
  SpeechInputFailureKind.unknown => reason,
};

/// Non-destructive two-version draft banner (DR1).
///
/// Shown above the composer when a second version of the composer text has to
/// be preserved: either the device's unsynchronized draft and the shared broker
/// draft changed independently, or a message that failed to send was kept
/// beside newer text. Both versions live on the durable local row until the
/// user explicitly chooses; nothing resolves by wall clock or text similarity.
class _DraftConflictBanner extends StatelessWidget {
  const _DraftConflictBanner({
    required this.conflict,
    required this.onKeepLocal,
    required this.onUseShared,
  });

  final SessionDraftConflict conflict;
  final VoidCallback onKeepLocal;
  final VoidCallback onUseShared;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    // A null-revision conflict is not a cross-device divergence: it is a
    // second LOCAL version — a message that failed to send, or an edit from
    // another window (the durable row cannot tell those two apart, so the
    // copy stays neutral over both). Naming it "shared draft" would describe
    // something the user never saw.
    final unsent = conflict.kind == SessionDraftConflictKind.unsentPrompt;
    final title = unsent
        ? l10n.sessionDraftUnsentTitle
        : l10n.sessionDraftConflictTitle;
    final message = unsent
        ? l10n.sessionDraftUnsentMessage
        : l10n.sessionDraftConflictMessage;
    final keepLabel = unsent
        ? l10n.sessionDraftUnsentKeepCurrent
        : l10n.sessionDraftConflictKeepLocal;
    final otherLabel = unsent
        ? l10n.sessionDraftUnsentRestore
        : l10n.sessionDraftConflictUseShared;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: tokens.surface2,
        borderRadius: BorderRadius.circular(tokens.radiusSm),
        border: Border.all(color: tokens.statusNeedsInput),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Icon(
                  Icons.difference_outlined,
                  size: 16,
                  color: tokens.statusNeedsInput,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    title,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: tokens.textPrimary,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              message,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: tokens.textSecondary,
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                TextButton(
                  key: const Key('session-detail-draft-conflict-keep-local'),
                  onPressed: onKeepLocal,
                  child: Text(keepLabel),
                ),
                TextButton(
                  key: const Key('session-detail-draft-conflict-use-shared'),
                  onPressed: onUseShared,
                  child: Text(otherLabel),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
