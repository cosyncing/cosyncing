import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/components/contextual_details.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_store.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_routes.dart';
import 'package:cosyncing_client/src/features/connection/provider/broker_route_providers.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_addresses_page.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Device-local reusable proxy profiles. Imported missing bindings stay
/// blocked.
class ProxyProfilesPage extends ConsumerStatefulWidget {
  /// Manages proxy profiles on this device and their address dependents.
  const ProxyProfilesPage({required this.profile, this.address, super.key});

  /// Saved server/access binding named by this screen and its confirmations.
  final BrokerProfile profile;

  /// Saved address being edited or used to test the proposed configuration.
  final BrokerAddress? address;
  @override
  ConsumerState<ProxyProfilesPage> createState() => _ProxyProfilesPageState();
}

class _ProxyProfilesPageState extends ConsumerState<ProxyProfilesPage> {
  List<BrokerProxyProfile> _profiles = [];
  Object? _error;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final store = ref.read(brokerRouteStoreProvider);
      final coordinator = ref.read(brokerRouteCoordinatorProvider);
      final before = {
        for (final profile in await store.proxies())
          profile.id: profile.generation,
      };
      await store.recoverProxyWrites();
      final profiles = await store.proxies();
      final after = {
        for (final profile in profiles) profile.id: profile.generation,
      };
      for (final id in {...before.keys, ...after.keys}) {
        if (before[id] != after[id]) await coordinator.proxyChanged(id);
      }
      if (mounted) {
        setState(() {
          _profiles = profiles;
          _error = null;
        });
      }
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  Future<void> _edit([BrokerProxyProfile? profile]) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (_) => _ProxyEditor(
        profile: profile,
        server: widget.profile,
        address: widget.address,
      ),
    );
    if (!mounted || result == null) return;
    await _load();
  }

  Future<void> _remove(BrokerProxyProfile profile) async {
    final store = ref.read(brokerRouteStoreProvider);
    final coordinator = ref.read(brokerRouteCoordinatorProvider);
    final dependents = await store.proxyDependents(profile.id);
    if (!mounted) return;
    final l = AppLocalizations.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(l.proxyRemove),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(l.proxyRemoveBody),
              const SizedBox(height: 12),
              for (final dependent in dependents) Text(dependent.$2.label),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text(l.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(l.proxyRemove),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await store.removeProxy(profile.id);
      await coordinator.proxyChanged(profile.id);
      if (mounted) await _load();
    } on Object catch (error) {
      // Metadata can be committed even if retiring the old secure slot fails.
      // Required paths must stop using their previous pool immediately.
      if (await store.proxy(profile.id) == null) {
        await coordinator.proxyChanged(profile.id);
      }
      final profiles = await store.proxies();
      if (mounted) {
        setState(() {
          _profiles = profiles;
          _error = error;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l.proxyManage)),
      body: SettingsPageBody(
        children: [
          Text(kIsWeb ? l.proxyBrowser : l.proxyDeviceOnly),
          if (_error != null)
            ContextualDetails(
              label: l.routesFailed,
              detail: _error.toString(),
              child: Text(routeFailureLabel(l, _error!)),
            ),
          for (final profile in _profiles)
            SettingsRow(
              title: Text(profile.name),
              subtitle: Text(
                [
                  if (profile.protocol == BrokerProxyProtocol.http)
                    'HTTP'
                  else
                    'SOCKS5',
                  '${profile.host}:${profile.port}',
                ].join(' · '),
              ),
              onTap: kIsWeb ? null : () => _edit(profile),
              trailing: IconButton(
                tooltip: l.proxyRemove,
                icon: const Icon(Icons.delete_outline),
                onPressed: () => _remove(profile),
              ),
            ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: kIsWeb ? null : _edit,
            icon: const Icon(Icons.add),
            label: Text(l.proxyAdd),
          ),
        ],
      ),
    );
  }
}

class _ProxyEditor extends ConsumerStatefulWidget {
  const _ProxyEditor({required this.server, this.profile, this.address});

  /// Saved logical server/access binding represented by this status.
  final BrokerProfile server;

  /// Saved server/access binding named by this screen and its confirmations.
  final BrokerProxyProfile? profile;

  /// Saved address being edited or used to test the proposed configuration.
  final BrokerAddress? address;
  @override
  ConsumerState<_ProxyEditor> createState() => _ProxyEditorState();
}

class _ProxyEditorState extends ConsumerState<_ProxyEditor> {
  late final String _id = widget.profile?.id ?? newConnectionId();
  late final _name = TextEditingController(text: widget.profile?.name ?? '');
  late final _host = TextEditingController(text: widget.profile?.host ?? '');
  late final _port = TextEditingController(
    text: widget.profile?.port.toString() ?? '',
  );
  final _user = TextEditingController();
  final _password = TextEditingController();
  late BrokerProxyProtocol _protocol =
      widget.profile?.protocol ?? BrokerProxyProtocol.http;
  late bool _auth = widget.profile?.credentialKey != null;
  bool _reveal = false;
  bool _busy = false;
  bool _tested = false;
  Object? _error;
  List<(String, BrokerAddress)> _dependents = [];
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final store = ref.read(brokerRouteStoreProvider);
      final secret = await store.proxySecret(widget.profile);
      final dependents = await store.proxyDependents(_id);
      if (!mounted) return;
      setState(() {
        _user.text = secret?.username ?? '';
        _password.text = secret?.password ?? '';
        _dependents = dependents;
      });
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  @override
  void dispose() {
    for (final controller in [_name, _host, _port, _user, _password]) {
      controller.dispose();
    }
    super.dispose();
  }

