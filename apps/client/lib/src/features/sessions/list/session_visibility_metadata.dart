import 'package:broker_contract/broker_contract.dart';

/// A slow snapshot or delta cannot undo a newer accepted visibility intent.
/// Revisions are broker-local; callers fence their source before merging.
SessionInfo retainNewerSessionVisibility(
  SessionInfo incoming,
  SessionInfo? known,
) {
  var retained = incoming;
  if (known != null &&
      ((incoming.titlePending ?? false) || incoming.updatedAt == null)) {
    retained = SessionInfo.fromJson({
      ...incoming.toJson(),
      'title': (incoming.titlePending ?? false) ? known.title : incoming.title,
      'updatedAt': incoming.updatedAt ?? known.updatedAt,
    });
  }
  if (known == null ||
      retained.appVisibilityRevision == null ||
      (retained.appVisibilityRevision ?? 0) >=
          (known.appVisibilityRevision ?? 0)) {
    return retained;
  }
  return SessionInfo.fromJson({
    ...retained.toJson(),
    'appHidden': known.appHidden,
    'appHiddenByAncestor': known.appHiddenByAncestor,
    'appVisibilityRevision': known.appVisibilityRevision,
  });
}
