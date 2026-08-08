import 'package:cosyncing_client/src/features/sessions/data/session_draft_keepalive_store.dart';

/// Native platforms keep keepalive records in memory only (DR1b).
///
/// There is no document to destroy here: a native page leaves the tree through
/// `dispose()`, which the existing lifecycle flush already covers, and a
/// process that is killed outright would not have run a synchronous browser
/// write either. Keeping the same record protocol on this backing means the
/// encoding, bounds and eviction run on every platform; only survival across a
/// restart is web-specific.
SessionDraftKeepaliveStore openSessionDraftKeepaliveStore() =>
    MemorySessionDraftKeepaliveStore();

/// No browser teardown events exist off the web.
void installSessionDraftKeepaliveTerminalHook(void Function() retry) {}
