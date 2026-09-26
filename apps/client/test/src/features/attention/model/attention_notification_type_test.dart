import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/l10n/app_localizations_en.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('shared cases with the broker', () {
    // The broker tests the same file, so its served type and slot and this
    // client's own mapping (used with an older broker) cannot drift apart.
    final cases =
        (jsonDecode(
                  File(
                    '../../contracts/fixtures/attention-notification-types.json',
                  ).readAsStringSync(),
                )
                as Map<String, dynamic>)['cases']
            as List<dynamic>;

    test("every case maps to the broker's type and slot", () {
      expect(cases.length, greaterThanOrEqualTo(15));
      for (final item in cases.cast<Map<String, dynamic>>()) {
        final event = AttentionEventView.fromJson({
          'cursor': 1,
          'revision': 1,
          'presentationRevision': 1,
          'state': 'active',
          'createdAt': 1,
          'updatedAt': 1,
          'title': 'Title',
          ...item['event'] as Map<String, dynamic>,
        });
        final type = attentionNotificationTypeOf(event);
        final name = item['name'] as String;
        expect(type?.id, item['notificationType'], reason: '$name: type');
        expect(
          type == null ? null : attentionNotificationCollapseKey(event, type),
          item['collapseKey'],
          reason: '$name: collapse key',
        );
      }
    });
  });

  group('a broker that names the type and slot', () {
    AttentionEventView named(Map<String, Object?> fields) =>
        AttentionEventView.fromJson({
          ..._event(
            kind: 'run-finished',
            tool: 'claude',
            sessionId: 's1',
          ).toJson(),
          ...fields,
        });

    test('its type wins over the kind', () {
      expect(
        attentionNotificationTypeOf(named({'notificationType': 'turn_failed'})),
        AttentionNotificationType.turnFailed,
      );
    });

    test('a type id this client does not know is never presented', () {
      expect(
        attentionNotificationTypeOf(
          named({'notificationType': 'type_from_the_future'}),
        ),
        isNull,
      );
    });

    test('its slot wins over the local one', () {
      final event = named({
        'notificationType': 'turn_finished',
        'collapseKey': 'broker-slot',
      });
      expect(
        attentionNotificationCollapseKey(
          event,
          AttentionNotificationType.turnFinished,
        ),
        'broker-slot',
      );
    });
  });

  group('attentionNotificationTypeOf', () {
    test('maps every presented kind to its type', () {
      const expected = {
        'permission-required': AttentionNotificationType.permissionRequest,
        'question-required': AttentionNotificationType.question,
        'run-finished': AttentionNotificationType.turnFinished,
        'goal-finished': AttentionNotificationType.goalFinished,
        'run-failed': AttentionNotificationType.turnFailed,
        'scheduled-send-failed': AttentionNotificationType.scheduledSendFailed,
        'security-alert': AttentionNotificationType.securityAlert,
        'device-paired': AttentionNotificationType.devicePaired,
        'runtime-update-ready': AttentionNotificationType.runtimeUpdate,
        'usage-threshold': AttentionNotificationType.usageQuota,
      };
      for (final MapEntry(key: kind, value: type) in expected.entries) {
        expect(
          attentionNotificationTypeOf(_event(kind: kind)),
          type,
          reason: kind,
        );
      }
    });

    test('never notifies for quiet or unknown kinds', () {
      for (final kind in [
        'sync-degraded',
        'scheduled-send',
        'kind-from-the-future',
      ]) {
        expect(attentionNotificationTypeOf(_event(kind: kind)), isNull);
      }
    });

    test('server health notifies only when it needs the user', () {
      for (final severity in ['action-required', 'critical']) {
        expect(
          attentionNotificationTypeOf(
            _event(kind: 'broker-health', severity: severity),
          ),
          AttentionNotificationType.serverProblem,
        );
      }
      for (final severity in ['informational', 'maintenance']) {
        expect(
          attentionNotificationTypeOf(
            _event(kind: 'broker-health', severity: severity),
          ),
          isNull,
        );
      }
    });
  });

  group('AttentionNotificationType', () {
    test('ids, channel ids, and group ids are unique and stable', () {
      final ids = AttentionNotificationType.values.map((type) => type.id);
      final channels = AttentionNotificationType.values.map(
        (type) => type.channelId,
      );
      expect(ids.toSet(), hasLength(AttentionNotificationType.values.length));
      expect(
        channels.toSet(),
        hasLength(AttentionNotificationType.values.length),
      );
      expect(
        AttentionNotificationType.permissionRequest.channelId,
        'cosy.v2.permission_request',
      );
      expect(
        AttentionNotificationFamily.server.channelGroupId,
        'cosy.v2.server',
      );
      // The new channels never reuse an old id, whose importance Android
      // froze when it was created.
      expect(
        channels.toSet().intersection(legacyAttentionNotificationChannelIds),
        isEmpty,
      );
    });

    test(
      'runtime updates and usage quota are the only types off by default',
      () {
        expect(
          AttentionNotificationType.values
              .where((type) => !type.defaultEnabled)
              .toSet(),
          {
            AttentionNotificationType.runtimeUpdate,
            AttentionNotificationType.usageQuota,
          },
        );
      },
    );

    test('requests and session outcomes are disjoint', () {
      for (final type in AttentionNotificationType.values) {
        expect(type.isRequest && type.isSessionOutcome, isFalse);
      }
      expect(
        AttentionNotificationType.values.where((type) => type.isRequest),
        [
          AttentionNotificationType.permissionRequest,
          AttentionNotificationType.question,
        ],
      );
    });
  });

  group('collapse and thread keys', () {
    test('every turn outcome of one session shares one slot', () {
      final finished = _event(
        kind: 'run-finished',
        id: 'a',
        tool: 'codex',
        sessionId: 's1',
      );
      final failed = _event(
        kind: 'run-failed',
        id: 'b',
        tool: 'codex',
        sessionId: 's1',
      );
      final goal = _event(
        kind: 'goal-finished',
        id: 'c',
        tool: 'codex',
        sessionId: 's1',
      );
      final otherSession = _event(
        kind: 'run-finished',
        id: 'd',
        tool: 'codex',
        sessionId: 's2',
      );

      String key(AttentionEventView event) => attentionNotificationCollapseKey(
        event,
        attentionNotificationTypeOf(event)!,
      );

      expect(key(finished), 'session-outcome:codex:s1');
      expect(key(failed), key(finished));
      expect(key(goal), key(finished));
      expect(key(otherSession), isNot(key(finished)));
      expect(attentionNotificationThreadKey(failed), 'codex:s1');
    });

    test('a request collapses on its dedupe key, never on its session', () {
      final first = _event(
        kind: 'permission-required',
        id: 'r1',
        dedupeKey: 'permission-required:codex:s1:req-1',
        tool: 'codex',
        sessionId: 's1',
      );
      final second = _event(
        kind: 'permission-required',
        id: 'r2',
        dedupeKey: 'permission-required:codex:s1:req-2',
        tool: 'codex',
        sessionId: 's1',
      );

      final firstKey = attentionNotificationCollapseKey(
        first,
        AttentionNotificationType.permissionRequest,
      );

      expect(firstKey, 'permission-required:codex:s1:req-1');
      expect(
        attentionNotificationCollapseKey(
          second,
          AttentionNotificationType.permissionRequest,
        ),
        isNot(firstKey),
      );
      // Both still group under their session.
      expect(attentionNotificationThreadKey(second), 'codex:s1');
    });

    test('an event with no session or dedupe key has its own slot', () {
      final event = _event(kind: 'device-paired', id: 'paired', dedupeKey: '');

      expect(
        attentionNotificationCollapseKey(
          event,
          AttentionNotificationType.devicePaired,
        ),
        'event:paired',
      );
      expect(attentionNotificationThreadKey(event), isNull);
    });
  });

  group('truncateAttentionNotificationText', () {
    test('keeps short text and collapses whitespace', () {
      expect(
        truncateAttentionNotificationText('  Fix   the\nlogin bug '),
        'Fix the login bug',
      );
    });

    test('cuts to the limit with an ellipsis', () {
      final text = 'a' * 60;

      final cut = truncateAttentionNotificationText(text);

      expect(cut.characters, hasLength(attentionNotificationBodyMaxCharacters));
      expect(cut, endsWith('…'));
    });

    test('never splits a CJK character or an emoji cluster', () {
      final cjk = '修复登录错误' * 10;
      final emoji = '👩‍💻' * 60;

      final cutCjk = truncateAttentionNotificationText(cjk, max: 5);
      final cutEmoji = truncateAttentionNotificationText(emoji, max: 5);

      expect(cutCjk, '修复登录…');
      expect(cutEmoji, '${'👩‍💻' * 4}…');
      expect(cutEmoji.characters, hasLength(5));
    });

    test('does not leave a space before the ellipsis', () {
      expect(
        truncateAttentionNotificationText('abcd efgh', max: 6),
        'abcd…',
      );
    });
  });

  group('localized channels', () {
    final AppLocalizations l10n = AppLocalizationsEn();

    test('every type has a distinct title, name, and description', () {
      final titles = <String>{};
      final names = <String>{};
      for (final type in AttentionNotificationType.values) {
        titles.add(attentionNotificationTitle(type, l10n));
        names.add(attentionNotificationTypeName(type, l10n));
        expect(
          attentionNotificationTypeDescription(type, l10n),
          isNotEmpty,
          reason: type.id,
        );
      }
      expect(titles, hasLength(AttentionNotificationType.values.length));
      expect(names, hasLength(AttentionNotificationType.values.length));
    });

    test('a channel carries its type defaults and family group', () {
      final channel = attentionNotificationChannel(
        AttentionNotificationType.usageQuota,
        l10n,
      );
      final groups = attentionNotificationChannelGroups(l10n);

      expect(channel.id, AttentionNotificationType.usageQuota.channelId);
      expect(channel.groupId, 'cosy.v2.server');
      expect(channel.defaultEnabled, isFalse);
      expect(groups.map((group) => group.id), [
        'cosy.v2.sessions',
        'cosy.v2.security',
        'cosy.v2.server',
      ]);
      expect(groups.map((group) => group.name), [
        'Sessions',
        'Security',
        'Server',
      ]);
    });
  });
}

AttentionEventView _event({
  required String kind,
  String id = 'event',
  String severity = 'informational',
  String? dedupeKey,
  String? tool,
  String? sessionId,
}) => AttentionEventView.fromJson({
  'id': id,
  'cursor': 1,
  'revision': 1,
  'presentationRevision': 1,
  'kind': kind,
  'state': 'active',
  'severity': severity,
  'dedupeKey': dedupeKey ?? '$kind:$id',
  'createdAt': 1,
  'updatedAt': 1,
  'title': 'Title',
  'sessionId': ?sessionId,
  'action': tool != null && sessionId != null
      ? {'kind': 'open-session', 'tool': tool, 'sessionId': sessionId}
      : {'kind': 'open-attention-inbox'},
});
