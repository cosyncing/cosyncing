import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/components/contextual_details.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_probe.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_store.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_routes.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_addresses_page.dart';
import 'package:cosyncing_client/src/features/connection/view/proxy_profiles_page.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// A proposed address, accompanied by its exact path's verification if tested.
final class BrokerAddressEdit {
  /// Returns an edited address and its optional verified observation.
  const BrokerAddressEdit(this.address, this.observation);

  /// Saved address being edited or used to test the proposed configuration.
  final BrokerAddress address;

  /// Successful proof and readiness result for the proposed configuration.
  final BrokerRouteObservation? observation;
}

/// Add/edit keeps canonical destination approval separate from proxy secrets.
class BrokerAddressEditor extends ConsumerStatefulWidget {
  /// Reviews a proposed address without replacing the working path.
  const BrokerAddressEditor({
    required this.profile,
    required this.server,
    required this.verify,
    this.address,
    super.key,
  });

  /// Saved server/access binding named by this screen and its confirmations.
  final BrokerProfile profile;

  /// Saved logical server/access binding represented by this status.
  final BrokerRouteServer server;

  /// Saved address being edited or used to test the proposed configuration.
  final BrokerAddress? address;

  /// Tests the proposed path without replacing a working saved connection.
  final Future<BrokerRouteObservation> Function(BrokerAddress) verify;
  @override
  ConsumerState<BrokerAddressEditor> createState() =>
      _BrokerAddressEditorState();
}

class _BrokerAddressEditorState extends ConsumerState<BrokerAddressEditor> {
  late final _label = TextEditingController(text: widget.address?.label ?? '');
  late final _origin = TextEditingController(
    text: widget.address == null
        ? ''
        : '${widget.address!.origin.scheme}://${widget.address!.origin.host}:${widget.address!.origin.port}',
  );
  late String? _proxy = widget.address?.proxyId;
  final String _newId = newConnectionId();
  List<BrokerProxyProfile> _profiles = [];
  BrokerAddress? _tested;
  BrokerRouteObservation? _observation;
  Object? _error;
  bool _busy = false;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_loadProxies());
  }

  @override
  void dispose() {
    _generation++;
    _label.dispose();
    _origin.dispose();
    super.dispose();
  }

  Future<void> _loadProxies() async {
    try {
      final profiles = await ref.read(brokerRouteStoreProvider).proxies();
      if (mounted) setState(() => _profiles = profiles);
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  BrokerAddress? _draft() {
    try {
      final uri = canonicalBrokerOrigin(_origin.text);
      if (_label.text.trim().isEmpty) return null;
      final existing = widget.address;
      final samePath = existing?.origin == uri && existing?.proxyId == _proxy;
      return BrokerAddress(
        id: samePath ? existing!.id : _newId,
        origin: uri,
        label: _label.text.trim(),
        order: existing?.order ?? widget.server.addresses.length,
        generation: samePath
            ? existing!.generation
            : (existing?.generation ?? 0) + 1,
        enabled: existing?.enabled ?? true,
        proxyId: _proxy,
        verifiedIdentity: samePath ? existing?.verifiedIdentity : null,
        legacyTrusted:
            (existing?.legacyTrusted ?? false) && existing?.origin == uri,
      );
    } on FormatException {
      return null;
    }
  }

  void _changed() => setState(() {
    _generation++;
    _tested = null;
    _observation = null;
    _error = null;
  });
  Future<void> _test() async {
    final draft = _draft();
    if (draft == null || _busy) return;
    final generation = _generation;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await widget.verify(draft);
      if (mounted && generation == _generation) {
        setState(() {
          _tested = draft;
          _observation = result;
        });
      }
    } on Object catch (error) {
      if (mounted && generation == _generation) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final draft = _draft();
    final unchanged =
        draft != null &&
        widget.address?.origin == draft.origin &&
        widget.address?.proxyId == draft.proxyId;
    final passed =
        _tested?.origin == draft?.origin &&
        _tested?.proxyId == draft?.proxyId &&
        _observation != null;
    return AlertDialog(
      title: Text(widget.address == null ? l.routesAdd : l.edit),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _label,
                enabled: !_busy,
                decoration: InputDecoration(labelText: l.routesLabel),
                onChanged: (_) => _changed(),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _origin,
                enabled: !_busy,
                autocorrect: false,
                keyboardType: TextInputType.url,
                decoration: InputDecoration(
                  labelText: l.routesOrigin,
                  errorText: _origin.text.isNotEmpty && draft == null
                      ? l.routesInvalid
                      : null,
                ),
                onChanged: (_) => _changed(),
              ),
              if (draft != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: SelectableText(
                    l.routesCanonical(draft.origin.toString()),
                  ),
                ),
              const SizedBox(height: 8),
              ExpansionTile(
                tilePadding: EdgeInsets.zero,
                title: Text(
                  l.routesAdvanced,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                children: [
                  if (kIsWeb) ...[
                    Text(l.proxyBrowser),
                    if (_proxy != null)
                      TextButton(
                        onPressed: _busy
                            ? null
                            : () {
                                _proxy = null;
                                _changed();
                              },
                        child: Text(l.proxyBrowserPath),
                      ),
                  ] else ...[
                    DropdownButtonFormField<String>(
                      initialValue: _proxy ?? '',
                      decoration: InputDecoration(
                        labelText: l.proxyLabel,
                        helperText: l.proxyDeviceOnly,
                      ),
                      items: [
                        DropdownMenuItem(value: '', child: Text(l.proxyDirect)),
                        for (final profile in _profiles)
                          DropdownMenuItem(
                            value: profile.id,
                            child: Text(profile.name),
                          ),
                        if (_proxy != null &&
                            !_profiles.any((p) => p.id == _proxy))
                          DropdownMenuItem(
                            value: _proxy,
                            child: Text(l.proxyMissing),
                          ),
                      ],
                      onChanged: _busy
                          ? null
                          : (value) {
                              _proxy = value == '' ? null : value;
                              _changed();
                            },
                    ),
                    TextButton(
                      onPressed: _busy || kIsWeb
                          ? null
                          : () async {
                              await Navigator.of(context).push<void>(
                                MaterialPageRoute(
                                  builder: (_) => ProxyProfilesPage(
                                    profile: widget.profile,
                                    address: draft ?? widget.address,
                                  ),
                                ),
                              );
                              if (mounted) await _loadProxies();
                            },
                      child: Text(l.proxyManage),
                    ),
                  ],
                ],
              ),
              if (_error != null)
                ContextualDetails(
                  label: l.routesFailed,
                  detail: _error.toString(),
                  child: Text(routeFailureLabel(l, _error!)),
                ),
              if (passed) Text(l.routesAvailable),
              if (!passed && !unchanged)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(l.routesKeepPrevious),
                ),
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
          onPressed: _busy || draft == null ? null : _test,
          child: Text(_busy ? l.routesTesting : l.routesTest),
        ),
        FilledButton(
          onPressed: _busy || draft == null
              ? null
              : () => Navigator.pop(
                  context,
                  BrokerAddressEdit(draft, passed ? _observation : null),
                ),
          child: Text(passed || unchanged ? l.save : l.routesSaveUnverified),
        ),
      ],
    );
  }
}
