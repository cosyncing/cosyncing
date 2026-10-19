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
  final _acknowledged = <String>{};
  final _serverKeys = <String, GlobalKey>{};
  bool _app = false;
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

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final value = ref.watch(updatesControllerProvider);
    final controller = ref.read(updatesControllerProvider.notifier);
    final active = ref.watch(activeBrokerProfileProvider)?.id;
    return Scaffold(
      appBar: AppBar(title: Text(l.updatesTitle)),
      body: value.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => Center(child: Text(l.updatesNeedsAttention)),
        data: (data) {
          if (!_initializedSelection &&
              !data.checking &&
              (data.manifest != null ||
                  data.servers.any((r) => r.check != null))) {
            _initializedSelection = true;
            _app = data.appAvailable;
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
              if (data.checking) const LinearProgressIndicator(),
              const SizedBox(height: 16),
              if (native) ...[
                SettingsSection(
                  title: l.updatesThisApp,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (data.appAvailable)
                        CheckboxListTile(
                          key: const Key('updates-select-app'),
                          contentPadding: EdgeInsets.zero,
                          value: _app,
                          onChanged: data.working || data.unfinished
                              ? null
                              : (v) {
                                  controller.discardReview();
                                  setState(() => _app = v!);
                                },
                          title: Text(
                            l.updatesAppVersions(
                              '${data.local?['version']}',
                              '${data.manifest?['version']}',
                            ),
                          ),
                          subtitle: Text(l.updatesAppCloses),
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
                        child: CheckboxListTile(
                          key: Key('updates-server-${row.profile.id}'),
                          contentPadding: EdgeInsets.zero,
                          value: _selected.contains(row.profile.id),
                          onChanged:
                              row.available && !data.working && !data.unfinished
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
                      if (row.lastSeen != null)
                        Text(
                          l.updatesLastChecked(
                            MaterialLocalizations.of(
                              context,
                            ).formatMediumDate(row.lastSeen!.toLocal()),
                          ),
                          style: Theme.of(context).textTheme.bodySmall,
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
                  data.error == 'update-status-unknown'
                      ? l.updatesStatusUnknown
                      : data.error == 'UPDATE_PERMISSION_REQUIRED'
                      ? l.updatesPermission
                      : l.updatesReviewChanged,
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
              if (data.review.isEmpty)
                Align(
                  alignment: Alignment.centerLeft,
                  child: FilledButton(
                    key: const Key('updates-review'),
                    onPressed:
                        data.working ||
                            data.unfinished ||
                            data.checking ||
                            (_selected.isEmpty && !_app)
                        ? null
                        : () {
                            _acknowledged.clear();
                            unawaited(
                              _run(
                                () => controller.review(_selected, app: _app),
                              ),
                            );
                          },
                    child: Text(l.updatesReview),
                  ),
                )
              else
                SettingsSection(
                  title: l.updatesReview,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
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
                      for (final ack
                          in data.review
                              .expand((s) => s.acknowledgements)
                              .toSet())
                        CheckboxListTile(
                          key: Key('updates-ack-$ack'),
                          contentPadding: EdgeInsets.zero,
                          title: Text(_acknowledgement(l, ack)),
                          value: _acknowledged.contains(ack),
                          onChanged: data.working
                              ? null
                              : (v) => setState(() {
                                  if (v!) {
                                    _acknowledged.add(ack);
                                  } else {
                                    _acknowledged.remove(ack);
                                  }
                                }),
                        ),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: FilledButton(
                          key: const Key('updates-apply'),
                          onPressed:
                              data.working ||
                                  !_acknowledged.containsAll(
                                    data.review.expand(
                                      (s) => s.acknowledgements,
                                    ),
                                  )
                              ? null
                              : () => unawaited(
                                  _run(() => controller.confirm(_acknowledged)),
                                ),
                          child: Text(l.updatesApply),
                        ),
                      ),
                    ],
                  ),
                ),
              if (data.working) ...[
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
