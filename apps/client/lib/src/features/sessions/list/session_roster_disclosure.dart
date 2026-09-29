import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Which projects and child subtrees the user opened in the roster.
///
/// Held outside the roster pane, because the pane does not live as long as
/// the workspace everywhere. On a narrow screen the sidebar is a drawer, and a
/// closed drawer is disposed: kept in the pane's own state, every project
/// collapsed again whenever a session was opened from the drawer.
///
/// Only the saved choices live here. What a search reveals, and what the user
/// closes during that reveal, stays with the pane and ends with the search.
final class SessionRosterDisclosure {
  /// Project keys the user has explicitly expanded. Projects default to
  /// collapsed, so a key that is absent is closed.
  final Set<String> expandedProjectKeys = <String>{};

  /// Per-parent child-subtree choices. Absent means "follow the global
  /// background-session preference".
  final Map<String, SessionChildExpansion> childExpansion = {};
}

/// The roster disclosure for one roster source, kept for the life of the app.
///
/// Keyed by source so two servers' project keys never open each other's
/// groups. Not persisted: a cold start still opens with every project
/// collapsed.
final ProviderFamily<SessionRosterDisclosure, String>
sessionRosterDisclosureProvider =
    Provider.family<SessionRosterDisclosure, String>(
      (ref, sourceKey) => SessionRosterDisclosure(),
    );
