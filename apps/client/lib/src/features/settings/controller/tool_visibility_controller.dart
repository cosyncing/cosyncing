import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/features/settings/data/tool_visibility_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

export 'package:cosyncing_client/src/features/settings/data/tool_visibility_store.dart'
    show ToolVisibilityPreferences;

/// Inheritance is distinct from an explicit choice equal to the default.
enum ToolVisibility {
  /// Follow the device preference.
  inherit,

  /// Explicitly show routine tools for this session.
  show,

  /// Explicitly hide routine tools for this session.
  hide,
}

/// Client-wide durable visibility preferences.
final toolVisibilityControllerProvider =
    AsyncNotifierProvider<ToolVisibilityController, ToolVisibilityPreferences>(
      ToolVisibilityController.new,
    );

/// A reset's captured choices and ordering point for safe Undo.
class ToolVisibilityReset {
  /// Captures only the overrides removed by this reset.
  const ToolVisibilityReset(this.overrides, this.revision);

  /// Removed session choices.
  final Map<String, bool> overrides;

  /// Newer choices, including Inherit, must win over this snapshot.
  final int revision;
}

/// One serialized preference record, independent of transcript/cache lifetime.
class ToolVisibilityController
    extends AsyncNotifier<ToolVisibilityPreferences> {
  Future<void> _tail = Future.value();
  int _revision = 0;
  final Map<String, int> _choiceRevisions = {};
  @override
  Future<ToolVisibilityPreferences> build() async {
    final store = ref.read(toolVisibilityStoreProvider);
    final saved = await store.read();
    if (saved != null) return saved;
    final legacy = await ref
        .read(sessionDisplayPreferencesStoreProvider)
        .getToolDisplayMode();
    final migrated = ToolVisibilityPreferences(
      hideByDefault: legacy == 'final-messages-only',
      finalAssistantOnly: legacy == 'final-messages-only',
    );
    try {
      await store.write(migrated);
      return migrated;
    } on Object {
      return migrated.copyWith(saveFailed: true);
    }
  }

  Future<void> _change(
    ToolVisibilityPreferences Function(ToolVisibilityPreferences) change,
  ) {
    final work = _tail.then((_) async {
      final next = change(await future);
      state = AsyncData(next);
      final store = ref.read(toolVisibilityStoreProvider);
      try {
        await store.write(next);
      } on Object {
        state = AsyncData(next.copyWith(saveFailed: true));
      }
    });
    _tail = work.catchError((Object _) {});
    return work;
  }

  /// Updates the inherited visibility without replacing session choices.
  Future<void> setDefault({required bool hide}) =>
      _change((p) => p.copyWith(hideByDefault: hide));

  /// Changes assistant filtering independently of tools.
  Future<void> setFinalAssistantOnly({required bool value}) =>
      _change((p) => p.copyWith(finalAssistantOnly: value));

  /// Persists a choice, or removes it to restore inheritance.
  Future<void> setOverride(String key, ToolVisibility value) => _change((p) {
    _choiceRevisions[key] = ++_revision;
    final next = {...p.overrides}..remove(key);
    if (value != ToolVisibility.inherit) {
      next[key] = value == ToolVisibility.hide;
    }
    return p.copyWith(overrides: next);
  });

  /// Restores inheritance for all sessions on this device.
  Future<ToolVisibilityReset> resetOverrides() async {
    late ToolVisibilityReset snapshot;
    await _change((p) {
      snapshot = ToolVisibilityReset({...p.overrides}, ++_revision);
      for (final key in p.overrides.keys) {
        _choiceRevisions[key] = _revision;
      }
      return p.copyWith(overrides: {});
    });
    return snapshot;
  }

  /// Undoes reset while retaining newer explicit choices.
  Future<void> restoreOverrides(ToolVisibilityReset snapshot) => _change((p) {
    final next = {...p.overrides};
    final revision = ++_revision;
    for (final entry in snapshot.overrides.entries) {
      if ((_choiceRevisions[entry.key] ?? 0) <= snapshot.revision) {
        next[entry.key] = entry.value;
        _choiceRevisions[entry.key] = revision;
      }
    }
    return p.copyWith(overrides: next);
  });

  /// Retries persistence of the current intent.
  Future<void> retry() => _change((p) => p.copyWith());
}

/// Exact broker-source and session identity for durable overrides.
final ProviderFamily<String?, SessionDetailKey> toolVisibilityKeyProvider =
    Provider.family<String?, SessionDetailKey>((
      ref,
      session,
    ) {
      final source = RosterSource.of(
        ref.watch(activeBrokerProfileProvider),
      )?.storageKey;
      return source == null
          ? null
          : toolVisibilitySessionKey(source, session.tool, session.sessionId);
    });

/// Conservatively hide routine tools until the durable preference has loaded.
final ProviderFamily<bool, SessionDetailKey> hideSessionToolsProvider =
    Provider.family<bool, SessionDetailKey>((
      ref,
      session,
    ) {
      final prefs = ref.watch(toolVisibilityControllerProvider).valueOrNull;
      final key = ref.watch(toolVisibilityKeyProvider(session));
      return prefs == null || (prefs.overrides[key] ?? prefs.hideByDefault);
    });
