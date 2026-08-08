import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_mutation_gate.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/drift_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Provides the [BrokerProfileRepository] singleton.
///
/// Override this provider in tests to inject a fake repository.
final brokerProfileRepositoryProvider = Provider<BrokerProfileRepository>(
  (ref) => DriftBrokerProfileRepository(ref.watch(appDatabaseProvider)),
);

/// Serializes every profile-owned credential, row, and active-state mutation.
final brokerProfileMutationGateProvider = Provider<BrokerProfileMutationGate>(
  (ref) => BrokerProfileMutationGate(
    ref.watch(brokerProfileRepositoryProvider),
  ),
);

/// Async notifier that loads and manages the list of saved broker profiles.
final brokerProfileListProvider =
    AsyncNotifierProvider<BrokerProfileListNotifier, List<BrokerProfile>>(
      BrokerProfileListNotifier.new,
    );

/// Notifier for the broker profile list.
class BrokerProfileListNotifier extends AsyncNotifier<List<BrokerProfile>> {
  @override
  Future<List<BrokerProfile>> build() {
    return ref.read(brokerProfileRepositoryProvider).getAll();
  }

  /// Saves a profile and refreshes the list.
  Future<BrokerProfile> saveProfile(BrokerProfile profile) async {
    final repository = ref.read(brokerProfileRepositoryProvider);
    final gate = ref.read(brokerProfileMutationGateProvider);
    final saved = profile.incarnationId == null
        ? await gate.runForMissing(
            profile.id,
            () => repository.save(profile),
          )
        : await gate.runForProfile(
            profile,
            (_) => repository.save(profile),
          );
    ref.invalidateSelf();
    return saved;
  }

  /// Deletes a profile and refreshes the list.
  Future<bool> deleteProfile(BrokerProfile profile) async {
    final deleted = await ref
        .read(brokerProfileMutationGateProvider)
        .runForProfile(
          profile,
          (_) => ref
              .read(brokerProfileRepositoryProvider)
              .delete(
                id: profile.id,
                incarnationId: profile.incarnationId,
              ),
        );
    ref.invalidateSelf();
    return deleted;
  }
}
