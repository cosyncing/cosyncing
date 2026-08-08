import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// One-shot attach intents returned by `POST /api/sessions/:tool`.
///
/// Opening an ordinary roster row remains Observe-first. A newly-created row
/// may instead carry the broker's explicit `attachMode: resume` instruction;
/// this registry bridges that response to the detail controller exactly once.
final createdSessionAttachIntentsProvider =
    Provider<CreatedSessionAttachIntents>((ref) {
      return CreatedSessionAttachIntents();
    });

/// In-memory, app-scope registry for newly-created session attach modes.
///
/// Intents are qualified by the broker SCOPE KEY (`RosterSource.storageKey`):
/// two brokers can host sessions with the same tool/session id — including
/// the SAME profile re-pointed at another machine — and a one-shot Drive
/// instruction issued by one broker must never leak into an attach against
/// another.
final class CreatedSessionAttachIntents {
  final Set<String> _resume = <String>{};

  static String _qualify(String brokerProfileId, SessionDetailKey key) =>
      '$brokerProfileId/${key.tool}/${key.sessionId}';

  /// Records that the next attach for [key] on [brokerProfileId] must
  /// request Drive.
  void rememberResume(String brokerProfileId, SessionDetailKey key) =>
      _resume.add(_qualify(brokerProfileId, key));

  /// Consumes a pending Drive attach for [key] on [brokerProfileId].
  bool takeResume(String brokerProfileId, SessionDetailKey key) =>
      _resume.remove(_qualify(brokerProfileId, key));

  /// Drops every pending intent the profile owns — at any endpoint.
  ///
  /// Deletion-time cleanup: this registry is in-memory but outlives the
  /// profile row within one app run, so a profile deleted and re-added with
  /// the same id (even the same endpoint) would otherwise consume a one-shot
  /// Drive instruction issued to the deleted profile. The scope key encodes
  /// `/`, so the first separator always ends the scope segment.
  void forgetProfile(String profileId) => _resume.removeWhere((entry) {
    final scopeEnd = entry.indexOf('/');
    if (scopeEnd <= 0) return false;
    return RosterSource.storageKeyBelongsToProfile(
      entry.substring(0, scopeEnd),
      profileId,
    );
  });
}
