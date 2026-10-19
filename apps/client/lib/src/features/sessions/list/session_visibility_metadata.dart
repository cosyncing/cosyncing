import 'package:broker_contract/broker_contract.dart';

/// A slow snapshot or delta cannot undo a newer accepted visibility intent.
/// Revisions are broker-local; callers fence their source before merging.
SessionInfo retainNewerSessionVisibility(
  SessionInfo incoming,
  SessionInfo? known,
) {
  if (known == null ||
      incoming.appVisibilityRevision == null ||
      (incoming.appVisibilityRevision ?? 0) >=
          (known.appVisibilityRevision ?? 0)) {
    return incoming;
  }
  return SessionInfo.fromJson({
    ...incoming.toJson(),
    'appHidden': known.appHidden,
    'appHiddenByAncestor': known.appHiddenByAncestor,
    'appVisibilityRevision': known.appVisibilityRevision,
  });
}
