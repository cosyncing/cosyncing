import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/components/contextual_details.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/controller/broker_route_coordinator.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_probe.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_store.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_source_migration.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_routes.dart';
import 'package:cosyncing_client/src/features/connection/provider/broker_route_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_address_editor.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_profile_merge_page.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_route_configuration_page.dart';
import 'package:cosyncing_client/src/features/connection/view/proxy_profiles_page.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart' show Variable;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Addresses of one saved server/access binding, independent of selection.
class BrokerAddressesPage extends ConsumerStatefulWidget {
  /// Manages addresses for one saved logical server/access binding.
  const BrokerAddressesPage({required this.profile, super.key});

  /// Saved server/access binding named by this screen and its confirmations.
  final BrokerProfile profile;
  @override
  ConsumerState<BrokerAddressesPage> createState() =>
      _BrokerAddressesPageState();
}

class _BrokerAddressesPageState extends ConsumerState<BrokerAddressesPage> {
  late BrokerProfile _profile = widget.profile;
  late final BrokerRouteCoordinator _coordinator;
  bool _busy = false;
  Object? _error;
  List<BrokerProxyProfile> _proxies = [];
  List<BrokerProfile> _duplicates = [];
  int _recoveredCount = 0;

  @override
  void initState() {
    super.initState();
    _coordinator = ref.read(brokerRouteCoordinatorProvider);
    unawaited(_load());
  }

  @override
  void dispose() {
    unawaited(_coordinator.visible(_profile, visible: false));
    super.dispose();
  }

  Future<void> _load() async {
    try {
      await _coordinator.visible(_profile, visible: true);
      final proxies = await ref.read(brokerRouteStoreProvider).proxies();
      await ref.read(brokerProfileMergeProvider).recover();
      final profiles = await ref.read(brokerProfileRepositoryProvider).getAll();
      final count = await ref
          .read(appDatabaseProvider)
          .customSelect(
            'SELECT count(*) AS n FROM broker_recovered_drafts WHERE source=?',
            variables: [Variable(RosterSource.ofProfile(_profile).storageKey)],
          )
          .getSingle();
      if (mounted) {
        setState(() {
          _proxies = proxies;
          _error = null;
          _recoveredCount = count.read<int>('n');
          _duplicates = profiles
              .where(
                (p) =>
                    p.id != _profile.id &&
                    _profile.sourceIdentity != null &&
                    p.sourceIdentity == _profile.sourceIdentity,
              )
              .toList();
        });
      }
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<BrokerRouteObservation> _verify(BrokerAddress address) async {
    try {
      return await _coordinator.testAddress(_profile, address);
    } on BrokerRouteTrustRequired catch (untrusted) {
      final server = _coordinator.status(_profile)!.server;
      if (!mounted ||
          !address.legacyTrusted ||
          address.origin.origin != server.legacyOrigin.origin) {
        rethrow;
      }
      final l = AppLocalizations.of(context);
      final approved = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(l.routesVerifyTitle),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(l.routesVerifyBody),
                const SizedBox(height: 16),
                SelectableText(address.origin.toString()),
                const SizedBox(height: 12),
                SelectableText(
                  untrusted.publicKey,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(l.cancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(l.routesApprove),
            ),
          ],
        ),
      );
      if (approved != true) rethrow;
      return _coordinator.testAddress(
        _profile,
        address,
        approvedIdentity: untrusted.publicKey,
      );
    }
  }

  Future<void> _test(BrokerAddress address) => _run(() async {
    final observation = await _verify(address);
    await _persistVerified(address, observation);
  });