  BrokerProxyProfile? _draft() {
    try {
      final port = int.tryParse(_port.text) ?? 0;
      validateProxyEndpoint(_host.text, port);
      if (_name.text.trim().isEmpty ||
          (_auth && (_user.text.isEmpty || _password.text.isEmpty))) {
        return null;
      }
      return BrokerProxyProfile(
        id: _id,
        name: _name.text.trim(),
        protocol: _protocol,
        host: _host.text,
        port: port,
        generation: widget.profile?.generation ?? 1,
        credentialKey: _auth
            ? widget.profile?.credentialKey ?? 'pending-proxy-secret'
            : null,
      );
    } on BrokerRouteException {
      return null;
    }
  }

  void _changed() => setState(() {
    _tested = false;
    _error = null;
  });
  Future<void> _test() async {
    final draft = _draft();
    final address = widget.address;
    if (draft == null || address == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(brokerRouteCoordinatorProvider)
          .testProxy(
            widget.server,
            address,
            draft,
            _auth ? BrokerProxyCredentials(_user.text, _password.text) : null,
          );
      if (mounted) setState(() => _tested = true);
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    final draft = _draft();
    if (draft == null) return;
    final old = widget.profile;
    final store = ref.read(brokerRouteStoreProvider);
    final coordinator = ref.read(brokerRouteCoordinatorProvider);
    final BrokerProxyCredentials? sameSecret;
    try {
      sameSecret = await store.proxySecret(old);
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
      return;
    }
    final labelOnly =
        old != null &&
        old.protocol == draft.protocol &&
        old.host == draft.host &&
        old.port == draft.port &&
        (sameSecret != null) == _auth &&
        (!_auth ||
            (sameSecret?.username == _user.text &&
                sameSecret?.password == _password.text));
    if (!labelOnly && _dependents.isNotEmpty && !_tested) {
      if (!mounted) return;
      final l = AppLocalizations.of(context);
      final confirm = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
          title: Text(l.routesSaveUnverified),
          content: Text(l.routesDisconnect),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(l.cancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(l.routesSaveUnverified),
            ),
          ],
        ),
      );
      if (confirm != true) return;
    }
    if (!mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final published = await store.saveProxy(
        draft,
        credentials: _auth && !labelOnly
            ? BrokerProxyCredentials(_user.text, _password.text)
            : null,
        clearCredentials: !_auth && old?.credentialKey != null,
      );
      if (old != null && published.generation != old.generation) {
        await coordinator.proxyChanged(old.id);
      }
      if (mounted) Navigator.pop(context, !labelOnly);
    } on Object catch (error) {
      if (old != null &&
          (await store.proxy(old.id))?.generation != old.generation) {
        await coordinator.proxyChanged(old.id);
      }
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return AlertDialog(
      title: Text(widget.profile == null ? l.proxyAdd : l.edit),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _name,
                enabled: !_busy,
                decoration: InputDecoration(labelText: l.proxyName),
                onChanged: (_) => _changed(),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<BrokerProxyProtocol>(
                initialValue: _protocol,
                decoration: InputDecoration(labelText: l.proxyProtocol),
                items: [
                  DropdownMenuItem(
                    value: BrokerProxyProtocol.http,
                    child: Text(l.proxyProtocolHttp),
                  ),
                  DropdownMenuItem(
                    value: BrokerProxyProtocol.socks5,
                    child: Text(l.proxyProtocolSocks5),
                  ),
                ],
                onChanged: _busy
                    ? null
                    : (value) {
                        if (value != null) _protocol = value;
                        _changed();
                      },
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _host,
                enabled: !_busy,
                autocorrect: false,
                decoration: InputDecoration(labelText: l.proxyHost),
                onChanged: (_) => _changed(),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _port,
                enabled: !_busy,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(labelText: l.proxyPort),
                onChanged: (_) => _changed(),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(l.proxyAuthentication),
                value: _auth,
                onChanged: _busy
                    ? null
                    : (value) {
                        _auth = value;
                        _changed();
                      },
              ),
              if (_auth) ...[
                TextField(
                  controller: _user,
                  enabled: !_busy,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: InputDecoration(labelText: l.proxyUsername),
                  onChanged: (_) => _changed(),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _password,
                  enabled: !_busy,
                  obscureText: !_reveal,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: InputDecoration(
                    labelText: l.proxyPassword,
                    suffixIcon: IconButton(
                      tooltip: l.proxyReveal,
                      icon: Icon(
                        _reveal
                            ? Icons.visibility_off_outlined
                            : Icons.visibility_outlined,
                      ),
                      onPressed: () => setState(() => _reveal = !_reveal),
                    ),
                  ),
                  onChanged: (_) => _changed(),
                ),
              ],
              if (_protocol == BrokerProxyProtocol.socks5)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(l.proxyDns),
                ),
              if (_dependents.isNotEmpty) ...[
                const SizedBox(height: 16),
                Text(l.proxyAffected),
                for (final dependent in _dependents)
                  Text(
                    [
                      dependent.$2.label,
                      dependent.$2.origin.toString(),
                    ].join(' · '),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
              ],
              if (_error != null)
                ContextualDetails(
                  label: l.routesFailed,
                  detail: _error.toString(),
                  child: Text(routeFailureLabel(l, _error!)),
                ),
              if (_tested) Text(l.routesAvailable),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: Text(l.cancel),
        ),
        TextButton(
          onPressed: _busy || _draft() == null || widget.address == null
              ? null
              : _test,
          child: Text(l.routesTest),
        ),
        FilledButton(
          onPressed: _busy || _draft() == null ? null : _save,
          child: Text(l.save),
        ),
      ],
    );
  }
}
