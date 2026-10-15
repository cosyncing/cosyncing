// The composer's durable draft repository with fault hooks (F04).
//
// Wraps the REAL Drift repository over the scenario's database, so rows are
// really stored; a test can park a save (the page is torn down before it
// lands: a hard refresh), refuse saves, or fail loads. One class replaces the
// three private faulty draft repositories the legacy tests carried.
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_draft_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'cosyncing_app.dart';
import 'store_faults.dart';

/// [SessionDraftRepository] over the real store, with faults.
class FaultyDraftRepository implements ObservableSessionDraftRepository {
  /// Wraps [inner].
  FaultyDraftRepository(this.inner);

  /// The real repository.
  final DriftSessionDraftRepository inner;

  /// Fault on loads.
  final StoreFault loads = StoreFault();

  /// Fault on saves (hold parks them, fail refuses them).
  final StoreFault saves = StoreFault();

  /// Fault on deletes.
  final StoreFault deletes = StoreFault();

  @override
  Future<SessionLocalDraft?> load({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) async {
    await loads.enter('draft load');
    return inner.load(brokerProfileId: brokerProfileId, sessionKey: sessionKey);
  }

  @override
  Future<SessionLocalDraft?> save(SessionLocalDraft draft) async {
    await saves.enter('draft save');
    return inner.save(draft);
  }

  @override
  Future<bool> delete({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
    required int expectedMutationVersion,
  }) async {
    await deletes.enter('draft delete');
    return inner.delete(
      brokerProfileId: brokerProfileId,
      sessionKey: sessionKey,
      expectedMutationVersion: expectedMutationVersion,
    );
  }

  @override
  Future<void> deleteForProfile(String brokerProfileId) =>
      inner.deleteForProfile(brokerProfileId);

  @override
  Stream<SessionLocalDraft?> watch({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) => inner.watch(brokerProfileId: brokerProfileId, sessionKey: sessionKey);

  /// The provider override that hands this repository to the App.
  ///
  /// The wrapped Drift repository shares the App's keepalive record, like
  /// production does.
  static Override overrideFor(
    FeatureStorage storage, {
    void Function(FaultyDraftRepository repository)? onCreate,
  }) => sessionDraftRepositoryProvider.overrideWith((ref) {
    final repository = FaultyDraftRepository(
      DriftSessionDraftRepository(
        storage.database,
        keepalive: ref.watch(sessionDraftKeepaliveProvider),
      ),
    );
    onCreate?.call(repository);
    return repository;
  });
}