  Future<void> _persistVerified(
    BrokerAddress address,
    BrokerRouteObservation observation,
  ) async {
    final store = ref.read(brokerRouteStoreProvider);
    final current = (await store.read(_profile.id, _profile.incarnationId!))!;
    final configured = current.addresses
        .where((route) => route.id == address.id)
        .firstOrNull;
    if (configured == null ||
        configured.origin != observation.context.origin ||
        configured.generation != observation.context.routeGeneration ||
        configured.proxyId != observation.context.proxyId) {
      throw const BrokerRouteException('CONFIGURATION_CHANGED');
    }
    final proxy = await store.proxy(configured.proxyId);
    if (proxy?.generation != observation.context.proxy?.generation) {
      throw const BrokerRouteException('CONFIGURATION_CHANGED');
    }
    final verified = configured.copyWith(
      verifiedIdentity: observation.identityPublicKey,
    );
    final next = current.copyWith(
      identityPublicKey: observation.identityPublicKey,
      principalId: observation.principalId,
      credentialReference: _profile.credentialKey,
      addresses: [
        for (final existing in current.addresses)
          existing.id == address.id ? verified : existing,
      ],
    );
    if (_profile.sourceIdentity == null) {
      // Drain the mounted composers before fencing their old source. A failed
      // durable draft write aborts the migration and keeps the current source.
      if (ref.read(activeBrokerProfileProvider)?.id == _profile.id) {
        await ref
            .read(openSessionsControllerProvider.notifier)
            .flushDraftsForUpdate();
      }
      _coordinator.retireProfile(_profile);
      final migrated = await ref
          .read(brokerProfileMutationGateProvider)
          .runForProfile(
            _profile,
            (currentProfile) => BrokerSourceMigration(
              ref.read(appDatabaseProvider),
              store,
              ref.read(credentialStoreProvider),
            ).bind(currentProfile, next),
          );
      _profile = migrated;
      if (ref.read(activeBrokerProfileProvider)?.id == _profile.id) {
        ref.read(activeBrokerProfileProvider.notifier).state = migrated;
      }
      ref.invalidate(brokerProfileListProvider);
      await _coordinator.visible(_profile, visible: true);
      await _coordinator.configurationChanged(_profile);
    } else {
      await store.save(next, expectedGeneration: current.generation);
      await _coordinator.labelsChanged(_profile);
    }
    await _load();
  }

  Future<void> _edit([BrokerAddress? address]) async {
    final result = await showDialog<BrokerAddressEdit>(
      context: context,
      builder: (context) => BrokerAddressEditor(
        profile: _profile,
        address: address,
        server: _coordinator.status(_profile)!.server,
        verify: _verify,
      ),
    );
    if (result == null || !mounted) return;
    await _run(() async {
      final store = ref.read(brokerRouteStoreProvider);
      final current = (await store.read(_profile.id, _profile.incarnationId!))!;
      final proposed = result.address;
      final duplicate = current.addresses
          .where((a) => a.origin == proposed.origin && a.id != address?.id)
          .firstOrNull;
      final target = duplicate ?? address;
      final pathChanged =
          target == null ||
          target.origin != proposed.origin ||
          target.proxyId != proposed.proxyId;
      final accepted = result.observation != null;
      // An unverified edit never replaces the working route. It is a separate
      // repairable candidate until a later successful test commits it.
      final saved = proposed.copyWith(
        verifiedIdentity: result.observation?.identityPublicKey,
        clearVerification: !accepted && pathChanged,
        legacyTrusted: !pathChanged && target.legacyTrusted,
        generation: pathChanged
            ? (target?.generation ?? 0) + 1
            : target.generation,
      );
      final replacement = !accepted && pathChanged && target != null
          ? BrokerAddress(
              id: newConnectionId(),
              origin: saved.origin,
              label: saved.label,
              order: current.addresses.length,
              generation: saved.generation,
              proxyId: saved.proxyId,
            )
          : BrokerAddress(
              id: target?.id ?? saved.id,
              origin: saved.origin,
              label: saved.label,
              order: target?.order ?? current.addresses.length,
              generation: saved.generation,
              enabled: target?.enabled ?? true,
              proxyId: saved.proxyId,
              verifiedIdentity: saved.verifiedIdentity,
              legacyTrusted: saved.legacyTrusted,
            );
      final addresses = [...current.addresses];
      final index = addresses.indexWhere((a) => a.id == replacement.id);
      if (index < 0) {
        addresses.add(replacement);
      } else {
        addresses[index] = replacement;
      }
      await store.save(
        current.copyWith(addresses: addresses),
        expectedGeneration: current.generation,
      );
      if (accepted && _profile.sourceIdentity == null) {
        await _persistVerified(replacement, result.observation!);
      } else if (pathChanged &&
          accepted &&
          target?.id == _coordinator.status(_profile)?.activeRouteId) {
        await _coordinator.configurationChanged(_profile);
      } else {
        await _coordinator.labelsChanged(_profile);
      }
    });
  }

