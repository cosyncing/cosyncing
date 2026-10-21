import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/components/contextual_details.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_configuration_session.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Owner-managed advertised server origins and separate browser trust
/// allowlist.
class BrokerRouteConfigurationPage extends ConsumerStatefulWidget {
  /// Reviews owner-managed advertised and browser origins.
  const BrokerRouteConfigurationPage({required this.profile, super.key});

  /// Saved server/access binding named by this screen and its confirmations.
  final BrokerProfile profile;
  @override
  ConsumerState<BrokerRouteConfigurationPage> createState() =>
      _ConfigurationState();
}

class _ConfigurationState extends ConsumerState<BrokerRouteConfigurationPage> {
  final _advertised = TextEditingController();
  final _browsers = TextEditingController();
  BrokerRouteConfigurationSession? _client;
  int? _generation;
  bool _busy = false;
  Object? _error;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _advertised.dispose();
    _browsers.dispose();
    _client?.close();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final client = await ref.read(brokerClientFactoryProvider)(
        widget.profile,
      );
      if (!mounted) {
        client.close();
        return;
      }
      final session = _client = BrokerRouteConfigurationSession(client);
      final configuration = await session.load();
      if (!mounted) return;
      setState(() {
        _generation = configuration['generation'] as int;
        _advertised.text = (configuration['advertisedOrigins'] as List).join(
          '\n',
        );
        _browsers.text = (configuration['trustedClientOrigins'] as List).join(
          '\n',
        );
      });
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  List<String> _origins(String text) => text
      .split('\n')
      .map((line) => line.trim())
      .where((line) => line.isNotEmpty)
      .map((line) {
        final uri = Uri.parse(line);
        if (!['http', 'https'].contains(uri.scheme) ||
            uri.host.isEmpty ||
            uri.userInfo.isNotEmpty ||
            uri.hasQuery ||
            uri.hasFragment ||
            (uri.path.isNotEmpty && uri.path != '/')) {
          throw const FormatException('Invalid origin');
        }
        return uri.origin;
      })
      .toSet()
      .toList();
  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final generation = await _client!.save(
        generation: _generation!,
        advertisedOrigins: _origins(_advertised.text),
        trustedClientOrigins: _origins(_browsers.text),
      );
      if (mounted) setState(() => _generation = generation);
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
      appBar: AppBar(title: Text(l.routesConfigureServer)),
      body: SettingsPageBody(
        children: [
          Text(l.routesOwnerOnly),
          const SizedBox(height: 16),
          if (_error != null)
            ContextualDetails(
              label: l.routesFailed,
              detail: _error.toString(),
              child: Text(l.routesFailed),
            ),
          TextField(
            controller: _advertised,
            enabled: _generation != null && !_busy,
            minLines: 2,
            maxLines: 8,
            decoration: InputDecoration(labelText: l.routesAdvertised),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _browsers,
            enabled: _generation != null && !_busy,
            minLines: 2,
            maxLines: 8,
            decoration: InputDecoration(labelText: l.routesTrustedBrowsers),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy || _generation == null ? null : _save,
            child: Text(l.save),
          ),
        ],
      ),
    );
  }
}
