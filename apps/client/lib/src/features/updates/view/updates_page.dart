import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/settings/view/native_client_update_settings_section.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/features/updates/controller/updates_controller.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update_provider.dart';
import 'package:cosyncing_client/src/platform/update/native_client_update.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// One review surface for this installation and explicitly selected servers.
class UpdatesPage extends ConsumerStatefulWidget {
  /// Opens Updates, optionally focused on a saved server without selecting it.
  const UpdatesPage({this.profileId, super.key});

  /// Saved server to bring into view; this never changes the active server.
  final String? profileId;
  @override
  ConsumerState<UpdatesPage> createState() => _UpdatesPageState();
}

class _UpdatesPageState extends ConsumerState<UpdatesPage> {
  final _selected = <String>{};
  final _serverKeys = <String, GlobalKey>{};
  bool _initializedSelection = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(
        _run(() async {
          await ref.read(updatesControllerProvider.future);
          await ref.read(updatesControllerProvider.notifier).refresh();
          if (!mounted) return;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (!mounted) return;
            final target = _serverKeys[widget.profileId]?.currentContext;
            if (target != null) unawaited(Scrollable.ensureVisible(target));
          });
        }),
      );
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
    } on Object {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(AppLocalizations.of(context).updatesFailed),
        ),
      );
    }
  }

  Future<void> _openReview({
    Set<String> servers = const {},
    bool app = false,
  }) async {
    final controller = ref.read(updatesControllerProvider.notifier);
    final targets = Set<String>.of(servers);
    var includeApp = app;
    final acknowledged = <String>{};
    unawaited(_run(() => controller.review(targets, app: includeApp)));
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) => StatefulBuilder(
        builder: (context, setSheetState) => Consumer(
          builder: (context, ref, _) {
            final l = AppLocalizations.of(context);
            final data = ref.watch(updatesControllerProvider).valueOrNull;
            if (data == null) {
              return Padding(
                padding: const EdgeInsets.all(24),
                child: Text(l.updatesPreparing),
              );
            }
            final required = data.review
                .expand((step) => step.acknowledgements)
                .toSet();
            return SafeArea(
              child: SingleChildScrollView(
                key: const Key('updates-confirmation'),
                padding: EdgeInsets.fromLTRB(
                  24,
                  8,
                  24,
                  24 + MediaQuery.viewInsetsOf(context).bottom,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      app
                          ? l.updatesUpdateApp
                          : l.updatesUpdateServers(targets.length),
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 16),
                    if (!app && data.appAvailable)
                      CheckboxListTile(
                        key: const Key('updates-include-app'),
                        contentPadding: EdgeInsets.zero,
                        value: includeApp,
                        title: Text(l.updatesIncludeApp),
                        onChanged: data.working
                            ? null
                            : (value) {
                                if (ref
                                        .read(updatesControllerProvider)
                                        .valueOrNull
                                        ?.working ??
                                    true) {
                                  return;
                                }
                                final next = value!;
                                setSheetState(() {
                                  includeApp = next;
                                  acknowledged.clear();
                                });
                                unawaited(
                                  _run(
                                    () => controller.review(
                                      targets,
                                      app: next,
                                    ),
                                  ),
                                );
                              },
                      ),
                    if (data.working) Text(l.updatesPreparing),
                    if (data.error != null) Text(_errorMessage(l, data.error!)),
                    for (final step in data.review)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(step.label),
                        subtitle: Text(
                          l.updatesVersionChange(
                            step.from ?? l.updatesUnknown,
                            step.to,
                          ),
                        ),
                      ),
                    for (final ack in required)
                      CheckboxListTile(
                        key: Key('updates-ack-$ack'),
                        contentPadding: EdgeInsets.zero,
                        title: Text(_acknowledgement(l, ack)),
                        value: acknowledged.contains(ack),
                        onChanged: data.working
                            ? null
                            : (value) => setSheetState(() {
                                if (value!) {
                                  acknowledged.add(ack);
                                } else {
                                  acknowledged.remove(ack);
                                }
                              }),
                      ),
                    const SizedBox(height: 16),
                    Wrap(
                      alignment: WrapAlignment.end,
                      spacing: 8,
                      children: [
                        TextButton(
                          onPressed: () => Navigator.pop(sheetContext),
                          child: Text(l.cancel),
                        ),
                        FilledButton(
                          key: const Key('updates-apply'),
                          onPressed:
                              data.working ||
                                  data.error != null ||
                                  data.review.isEmpty ||
                                  !acknowledged.containsAll(required)
                              ? null
                              : () {
                                  final consent = Set<String>.of(acknowledged);
                                  Navigator.pop(sheetContext);
                                  unawaited(
                                    _run(() => controller.confirm(consent)),
                                  );
                                },
                          child: Text(l.updatesInstall),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final value = ref.watch(updatesControllerProvider);
    final controller = ref.read(updatesControllerProvider.notifier);
    final active = ref.watch(activeBrokerProfileProvider)?.id;
    return Scaffold(
      appBar: AppBar(title: Text(l.updatesTitle)),
      body: value.when(
        loading: () => Center(child: Text(l.settingsAndroidAppUpdateChecking)),
        error: (_, _) => Center(child: Text(l.updatesNeedsAttention)),
        data: (data) {
          if (!data.checking) {
            final available = data.servers
                .where((row) => row.available)
                .map((row) => row.profile.id)
                .toSet();
            _selected.retainAll(available);
          }
          if (!_initializedSelection &&
              !data.checking &&
              (data.manifest != null ||
                  data.servers.any((r) => r.check != null))) {
            _initializedSelection = true;
            for (final row in data.servers) {
              if (row.profile.id == active && row.available) {
                _selected.add(row.profile.id);
              }
            }
          }
          final native = supportsNativeClientUpdates(
            ref.watch(clientTargetPlatformProvider),
            isWeb: ref.watch(clientIsWebProvider),
          );
          final stackServerActions =
              MediaQuery.sizeOf(context).width < 600 ||
              MediaQuery.textScalerOf(context).scale(1) > 1.3;
          final updatesEnabled =
              !data.working && !data.unfinished && !data.checking;
          return SettingsPageBody(
            children: [
              LayoutBuilder(
                builder: (context, constraints) => Row(
                  children: [
                    Expanded(child: Text(l.updatesSubtitle)),
                    if (constraints.maxWidth < 480)
                      IconButton(
                        key: const Key('updates-check'),
                        tooltip: l.settingsAndroidAppUpdateCheckAction,
                        onPressed: data.checking || data.working
                            ? null
                            : () => unawaited(_run(controller.refresh)),
                        icon: const Icon(Icons.refresh, size: 18),
                      )
                    else
                      TextButton.icon(
                        key: const Key('updates-check'),
                        onPressed: data.checking || data.working
                            ? null
                            : () => unawaited(_run(controller.refresh)),
                        icon: const Icon(Icons.refresh, size: 18),
                        label: Text(l.settingsAndroidAppUpdateCheckAction),
                      ),
                  ],
                ),
              ),
              if (data.checking)
                Semantics(
                  liveRegion: true,
                  child: Text(
                    l.settingsAndroidAppUpdateChecking,
                    key: const Key('updates-checking'),
                  ),
                ),
              const SizedBox(height: 16),
              if (native) ...[
                SettingsSection(
                  title: l.updatesThisApp,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (data.appAvailable)
                        SettingsRow(
                          key: const Key('updates-app-available'),
                          stackTrailing: true,
                          title: Text(
                            l.updatesAppVersions(
                              '${data.local?['version']}',
                              '${data.manifest?['version']}',
                            ),
                          ),
                          subtitle: Text(l.updatesAppCloses),
                          trailing: FilledButton.tonal(
                            key: const Key('updates-update-app'),
                            onPressed:
                                data.working || data.unfinished || data.checking
                                ? null
                                : () => unawaited(_openReview(app: true)),
                            child: Text(l.updatesUpdateApp),
                          ),
                        )
                      else ...[
                        const NativeClientUpdateSettingsSection(),
                        if (ref.watch(clientTargetPlatformProvider) !=
                                TargetPlatform.android &&
                            (data.local == null || data.appNewer))
                          Text(
                            data.localError == 'desktop-update-restart-required'
                                ? l.updatesRestartToFinish
                                : data.localError == 'check-failed'
                                ? l.updatesCheckFailed
                                : data.local == null
                                ? l.updatesSetup
                                : l.updatesManual,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 16),
              ],
              SettingsSection(
                title: l.updatesServers,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (data.servers.isEmpty) Text(l.updatesNoServers),
                    for (final row in data.servers) ...[
                      KeyedSubtree(
                        key: _serverKeys.putIfAbsent(
                          row.profile.id,
                          GlobalKey.new,
                        ),
                        child: row.available
                            ? CheckboxListTile(
                                key: Key('updates-server-${row.profile.id}'),
                                contentPadding: EdgeInsets.zero,
                                controlAffinity:
                                    ListTileControlAffinity.leading,
                                secondary: stackServerActions
                                    ? null
                                    : _serverAction(l, row, updatesEnabled),
                                value: _selected.contains(row.profile.id),
                                onChanged:
                                    row.available &&
                                        !data.working &&
                                        !data.unfinished
                                    ? (v) {
                                        controller.discardReview();
                                        setState(() {
                                          if (v!) {
                                            _selected.add(row.profile.id);
                                          } else {
                                            _selected.remove(row.profile.id);
                                          }
                                        });
                                      }
                                    : null,
                                title: Text(
                                  row.profile.id == active
                                      ? '${row.profile.displayName} · '
                                            '${l.brokerProfileActive}'
                                      : row.profile.displayName,
                                ),
                                subtitle: Text(
                                  l.updatesServerDetails(
                                    row.profile.displayAddress,
                                    _serverStatus(l, row),
                                  ),
                                ),
                              )
                            : ListTile(
                                key: Key('updates-server-${row.profile.id}'),
                                contentPadding: EdgeInsets.zero,
                                title: Text(
                                  row.profile.id == active
                                      ? '${row.profile.displayName} · '
                                            '${l.brokerProfileActive}'
                                      : row.profile.displayName,
                                ),
                                subtitle: Text(
                                  l.updatesServerDetails(
                                    row.profile.displayAddress,
                                    _serverStatus(l, row),
                                  ),
                                ),
                              ),
                      ),
                      if (row.error == null &&
                          row.check?.status == 'update-available' &&
                          row.check?.available != null &&
                          !row.available) ...[
                        Text(l.updatesServerManual),
                        for (final blocker
                            in row.inventory!.broker.blockers) ...[
                          const SizedBox(height: 4),
                          Text(blocker.detail),
                          if (blocker.guidance != null) Text(blocker.guidance!),
                        ],
                      ],
                      if (row.lastSeen != null ||
                          (stackServerActions && row.available))
                        Wrap(
                          alignment: WrapAlignment.spaceBetween,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          spacing: 8,
                          runSpacing: 4,
                          children: [
                            if (row.lastSeen != null)
                              Text(
                                l.updatesLastChecked(
                                  MaterialLocalizations.of(
                                    context,
                                  ).formatMediumDate(row.lastSeen!.toLocal()),
                                ),
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                            if (stackServerActions && row.available)
                              _serverAction(l, row, updatesEnabled),
                          ],
                        ),
                      if (row.grants == null &&
                          (row.error == 'permission-required' || row.available))
                        Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton(
                            key: Key('updates-request-${row.profile.id}'),
                            onPressed: data.working
                                ? null
                                : () => unawaited(
                                    _run(() async {
                                      await controller.permission(row.profile);
                                      if (!context.mounted) return;
                                      ScaffoldMessenger.of(
                                        context,
                                      ).showSnackBar(
                                        SnackBar(
                                          content: Text(
                                            l.updatesPermissionRequested,
                                          ),
                                        ),
                                      );
                                    }),
                                  ),
                            child: Text(l.updatesRequestPermission),
                          ),
                        ),
                      if (row.grants != null &&
                          (row.grants!.requests.isNotEmpty ||
                              row.grants!.grants.isNotEmpty))
                        ExpansionTile(
                          tilePadding: EdgeInsets.zero,
                          title: Text(l.updatesPermissions),
                          children: [
                            for (final peer in row.grants!.requests)
                              ListTile(
                                title: SelectableText(peer),
                                trailing: TextButton(
                                  onPressed: () => unawaited(
                                    _run(
                                      () => controller.permission(
                                        row.profile,
                                        peerId: peer,
                                      ),
                                    ),
                                  ),
                                  child: Text(l.updatesGrant),
                                ),
                              ),
                            for (final grant in row.grants!.grants.where(
                              (g) => !g.revoked,
                            ))
                              ListTile(
                                title: SelectableText(grant.peerId),
                                trailing: TextButton(
                                  onPressed: () => unawaited(
                                    _run(
                                      () => controller.permission(
                                        row.profile,
                                        peerId: grant.peerId,
                                        revoke: true,
                                      ),
                                    ),
                                  ),
                                  child: Text(l.updatesRevoke),
                                ),
                              ),
                          ],
                        ),
                      if (row.history.isNotEmpty)
                        ExpansionTile(
                          tilePadding: EdgeInsets.zero,
                          title: Text(l.updatesHistory),
                          children: [
                            for (final job in row.history)
                              ListTile(
                                title: Text(
                                  job.result == 'complete'
                                      ? l.updatesSucceeded
                                      : l.updatesNeedsAttention,
                                ),
                                subtitle: Tooltip(
                                  message: job.releaseId,
                                  child: Text(
                                    job.releaseId
                                        .replaceFirst('rel-', '')
                                        .split('+')
                                        .first,
                                  ),
                                ),
                              ),
                          ],
                        ),
                      const SizedBox(height: 16),
                    ],
                  ],
                ),
              ),
              if (data.error != null) ...[
                const SizedBox(height: 16),
                Text(
                  _errorMessage(l, data.error!),
                ),
                ExpansionTile(
                  title: Text(l.updatesDetails),
                  children: [SelectableText(data.error!)],
                ),
              ],
              if (data.operation != null) ...[
                const SizedBox(height: 16),
                SettingsSection(
                  title: l.updatesHistory,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final step
                          in (data.operation!['steps']! as List)
                              .cast<Map<String, dynamic>>())
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          title: Text(step['label']! as String),
                          subtitle: Text(
                            l.updatesProgressVersions(
                              '${step['from'] ?? l.updatesUnknown}',
                              '${step['to']}',
                              _phase(l, step['phase']! as String),
                            ),
                          ),
                        ),
                      if (!const [
                        'complete',
                        'cancelled',
                      ].contains(data.operation!['phase']))
                        Wrap(
                          spacing: 8,
                          children: [
                            FilledButton.tonal(
                              key: const Key('updates-continue'),
                              onPressed: data.working
                                  ? null
                                  : () => unawaited(
                                      _run(controller.continueOperation),
                                    ),
                              child: Text(l.updatesContinue),
                            ),
                            TextButton(
                              key: const Key('updates-cancel'),
                              onPressed:
                                  data.operation!['cancelRequested'] == true
                                  ? null
                                  : () => unawaited(_run(controller.cancel)),
                              child: Text(l.cancel),
                            ),
                          ],
                        ),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 16),
              if (_selected.isNotEmpty)
                Align(
                  alignment: Alignment.centerLeft,
                  child: FilledButton(
                    key: const Key('updates-review'),
                    onPressed: data.working || data.unfinished || data.checking
                        ? null
                        : () => unawaited(_openReview(servers: _selected)),
                    child: Text(l.updatesUpdateServers(_selected.length)),
                  ),
                ),
              if (data.working && data.unfinished) ...[
                const SizedBox(height: 16),
                const LinearProgressIndicator(),
              ],
            ],
          );
        },
      ),
    );
  }

  String _serverStatus(AppLocalizations l, UpdateServerRow row) {
    if (row.error == 'legacy') return l.updatesLegacy;
    if (row.error == 'permission-required') return l.updatesPermission;
    if (row.error != null) {
      return row.lastSeen == null
          ? l.updatesUnknown
          : l.updatesOffline(
              row.inventory?.broker.running.version ?? l.updatesUnknown,
            );
    }
    if (row.check?.status == 'update-available' &&
        row.check?.available != null) {
      final from = row.inventory?.broker.running.version ?? l.updatesUnknown;
      return l.updatesVersionChange(
        from,
        row.check!.available!.version ?? l.updatesUnknown,
      );
    }
    return row.check?.status == 'current'
        ? l.updatesCurrent
        : l.updatesCheckFailed;
  }

  String _errorMessage(AppLocalizations l, String code) => switch (code) {
    'update-status-unknown' => l.updatesStatusUnknown,
    'UPDATE_PERMISSION_REQUIRED' => l.updatesPermission,
    _ => l.updatesReviewChanged,
  };

  Widget _serverAction(
    AppLocalizations l,
    UpdateServerRow row,
    bool enabled,
  ) => TextButton(
    key: Key('updates-update-server-${row.profile.id}'),
    onPressed: enabled
        ? () => unawaited(_openReview(servers: {row.profile.id}))
        : null,
    child: Text(l.updatesUpdateServer),
  );

  String _acknowledgement(AppLocalizations l, String ack) => switch (ack) {
    'app-will-close' => l.updatesAppCloses,
    'server-will-disconnect' => l.updatesServerDisconnects,
    'interruption-during-work' => l.updatesBusy,
    'compatibility-unconfirmed' => l.updatesCompatibilityUnknown,
    'unselected-servers-unusable' => l.updatesOtherServers,
    'other-clients-will-be-excluded' => l.updatesOtherClients,
    _ => l.updatesReviewChanged,
  };

  String _phase(AppLocalizations l, String phase) => switch (phase) {
    'pending' || 'accepted' || 'preparing' => l.updatesPreparing,
    'ready' => l.updatesReady,
    'waiting-for-exit' || 'replacing' || 'applying' => l.updatesApplying,
    'verifying' => l.updatesVerifying,
    'succeeded' => l.updatesSucceeded,
    'rolled_back' => l.updatesRolledBack,
    'needs_attention' => l.updatesNeedsAttention,
    'cancelled' => l.canceled,
    'failed' => l.updatesFailed,
    _ => l.updatesStatusUnknown,
  };
}
