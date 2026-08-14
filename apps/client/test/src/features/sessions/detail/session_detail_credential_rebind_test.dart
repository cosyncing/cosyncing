import 'dart:async';

import 'package:cosyncing_client/src/features/broker_profiles/data/drift_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_credential_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/settings/controller/broker_credentials_controller.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  testWidgets(
    'a same-profile credential save replaces the mounted anonymous socket',
    (tester) async {
      final database = AppDatabase(NativeDatabase.memory());
      final profile = await DriftBrokerProfileRepository(
        database,
      ).save(createTestBrokerProfile());
      final credentialStore = InMemoryCredentialStore();
      final connections = <ScriptedSessionDetailConnection>[];
      final resolverTokens = <String?>[];
      final releaseAuthenticatedClient = Completer<void>();

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          database: database,
          brokerProfile: profile,
          credentialStore: credentialStore,
          brokerClientLoader: (ref) async {
            final credentialKey = ref
                .watch(activeBrokerProfileProvider)
                ?.credentialKey;
            if (credentialKey != null) {
              // Production resolves secure storage asynchronously. Hold that
              // loading gap explicitly: the previous AsyncData is gone by the
              // time the authenticated client becomes available.
              await releaseAuthenticatedClient.future;
            }
            final token = credentialKey == null
                ? null
                : await credentialStore.readBrokerToken(credentialKey);
            return FakeBrokerClient(
              token: token,
            );
          },
          connectionFactory:
              ({required resolver, required sessionId, required tool}) {
                resolverTokens.add(resolver.token);
                final connection = ScriptedSessionDetailConnection(
                  events: const [],
                );
                connections.add(connection);
                return connection;
              },
        ),
      );
      await tester.pumpAndSettle();

      expect(resolverTokens, <String?>[null]);
      expect(connections.single.state, SessionDetailConnectionStatus.connected);

      final container = ProviderScope.containerOf(
        tester.element(find.byType(SessionDetailPage)),
      );
      final save = container
          .read(brokerCredentialsControllerProvider.notifier)
          .saveToken('fresh-token');
      await save;
      await tester.pump();
      expect(resolverTokens, <String?>[null]);
      releaseAuthenticatedClient.complete();
      await tester.pumpAndSettle();

      expect(
        resolverTokens,
        <String?>[null, 'fresh-token'],
        reason: 'the replacement connection must use the rebuilt broker client',
      );
      expect(connections.first.disposeCount, 1);
      expect(connections.last.state, SessionDetailConnectionStatus.connected);
    },
  );
}
