import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/components/contextual_details.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_store.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_routes.dart';
import 'package:cosyncing_client/src/features/connection/provider/broker_route_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_addresses_page.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/features/updates/controller/updates_controller.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart' show Variable;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Review both verified access profiles and every conflicting proxy binding.
class BrokerProfileMergePage extends ConsumerStatefulWidget {
  /// Reviews two same-principal profiles before combining local data.
  const BrokerProfileMergePage({
    required this.first,
    required this.second,
    super.key,
  });

  /// First verified access binding included in the merge review.
  final BrokerProfile first;

  /// Other verified access binding; a distinct principal cannot be merged.
  final BrokerProfile second;
  @override
  ConsumerState<BrokerProfileMergePage> createState() =>
      _BrokerProfileMergePageState();
}

class _BrokerProfileMergePageState
    extends ConsumerState<BrokerProfileMergePage> {
  late String _survivor =
      ref.read(activeBrokerProfileProvider)?.id == widget.second.id
      ? widget.second.id
      : widget.first.id;
  final _routes = <String, BrokerRouteServer>{};
  final _counts = <String, (int, int, int)>{};
  final _choices = <String, String>{};
  final _proxyNames = <String, String>{};
  bool _busy = false;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final store = ref.read(brokerRouteStoreProvider);
      final db = ref.read(appDatabaseProvider);
      for (final proxy in await store.proxies()) {
        _proxyNames[proxy.id] = proxy.name;
      }
      for (final profile in [widget.first, widget.second]) {
        _routes[profile.id] = (await store.read(
          profile.id,
          profile.incarnationId!,
        ))!;
        final source = RosterSource.ofProfile(profile).storageKey;
        Future<int> count(String table, [String condition = '1']) async =>
            (await db
                    .customSelect(
                      'SELECT count(*) AS n FROM $table WHERE '
                      'broker_profile_id=? AND $condition',
                      variables: [Variable(source)],
                    )
                    .getSingle())
                .read<int>('n');
        _counts[profile.id] = (
          await count('session_draft_rows'),
          await count('session_outbox_rows', "status!='delivered'"),
          await count('artifact_transfer_rows'),
        );
      }
      if (mounted) setState(() {});
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  Map<String, List<BrokerAddress>> get _conflicts {
    final origins = <String, List<BrokerAddress>>{};
    for (final server in _routes.values) {
      for (final address in server.addresses) {
        final list = origins.putIfAbsent(address.origin.origin, () => []);
        if (!list.any((a) => a.proxyId == address.proxyId)) list.add(address);
      }
    }
    return {...origins}..removeWhere((_, routes) => routes.length < 2);
  }

  Future<void> _merge() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(openSessionsControllerProvider.notifier)
          .flushDraftsForUpdate();
      final kept = _survivor == widget.first.id ? widget.first : widget.second;
      final removed = _survivor == widget.first.id
          ? widget.second
          : widget.first;
      final coordinator = ref.read(brokerRouteCoordinatorProvider);
      await ref.read(brokerProfileMutationGateProvider).runExclusive(() async {
        coordinator
          ..retireProfile(kept)
          ..retireProfile(removed);
        final cleaned = await ref
            .read(brokerProfileMergeProvider)
            .merge(
              survivor: kept,
              removed: removed,
              survivorRoutes: _routes[kept.id]!,
              removedRoutes: _routes[removed.id]!,
              chosenRouteByOrigin: _choices,
            );
        final active = ref.read(activeBrokerProfileProvider);
        if (active?.id == kept.id || active?.id == removed.id) {
          await ref
              .read(activeBrokerProfileStoreProvider)
              .setActiveProfileId(kept.id);
          ref.read(activeBrokerProfileProvider.notifier).state = kept;
          ref.invalidate(brokerClientProvider);
        }
        ref
          ..invalidate(brokerProfileListProvider)
          ..invalidate(updatesControllerProvider);
        if (!cleaned && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                AppLocalizations.of(context).routesMergeCleanupPending,
              ),
            ),
          );
        }
      });
      if (mounted) Navigator.pop(context, kept);
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _pathLabel(BrokerAddress route, AppLocalizations l) =>
      route.proxyId == null
      ? l.proxyDirect
      : _proxyNames[route.proxyId] ?? l.proxyMissing;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l.routesMergeTitle)),
      body: SettingsPageBody(
        children: [
          Text(
            l.routesMergeSameAccess,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 12),
          Text(l.routesMergeHelp),
          if (_error != null)
            ContextualDetails(
              label: l.routesFailed,
              detail: _error.toString(),
              child: Text(routeFailureLabel(l, _error!)),
            ),
          for (final profile in [widget.first, widget.second]) ...[
            const SizedBox(height: 20),
            Text(
              profile.displayName,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            Text(
              profile.sourceIdentity!.endsWith(':owner')
                  ? l.routesAccessOwner
                  : l.routesAccessPeer,
            ),
            if (_counts[profile.id] case final counts?)
              Text(
                l.routesMergeImpact(
                  '${counts.$1}',
                  '${counts.$2}',
                  '${counts.$3}',
                ),
              ),
            for (final route
                in _routes[profile.id]?.addresses ?? <BrokerAddress>[])
              SelectableText(
                [
                  route.label,
                  route.origin.toString(),
                  _pathLabel(route, l),
                ].join(' · '),
              ),
          ],
          const SizedBox(height: 20),
          SettingsRow(
            title: Text(l.routesMergeKeep),
            trailing: DropdownButton<String>(
              value: _survivor,
              onChanged: _busy
                  ? null
                  : (value) {
                      if (value != null) setState(() => _survivor = value);
                    },
              items: [
                for (final profile in [widget.first, widget.second])
                  DropdownMenuItem(
                    value: profile.id,
                    child: Text(profile.displayName),
                  ),
              ],
            ),
          ),
          for (final conflict in _conflicts.entries) ...[
            Text(l.routesMergeConflict(conflict.key)),
            Text(l.routesMergeProxyHelp),
            DropdownButton<String>(
              value: _choices[conflict.key],
              isExpanded: true,
              onChanged: _busy
                  ? null
                  : (value) {
                      if (value != null) {
                        setState(() => _choices[conflict.key] = value);
                      }
                    },
              items: [
                for (final route in conflict.value)
                  DropdownMenuItem(
                    value: route.id,
                    child: Text(
                      [route.label, _pathLabel(route, l)].join(' · '),
                    ),
                  ),
              ],
            ),
          ],
          const SizedBox(height: 20),
          FilledButton(
            onPressed:
                _busy ||
                    _routes.length != 2 ||
                    _conflicts.keys.any((key) => !_choices.containsKey(key))
                ? null
                : _merge,
            child: Text(l.routesMerge),
          ),
        ],
      ),
    );
  }
}

