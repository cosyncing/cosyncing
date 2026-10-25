import 'dart:math' as math;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/overview_quota_preferences.dart';
import 'package:cosyncing_client/src/features/settings/data/managed_runtime_api.dart';
import 'package:cosyncing_client/src/features/settings/view/quota_status_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Overview's focused quotas; shares normalized presentation and broker reads.
class OverviewQuota extends ConsumerStatefulWidget {
  /// Creates the source-scoped quota section.
  const OverviewQuota({super.key});
  @override
  ConsumerState<OverviewQuota> createState() => _OverviewQuotaState();
}

class _OverviewQuotaState extends ConsumerState<OverviewQuota> {
  List<String> _draft = [];
  bool _saving = false;
  String? _editingSource;
  final MenuController _menu = MenuController();
  bool _saveFailed = false;

  @override
  Widget build(BuildContext context) {
    if (!TickerMode.valuesOf(context).enabled) return const SizedBox.shrink();
    ref.listen(activeBrokerProfileProvider, (previous, next) {
      if (_editingSource != RosterSource.of(next)?.storageKey) _menu.close();
    });
    final t = context.tokens;
    final l10n = AppLocalizations.of(context);
    final compact = MediaQuery.sizeOf(context).width < 420;
    final preferences = ref.watch(overviewQuotaPreferencesProvider);
    final selected = preferences.isLoading || preferences.hasError
        ? const <String>[]
        : preferences.valueOrNull ?? const <String>[];
    final reading = ref.watch(managedRuntimeQuotaProvider);
    final quota = reading.isReloading || reading.hasError
        ? null
        : reading.valueOrNull;
    final available = <String>{
      ...selected,
      for (final entry
          in (quota?.data?.providers ?? <String, TokdashQuotaProvider>{})
              .entries)
        if (quotaProviderHasPresentation(entry.value)) entry.key,
    }.toList();
    final source = RosterSource.of(ref.watch(activeBrokerProfileProvider));
    return Column(
      key: const Key('workspace-overview-quota'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 16,
          children: [
            SectionHeader(
              l10n.settingsQuotaPanelTitle,
              padding: EdgeInsets.zero,
              color: t.textSecondary,
            ),
            Wrap(
              spacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                MenuAnchor(
                  controller: _menu,
                  onOpen: () => setState(() {
                    _editingSource = source?.storageKey;
                    _draft = [...selected];
                    _saveFailed = false;
                  }),
                  style: MenuStyle(
                    backgroundColor: WidgetStatePropertyAll(t.surface),
                    side: const WidgetStatePropertyAll(BorderSide.none),
                    shape: WidgetStatePropertyAll(
                      RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(t.radiusMd),
                      ),
                    ),
                  ),
                  builder: (context, controller, child) {
                    final enabled = source != null && !preferences.isLoading;
                    void toggle() => controller.isOpen
                        ? controller.close()
                        : controller.open();
                    if (compact) {
                      return IconButton(
                        key: const Key('overview-quota-choose'),
                        tooltip: l10n.overviewQuotaChoose,
                        onPressed: enabled ? toggle : null,
                        icon: const StrokeIcon(StrokeGlyph.filter, size: 16),
                      );
                    }
                    return TextButton(
                      key: const Key('overview-quota-choose'),
                      onPressed: enabled ? toggle : null,
                      child: Text(l10n.overviewQuotaChoose),
                    );
                  },
                  menuChildren: [
                    Builder(
                      builder: (context) => SizedBox(
                        width: math.min(
                          320,
                          MediaQuery.sizeOf(context).width - 32,
                        ),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            ConstrainedBox(
                              constraints: BoxConstraints(
                                maxHeight: math.min(
                                  360,
                                  MediaQuery.sizeOf(context).height * .5,
                                ),
                              ),
                              child: SingleChildScrollView(
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    if (available.isEmpty)
                                      Padding(
                                        padding: const EdgeInsets.all(16),
                                        child: Text(
                                          l10n.settingsQuotaUnavailable,
                                        ),
                                      ),
                                    for (final id in available)
                                      CheckboxListTile(
                                        key: Key('overview-quota-provider-$id'),
                                        title: Text(
                                          quotaProviderDisplayName(id),
                                        ),
                                        value: _draft.contains(id),
                                        onChanged: _saving
                                            ? null
                                            : (value) => setState(() {
                                                if (value ?? false) {
                                                  _draft.add(id);
                                                } else {
                                                  _draft.remove(id);
                                                }
                                              }),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                            if (_saveFailed)
                              Padding(
                                padding: const EdgeInsets.all(8),
                                child: Text(l10n.overviewQuotaSaveFailed),
                              ),
                            Align(
                              alignment: AlignmentDirectional.centerEnd,
                              child: TextButton(
                                key: const Key('overview-quota-done'),
                                onPressed: _saving
                                    ? null
                                    : () async {
                                        final operationSource = _editingSource;
                                        bool stillEditing() =>
                                            mounted &&
                                            operationSource == _editingSource &&
                                            RosterSource.of(
                                                  ref.read(
                                                    activeBrokerProfileProvider,
                                                  ),
                                                )?.storageKey ==
                                                operationSource;
                                        if (RosterSource.of(
                                              ref.read(
                                                activeBrokerProfileProvider,
                                              ),
                                            )?.storageKey !=
                                            _editingSource) {
                                          return;
                                        }
                                        setState(() => _saving = true);
                                        try {
                                          await ref
                                              .read(
                                                overviewQuotaPreferencesProvider
                                                    .notifier,
                                              )
                                              .save(_draft);
                                          if (stillEditing()) _menu.close();
                                        } on Object {
                                          if (stillEditing()) {
                                            setState(() => _saveFailed = true);
                                          }
                                        } finally {
                                          if (mounted) {
                                            setState(() => _saving = false);
                                          }
                                        }
                                      },
                                child: Text(l10n.done),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
                IconButton(
                  key: const Key('overview-quota-refresh'),
                  tooltip: l10n.refresh,
                  onPressed: reading.isLoading
                      ? null
                      : () => ref.invalidate(managedRuntimeQuotaProvider),
                  icon: const StrokeIcon(StrokeGlyph.refresh, size: 16),
                ),
                TextButton(
                  onPressed: () => context.go(agentsSettingsRoute),
                  child: Tooltip(
                    message: l10n.overviewQuotaAll,
                    child: Text(
                      compact
                          ? l10n.overviewQuotaAllCompact
                          : l10n.overviewQuotaAll,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
        if (preferences.hasError)
          InlineNotice(text: l10n.overviewQuotaSaveFailed),
        if (selected.isNotEmpty) ...[
          const SizedBox(height: 8),
          QuotaStatusPanel(
            quota: quota,
            loading: reading.isLoading,
            selectedProviders: selected,
            embedded: true,
          ),
        ],
      ],
    );
  }
}
