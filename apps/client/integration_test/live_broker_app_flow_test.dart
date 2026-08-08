import 'dart:io';

import 'package:cosyncing_client/src/app/router/router.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  final config = _resolveLiveAppBrokerConfig(
    brokerUrlEnv: Platform.environment['COSYNCING_BROKER_URL'],
  );

  testWidgets(
    'connects through the app UI and renders live broker sessions',
    (tester) async {
      tester.view
        ..physicalSize = const Size(1280, 900)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final router = createGoRouter(initialLocation: '/connection');
      addTearDown(router.dispose);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            brokerProfileRepositoryProvider.overrideWithValue(
              InMemoryBrokerProfileRepository(),
            ),
            activeBrokerProfileStoreProvider.overrideWithValue(
              _InMemoryActiveBrokerProfileStore(),
            ),
            activeBrokerProfileHydrationProvider.overrideWith((_) async {}),
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
          ],
          child: MaterialApp.router(
            theme: ThemeData(
              colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
              useMaterial3: true,
              splashFactory: InkRipple.splashFactory,
            ),
            routerConfig: router,
          ),
        ),
      );

      await tester.enterText(find.byType(TextFormField), config.brokerUrl!);
      await tester.tap(find.text('Connect'));
      await _pumpUntilFound(tester, find.text('Connected'));

      await tester.tap(find.byKey(const Key('app-command-sessions')));
      await _pumpUntil(
        tester,
        () =>
            find.text('Failed to load sessions').evaluate().isNotEmpty ||
            find.text('No sessions').evaluate().isNotEmpty ||
            _findKnownToolText().evaluate().isNotEmpty,
      );

      expect(find.text('Failed to load sessions'), findsNothing);
      expect(find.text('No sessions'), findsNothing);
      expect(_findKnownToolText(), findsAtLeastNWidgets(1));
    },
    skip: config.shouldSkip,
  );
}

Finder _findKnownToolText() {
  return find.byWidgetPredicate(
    (widget) =>
        widget is Text &&
        const {'claude', 'codex', 'opencode', 'pi'}.contains(widget.data),
  );
}

Future<void> _pumpUntilFound(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 10),
}) {
  return _pumpUntil(
    tester,
    () => finder.evaluate().isNotEmpty,
    timeout: timeout,
  );
}

Future<void> _pumpUntil(
  WidgetTester tester,
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 10),
}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 100));
    if (condition()) {
      return;
    }
  }

  fail('Timed out waiting for live app broker condition.');
}

class _LiveAppBrokerConfig {
  const _LiveAppBrokerConfig({
    required this.brokerUrl,
    required this.skipReason,
  });

  final String? brokerUrl;
  final String? skipReason;

  bool get shouldSkip => skipReason != null;
}

_LiveAppBrokerConfig _resolveLiveAppBrokerConfig({
  required String? brokerUrlEnv,
}) {
  final input = brokerUrlEnv?.trim();
  if (input == null || input.isEmpty) {
    return const _LiveAppBrokerConfig(
      brokerUrl: null,
      skipReason: 'Skipped: set COSYNCING_BROKER_URL to run live app smoke.',
    );
  }

  try {
    final uri = normalizeBrokerUrl(input);
    if (validateBrokerUrl(uri).isNotEmpty) {
      return const _LiveAppBrokerConfig(
        brokerUrl: null,
        skipReason: 'Skipped: COSYNCING_BROKER_URL is not a valid broker URL.',
      );
    }

    if (!isLoopbackHost(uri.host)) {
      return const _LiveAppBrokerConfig(
        brokerUrl: null,
        skipReason:
            'Skipped: live app smoke currently supports loopback brokers only.',
      );
    }

    return _LiveAppBrokerConfig(
      brokerUrl: uri.toString(),
      skipReason: null,
    );
  } on FormatException {
    return const _LiveAppBrokerConfig(
      brokerUrl: null,
      skipReason: 'Skipped: COSYNCING_BROKER_URL is not a valid broker URL.',
    );
  }
}

class _InMemoryActiveBrokerProfileStore implements ActiveBrokerProfileStore {
  String? _activeProfileId;

  @override
  Future<String?> getActiveProfileId() async {
    return _activeProfileId;
  }

  @override
  Future<void> setActiveProfileId(String? profileId) async {
    _activeProfileId = profileId;
  }

  @override
  Future<void> clearActiveProfileId() async {
    _activeProfileId = null;
  }
}