/// Recoverable alternatives are never concatenated into a current composer.
class RecoveredBrokerDraftsPage extends ConsumerStatefulWidget {
  /// Pages through preserved draft alternatives for one profile.
  const RecoveredBrokerDraftsPage({required this.profile, super.key});

  /// Saved server/access binding named by this screen and its confirmations.
  final BrokerProfile profile;
  @override
  ConsumerState<RecoveredBrokerDraftsPage> createState() =>
      _RecoveredBrokerDraftsPageState();
}

class _RecoveredBrokerDraftsPageState
    extends ConsumerState<RecoveredBrokerDraftsPage> {
  final _rows = <Map<String, dynamic>>[];
  int _cursor = 0;
  int _first = 0;
  int _page = 0;
  bool _more = true;
  bool _busy = false;
  Object? _error;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool previous = false}) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final rows = await ref
          .read(brokerProfileMergeProvider)
          .recoveredDrafts(
            source: RosterSource.ofProfile(widget.profile).storageKey,
            cursor: previous ? _first : _cursor,
            previous: previous,
          );
      if (!mounted) return;
      setState(() {
        final page = rows.take(100).toList();
        if (previous) page.setAll(0, page.reversed.toList());
        if (_rows.isNotEmpty) _page += previous ? -1 : 1;
        _rows.clear();
        for (final row in page) {
          _rows.add(row.payload);
        }
        if (page.isNotEmpty) {
          _first = page.first.rowId;
          _cursor = page.last.rowId;
        }
        _more = previous || rows.length > 100;
        _error = null;
      });
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l.routesRecoveredTitle)),
      body: ListView.builder(
        itemCount: _rows.length + 1,
        itemBuilder: (context, index) {
          if (index == _rows.length) {
            return Column(
              children: [
                if (_error != null)
                  ContextualDetails(
                    label: l.routesFailed,
                    detail: '$_error',
                    child: Text(l.routesFailed),
                  ),
                if (_page > 0)
                  TextButton(
                    onPressed: _busy ? null : () => _load(previous: true),
                    child: Text(l.storagePrevious),
                  ),
                if (_more)
                  TextButton(
                    onPressed: _busy ? null : _load,
                    child: Text(l.storageNext),
                  ),
              ],
            );
          }
          final row = _rows[index];
          final text = row['draft_text'] as String;
          final alternatives = <String>{
            text,
            if (row['conflict_text'] is String) row['conflict_text'] as String,
          };
          return ExpansionTile(
            title: Text(l.routesRecoveredFrom(row['serverName'] as String)),
            subtitle: Text(text, maxLines: 2, overflow: TextOverflow.ellipsis),
            children: [
              for (final alternative in alternatives) ...[
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: SelectableText(alternative),
                ),
                TextButton(
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: alternative));
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text(l.routesRecoveredCopied)),
                      );
                    }
                  },
                  child: Text(l.copyText),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}
