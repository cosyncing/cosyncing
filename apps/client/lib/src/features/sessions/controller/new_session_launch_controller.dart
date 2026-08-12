import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/created_session_attach_intents.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_controller.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_drive_intent_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The values accepted by an immediate New Session submission.
@immutable
final class NewSessionLaunchRequest {
  /// Creates an immediate launch request.
  const NewSessionLaunchRequest({
    required this.tool,
    required this.directory,
    required this.title,
    this.model,
    this.modelSource,
  });

  /// Adapter id selected in the New Session sheet.
  final String tool;

  /// Requested working directory. Blank means the broker default.
  final String directory;

  /// Optional session title.
  final String title;

  /// Exact optional model selection.
  final SessionCurrentModel? model;

  /// Exact source that supplied [model].
  final RosterSource? modelSource;
}

/// Creates immediate sessions after the sheet has handed control to the page.
final newSessionLaunchServiceProvider = Provider<NewSessionLaunchService>(
  NewSessionLaunchService.new,
);

/// Keeps a created session's connection resident until Session Detail mounts.
///
/// The release is idempotent so a route replacement and an outer lifecycle
/// cleanup can safely converge on the same handoff.
final class NewSessionConnectionHandoff {
  /// Creates one handoff around its release boundary.
  NewSessionConnectionHandoff(VoidCallback release) : _release = release;

  VoidCallback? _release;

  /// Releases the launch-owned controller lease exactly once.
  void release() {
    final release = _release;
    _release = null;
    release?.call();
  }
}

/// Establishes a created session's live connection before navigation finishes.
typedef NewSessionConnectionPreparer =
    Future<NewSessionConnectionHandoff> Function(
      ProviderContainer container,
      SessionInfo session,
    );

/// Injectable production connection boundary for the launch handoff.
final newSessionConnectionPreparerProvider =
    Provider<NewSessionConnectionPreparer>(
      (ref) => prepareCreatedSessionConnection,
    );

/// Establishes the created session's one-shot Drive attach before the launch
/// handoff leaves its Connecting phase.
///
/// Session Detail controllers are auto-disposed. Compact navigation does not
/// mount the destination until after this future completes, while an expanded
/// workspace may mount it behind the launch overlay. The temporary listener
/// makes both layouts use the same controller and keeps the create intent
/// alive until its reason-tagged Resume request has crossed the socket. The
/// returned handoff keeps it alive across the following navigation frame too;
/// otherwise compact navigation disposes this controller before Session Detail
/// can watch it and the broker immediately relinquishes Drive.
Future<NewSessionConnectionHandoff> prepareCreatedSessionConnection(
  ProviderContainer container,
  SessionInfo session,
) async {
  final provider = sessionDetailControllerProvider(
    SessionDetailKey(tool: session.tool, sessionId: session.id),
  );
  final lease = container.listen(
    provider,
    (previous, next) {},
    fireImmediately: true,
  );
  try {
    await container.read(provider.notifier).attach();
    return NewSessionConnectionHandoff(lease.close);
  } on Object {
    lease.close();
    rethrow;
  }
}

/// Broker-backed immediate-session creation shared by the controller and N1.
final class NewSessionLaunchService {
  /// Creates the service.
  NewSessionLaunchService(this._ref);

  final Ref _ref;

  /// Creates one session and preserves the broker's one-shot Resume intent.
  ///
  /// Errors remain structured here. The page classifies and localizes them;
  /// raw diagnostics stay out of its primary reading path.
  Future<SessionInfo> create(NewSessionLaunchRequest request) async {
    // The client is OPERATION-OWNED and built from the profile captured here,
    // so the broker that hosts the session and the profile id used for the
    // profile-qualified writes below agree by construction. The shared
    // auto-disposed client provider is unsafe across this flow's awaits: a
    // profile switch can close its client mid-operation or hand back the new
    // profile's client under the captured id.
    final profile = _ref.read(activeBrokerProfileProvider);
    if (profile == null) {
      throw StateError('Connect to a server before creating a session.');
    }
    // The full (profile, endpoint) source, not the id alone: the intent and
    // provenance rows written below authorize a Drive attach, and an endpoint
    // edit between create and open must leave them unreadable rather than
    // hand the new machine the old one's authority.
    final source = RosterSource.ofProfile(profile);
    if (request.model != null && request.modelSource != source) {
      throw StateError(
        'The selected model belongs to a different server connection. '
        'Refresh the model list and choose again.',
      );
    }
    final client = await _ref.read(brokerClientFactoryProvider)(profile);
    try {
      final directory = request.directory.trim();
      final title = request.title.trim();
      final response = await client.createSession(
        request.tool,
        directory: directory.isEmpty ? null : directory,
        title: title.isEmpty ? null : title,
        model: request.model,
      );
      // Intents and provenance are recorded under the broker that OWNS the
      // created session — the captured source — never under whatever
      // profile is active at write time.
      if (response.attachMode == 'resume') {
        _ref
            .read(createdSessionAttachIntentsProvider)
            .rememberResume(
              source.storageKey,
              SessionDetailKey(
                tool: request.tool,
                sessionId: response.session.id,
              ),
            );
        // The durable app-created control preference is written BEFORE
        // navigation so it survives an app restart or a first attach that
        // never reaches Driving. It has no TTL; only an explicit Handoff,
        // Observe, Detach, or End clears it.
        try {
          await _ref
              .read(sessionDriveIntentStoreProvider)
              .rememberAppCreated(
                brokerProfileId: source.storageKey,
                tool: request.tool,
                sessionId: response.session.id,
              );
        } on Object {
          // Provenance storage is an optimization; creation already
          // succeeded and the in-memory one-shot intent still drives the
          // first attach.
        }
      }
      // Revalidate before the caller navigates: if the user switched brokers
      // mid-create, the session exists on the previous broker (with its
      // intents recorded above) and must not be opened against the newly
      // active one.
      if (RosterSource.of(_ref.read(activeBrokerProfileProvider)) != source) {
        throw StateError(
          'The active server changed while the session was being created. '
          'Switch back to the previous server to open it.',
        );
      }
      return response.session;
    } finally {
      client.close();
    }
  }
}
