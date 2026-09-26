import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

const _settingKeyPrefix = 'notification_type:';

/// This device's choices for one notification type.
@immutable
final class AttentionNotificationTypeSetting {
  /// Creates a setting.
  const AttentionNotificationTypeSetting({
    required this.enabled,
    required this.sound,
    required this.showSessionTitle,
  });

  /// The type's out-of-the-box setting.
  AttentionNotificationTypeSetting.defaultsFor(AttentionNotificationType type)
    : enabled = type.defaultEnabled,
      sound = type.defaultSound,
      showSessionTitle = true;

  /// Whether the app posts this type. Android ignores it in favour of the
  /// channel's own switch, which the user owns in system settings.
  final bool enabled;

  /// Whether the app asks for a sound. Android uses the channel's sound.
  final bool sound;

  /// Whether the body carries the truncated session (or event) title. Off
  /// leaves the event type only — on every platform, including Android.
  final bool showSessionTitle;

  /// Copy with changed fields.
  AttentionNotificationTypeSetting copyWith({
    bool? enabled,
    bool? sound,
    bool? showSessionTitle,
  }) => AttentionNotificationTypeSetting(
    enabled: enabled ?? this.enabled,
    sound: sound ?? this.sound,
    showSessionTitle: showSessionTitle ?? this.showSessionTitle,
  );

  @override
  bool operator ==(Object other) =>
      other is AttentionNotificationTypeSetting &&
      other.enabled == enabled &&
      other.sound == sound &&
      other.showSessionTitle == showSessionTitle;

  @override
  int get hashCode => Object.hash(enabled, sound, showSessionTitle);
}

/// Every type's setting on this device.
final class AttentionNotificationTypeSettings {
  /// Creates settings from explicit per-type values; missing types default.
  AttentionNotificationTypeSettings(
    Map<AttentionNotificationType, AttentionNotificationTypeSetting> values,
  ) : _values = Map.unmodifiable(values);

  /// Out-of-the-box settings for every type.
  AttentionNotificationTypeSettings.defaults() : _values = const {};

  final Map<AttentionNotificationType, AttentionNotificationTypeSetting>
  _values;

  /// Setting for [type].
  AttentionNotificationTypeSetting operator [](
    AttentionNotificationType type,
  ) => _values[type] ?? AttentionNotificationTypeSetting.defaultsFor(type);

  /// Copy with [type] replaced.
  AttentionNotificationTypeSettings withSetting(
    AttentionNotificationType type,
    AttentionNotificationTypeSetting setting,
  ) => AttentionNotificationTypeSettings({..._values, type: setting});
}

/// Durable per-type notification choices.
abstract interface class AttentionNotificationTypeSettingsStore {
  /// Loads every type's setting.
  Future<AttentionNotificationTypeSettings> load();

  /// Persists one type's setting.
  Future<void> save(
    AttentionNotificationType type,
    AttentionNotificationTypeSetting setting,
  );
}

/// Drift-backed per-type settings, one app-settings row per type.
final class DriftAttentionNotificationTypeSettingsStore
    implements AttentionNotificationTypeSettingsStore {
  /// Creates the store.
  DriftAttentionNotificationTypeSettingsStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<AttentionNotificationTypeSettings> load() async {
    final rows = await (database.select(
      database.appSettingRows,
    )..where((table) => table.key.like('$_settingKeyPrefix%'))).get();
    final byId = {
      for (final type in AttentionNotificationType.values) type.id: type,
    };
    final values =
        <AttentionNotificationType, AttentionNotificationTypeSetting>{};
    for (final row in rows) {
      final type = byId[row.key.substring(_settingKeyPrefix.length)];
      if (type == null) continue;
      values[type] = _decode(row.value, type);
    }
    return AttentionNotificationTypeSettings(values);
  }

  @override
  Future<void> save(
    AttentionNotificationType type,
    AttentionNotificationTypeSetting setting,
  ) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: '$_settingKeyPrefix${type.id}',
            value: _encode(setting),
            updatedAt: DateTime.now(),
          ),
        );
  }

  // `enabled,sound,showTitle` as 0/1 flags: small, ordered, and forward
  // compatible (a missing trailing flag takes the type default).
  static String _encode(AttentionNotificationTypeSetting setting) => [
    setting.enabled,
    setting.sound,
    setting.showSessionTitle,
  ].map((flag) => flag ? '1' : '0').join(',');

  static AttentionNotificationTypeSetting _decode(
    String value,
    AttentionNotificationType type,
  ) {
    final defaults = AttentionNotificationTypeSetting.defaultsFor(type);
    final flags = value.split(',');
    bool flag(int index, {required bool fallback}) =>
        index < flags.length ? flags[index].trim() == '1' : fallback;
    return AttentionNotificationTypeSetting(
      enabled: flag(0, fallback: defaults.enabled),
      sound: flag(1, fallback: defaults.sound),
      showSessionTitle: flag(2, fallback: defaults.showSessionTitle),
    );
  }
}

/// Provider for the durable per-type settings.
final attentionNotificationTypeSettingsStoreProvider =
    Provider<AttentionNotificationTypeSettingsStore>(
      (ref) => DriftAttentionNotificationTypeSettingsStore(
        ref.watch(appDatabaseProvider),
      ),
    );