  Future<void> _mode(
    BrokerRouteMode mode, [
    BrokerAddress? fixed,
  ]) => _run(() async {
    if (mode == BrokerRouteMode.fixed && fixed == null) {
      throw const BrokerRouteException('NO_ENABLED_ADDRESS');
    }
    final original =
        fixed ??
        _coordinator
            .status(_profile)!
            .server
            .addresses
            .where((a) => a.enabled && a.legacyTrusted)
            .firstOrNull;
    if (fixed != null || _profile.sourceIdentity == null) {
      if (original == null) {
        throw const BrokerRouteException('IDENTITY_NOT_VERIFIED');
      }
      await _persistVerified(original, await _verify(original));
    }
    final store = ref.read(brokerRouteStoreProvider);
    final current = (await store.read(_profile.id, _profile.incarnationId!))!;
    await store.save(
      current.copyWith(mode: mode, fixedRouteId: fixed?.id),
      expectedGeneration: current.generation,
    );
    await _coordinator.configurationChanged(_profile);
    if (mode == BrokerRouteMode.automatic) await _coordinator.testAll(_profile);
  });

  Future<void> _toggle(BrokerAddress address, {bool remove = false}) async {
    final state = _coordinator.status(_profile)!;
    final l = AppLocalizations.of(context);
    if (remove || address.enabled) {
      final candidates = state.server.addresses
          .where(
            (a) =>
                a.id != address.id &&
                a.enabled &&
                a.verifiedIdentity == state.server.identityPublicKey &&
                a.verifiedIdentity != null,
          )
          .toList();
      final disconnects =
          state.server.mode == BrokerRouteMode.fixed || candidates.isEmpty;
      final approved = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(remove ? l.routesRemove : l.routesDisable),
          content: Text(
            disconnects
                ? l.routesDisconnect
                : l.routesReplacement(candidates.first.label),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(l.cancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(remove ? l.routesRemove : l.routesDisable),
            ),
          ],
        ),
      );
      if (approved != true || !mounted) return;
    }
    await _run(() async {
      final store = ref.read(brokerRouteStoreProvider);
      final current = (await store.read(_profile.id, _profile.incarnationId!))!;
      await store.save(
        current.copyWith(
          addresses: [
            for (final a in current.addresses)
              if (a.id != address.id)
                a
              else if (!remove)
                a.copyWith(enabled: !a.enabled, generation: a.generation + 1),
          ],
        ),
        expectedGeneration: current.generation,
      );
      if (state.activeRouteId == address.id ||
          state.server.fixedRouteId == address.id) {
        await _coordinator.configurationChanged(_profile);
      } else {
        await _coordinator.labelsChanged(_profile);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(brokerRouteCoordinatorProvider);
    final state = _coordinator.status(_profile);
    final l = AppLocalizations.of(context);
    final t = context.tokens;
    return Scaffold(
      appBar: AppBar(title: Text(_profile.displayName)),
      body: SettingsPageBody(
        children: [
          if (_error != null)
            ContextualDetails(
              label: l.routesFailed,
              detail: _error.toString(),
              child: Text(
                routeFailureLabel(l, _error!),
                style: TextStyle(color: t.statusError),
              ),
            ),
          if (state == null)
            const LinearProgressIndicator()
          else ...[
            SettingsRow(
              title: Text(l.routesMode),
              subtitle: Text(l.routesAutomaticHelp),
              trailing: DropdownButton<BrokerRouteMode>(
                value: state.server.mode,
                onChanged: _busy
                    ? null
                    : (mode) {
                        if (mode != null) {
                          unawaited(
                            _mode(
                              mode,
                              mode == BrokerRouteMode.fixed
                                  ? state.server.addresses
                                        .where((a) => a.enabled)
                                        .firstOrNull
                                  : null,
                            ),
                          );
                        }
                      },
                items: [
                  DropdownMenuItem(
                    value: BrokerRouteMode.automatic,
                    child: Text(l.routesAutomatic),
                  ),
                  DropdownMenuItem(
                    value: BrokerRouteMode.fixed,
                    child: Text(l.routesFixed),
                  ),
                ],
              ),
            ),
            if (state.server.addresses.every((a) => !a.enabled))
              Text(l.routesNoAddress),
            for (final address in state.server.addresses)
              _addressRow(context, state, address),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton.icon(
                  onPressed: _busy ? null : _edit,
                  icon: const Icon(Icons.add),
                  label: Text(l.routesAdd),
                ),
                TextButton(
                  onPressed: _busy
                      ? null
                      : () => _run(() async {
                          for (final address in state.server.addresses.where(
                            (a) => a.enabled,
                          )) {
                            if (state.server.identityPublicKey == null) {
                              final observation = await _verify(address);
                              await _persistVerified(address, observation);
                              break;
                            }
                          }
                          await _coordinator.testAll(_profile);
                        }),
                  child: Text(l.routesTestAll),
                ),
              ],
            ),
            for (final duplicate in _duplicates)
              SettingsRow(
                title: Text(l.routesMergeReview),
                subtitle: Text(duplicate.displayName),
                onTap: () async {
                  final kept = await Navigator.of(context).push<BrokerProfile>(
                    MaterialPageRoute(
                      builder: (_) => BrokerProfileMergePage(
                        first: _profile,
                        second: duplicate,
                      ),
                    ),
                  );
                  if (kept != null && mounted) {
                    _profile = kept;
                    await _load();
                  }
                },
                trailing: const Icon(Icons.chevron_right),
              ),
            if (_recoveredCount > 0)
              SettingsRow(
                title: Text(l.routesRecoveredTitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push<void>(
                  MaterialPageRoute(
                    builder: (_) =>
                        RecoveredBrokerDraftsPage(profile: _profile),
                  ),
                ),
              ),
            SettingsRow(
              title: Text(l.proxyManage),
              subtitle: Text(kIsWeb ? l.proxyBrowser : l.proxyDeviceOnly),
              onTap: () async {
                await Navigator.of(context).push<void>(
                  MaterialPageRoute(
                    builder: (_) => ProxyProfilesPage(
                      profile: _profile,
                      address: state.server.addresses
                          .where((a) => a.enabled)
                          .firstOrNull,
                    ),
                  ),
                );
                if (mounted) await _load();
              },
              trailing: const Icon(Icons.chevron_right),
            ),
            SettingsRow(
              title: Text(l.routesConfigureServer),
              subtitle: Text(l.routesOwnerOnly),
              onTap: () => Navigator.of(context).push<void>(
                MaterialPageRoute(
                  builder: (_) =>
                      BrokerRouteConfigurationPage(profile: _profile),
                ),
              ),
              trailing: const Icon(Icons.chevron_right),
            ),
          ],
        ],
      ),
    );
  }

  Widget _addressRow(
    BuildContext context,
    BrokerRouteStatus state,
    BrokerAddress address,
  ) {
    final l = AppLocalizations.of(context);
    final t = context.tokens;
    final observation = state.observations[address.id];
    final failure = state.failures[address.id];
    final inUse = state.activeRouteId == address.id;
    final proxy = _proxies.where((p) => p.id == address.proxyId).firstOrNull;
    final pathLabel = address.proxyId == null
        ? 'Direct'
        : proxy?.protocol.name ?? 'Missing proxy';
    final label = !address.enabled
        ? l.routesDisabled
        : state.testing.contains(address.id)
        ? l.routesTesting
        : failure != null
        ? routeFailureLabel(l, failure)
        : inUse
        ? l.routesInUse
        : observation != null
        ? l.routesAvailable
        : address.verifiedIdentity == null
        ? l.routesNotVerified
        : l.routesNotTested;
    final time = observation == null
        ? null
        : MaterialLocalizations.of(context).formatTimeOfDay(
            TimeOfDay.fromDateTime(observation.checkedAt.toLocal()),
          );
    return ContextualDetails(
      label: address.label,
      detailsBuilder: () => [
        address.origin,
        'Path: $pathLabel',
        if (failure != null) failure,
        if (observation != null)
          'Handshake: ${observation.handshakeMilliseconds} ms',
        if (observation != null) 'Samples: ${observation.samples}',
      ].join('\n'),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    address.label,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  SelectableText(
                    address.origin.toString(),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(height: 4),
                  Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      StatusPill(
                        label: label,
                        color: failure != null
                            ? t.statusError
                            : inUse
                            ? t.statusWorking
                            : t.textSecondary,
                      ),
                      if (address.proxyId != null)
                        Text(
                          proxy?.name ?? l.proxyMissing,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      if (observation?.medianMilliseconds
                          case final milliseconds?)
                        Text(
                          l.routesLatency(milliseconds.round().toString()),
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                    ],
                  ),
                  if (time != null)
                    Text(
                      [
                        l.routesChecked(time),
                        if (!observation!.fresh(_coordinator.now()))
                          l.routesStale,
                      ].join(' · '),
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                ],
              ),
            ),
            PopupMenuButton<String>(
              key: Key('address-menu-${address.label}'),
              enabled: !_busy,
              tooltip: l.routesManage,
              onSelected: (action) {
                switch (action) {
                  case 'test':
                    unawaited(_test(address));
                  case 'edit':
                    unawaited(_edit(address));
                  case 'toggle':
                    unawaited(_toggle(address));
                  case 'remove':
                    unawaited(_toggle(address, remove: true));
                  case 'fixed':
                    unawaited(_mode(BrokerRouteMode.fixed, address));
                }
              },
              itemBuilder: (_) => [
                PopupMenuItem(
                  value: 'test',
                  enabled: address.enabled,
                  child: Text(l.routesTest),
                ),
                PopupMenuItem(value: 'edit', child: Text(l.edit)),
                PopupMenuItem(
                  value: 'fixed',
                  enabled: address.enabled,
                  child: Text(l.routesFixed),
                ),
                PopupMenuItem(
                  value: 'toggle',
                  child: Text(
                    address.enabled ? l.routesDisable : l.routesEnable,
                  ),
                ),
                PopupMenuItem(value: 'remove', child: Text(l.routesRemove)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Translate only observed stages; retain platform detail in the context menu.
String routeFailureLabel(AppLocalizations l, Object error) {
  final code = brokerRouteFailureCode(error, browser: kIsWeb);
  return switch (code) {
    'IDENTITY_VERIFICATION_REQUIRED' => l.routesVerifyOriginal,
    'AUTHORIZATION_REQUIRED' => l.routesSignIn,
    'BROWSER_BLOCKED' => l.routesBrowserBlocked,
    'SERVER_IDENTITY_CHANGED' || 'PRINCIPAL_CHANGED' => l.routesIdentityChanged,
    'PROXY_UNSUPPORTED' => l.routesUnavailable,
    'BROWSER_MIXED_CONTENT' => l.routesMixedContent,
    'PROXY_UNREACHABLE' || 'PROXY_BACKOFF' => l.routesProxyUnreachable,
    'TLS_FAILED' => l.routesTLSFailed,
    'BROKER_INCOMPATIBLE' => l.routesIncompatible,
    'PROXY_SETUP_REQUIRED' || 'PROXY_CREDENTIAL_REQUIRED' => l.proxyMissing,
    'PROXY_AUTHENTICATION_REQUIRED' => l.proxySignIn,
    'WEBSOCKET_NOT_READY' || 'WEBSOCKET_TIMEOUT' => l.routesWebSocketFailed,
    'NO_ENABLED_ADDRESS' => l.routesNoAddress,
    _ => l.routesFailed,
  };
}
