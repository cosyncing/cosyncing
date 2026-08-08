// Explicit allowlist entries stay split by path and copy for reviewability.
// ignore_for_file: lines_longer_than_80_chars, no_adjacent_strings_in_list

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('English and Chinese ARBs have message parity and final naming', () {
    expect(_duplicateMessageKeys('lib/l10n/app_en.arb'), isEmpty);
    expect(_duplicateMessageKeys('lib/l10n/app_zh.arb'), isEmpty);
    final english = _messages('lib/l10n/app_en.arb');
    final chinese = _messages('lib/l10n/app_zh.arb');

    expect(chinese.keys.toSet(), english.keys.toSet());
    expect(english['notificationsTitle'], 'Notifications');
    expect(chinese['notificationsTitle'], '通知');
    expect(english['attentionPageTitle'], 'Notifications');
    expect(chinese['attentionPageTitle'], '通知');
    expect(english['shortcutGoToAttention'], 'Go to Notifications');
    expect(chinese['shortcutGoToAttention'], '前往通知');
    expect(english, isNot(contains('settingsGroupDisplay')));
    expect(english, isNot(contains('settingsGroupBrokerAndDevice')));
  });

  test('shortcut copy and router bindings use the same 1 through 5 order', () {
    final router = File(
      'lib/src/app/router/router.dart',
    ).readAsStringSync();
    final shortcuts = File(
      'lib/src/features/settings/view/keyboard_shortcuts_page.dart',
    ).readAsStringSync();

    _expectInOrder(router, const [
      '_AppRouteLabel.sessions',
      '_AppRouteLabel.notifications',
      '_AppRouteLabel.connection',
      '_AppRouteLabel.settings',
      '_AppRouteLabel.transfers',
    ]);
    _expectInOrder(shortcuts, const [
      'shortcutGoToSessions',
      'shortcutGoToAttention',
      'shortcutGoToConnection',
      'shortcutGoToSettings',
      'shortcutGoToTransfers',
    ]);
  });

  test(
    'copy scanner catches casing, interpolation, and stored display copy',
    () {
      const source = r'''
Text('Permission')
Text('Terminal output ($count)')
final permissionSheetTitle = 'Permission settings';
''';

      expect(_widgetLiteral.allMatches(source), hasLength(2));
      expect(_storedDisplayLiteral.allMatches(source), hasLength(1));
    },
  );

  test('reachable production widgets contain no unreviewed literal copy', () {
    final findings = <String>{};
    final sourceRoot = Directory('lib/src');
    for (final entity in sourceRoot.listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      if (entity.path.toLowerCase().contains('debug')) continue;
      final source = entity.readAsStringSync();
      for (final match in _widgetLiteral.allMatches(source)) {
        final text = (match.group(2) ?? match.group(4) ?? '').trim();
        if (_reviewedLiteral(entity.path, text)) continue;
        final line =
            '\n'.allMatches(source.substring(0, match.start)).length + 1;
        findings.add('${entity.path}:$line: $text');
      }
      if (!entity.path.contains('/view/')) {
        for (final match in _storedDisplayLiteral.allMatches(source)) {
          final text = match.group(2)!.trim();
          if (_reviewedLiteral(entity.path, text)) continue;
          final line =
              '\n'.allMatches(source.substring(0, match.start)).length + 1;
          findings.add(
            '${entity.path}:$line: display string stored outside a widget: '
            '$text',
          );
        }
        for (final match in RegExp(
          r'String\s+get\s+(?:label|message|title|subtitle|description)\s*'
          r'''=>\s*(?:switch|['"])''',
        ).allMatches(source)) {
          final line =
              '\n'.allMatches(source.substring(0, match.start)).length + 1;
          findings.add(
            '${entity.path}:$line: localized display getter in model/state',
          );
        }
      }
    }

    final ordered = findings.toList()..sort();
    expect(ordered, isEmpty, reason: ordered.join('\n'));
  });
}

final _widgetLiteral = RegExp(
  r'''(?:Text|SelectableText)\(\s*(?:const\s+)?(['"])(.*?)\1'''
  r'''|(?:tooltip|hintText|labelText|semanticLabel):\s*(['"])(.*?)\3''',
  dotAll: true,
);

final _storedDisplayLiteral = RegExp(
  r'''(?:String\s+)?(?:final|const|var)\s+'''
  r'''\w*(?:Label|Title|Subtitle|Description|Tooltip|Heading|EmptyState|'''
  r'''NoticeText|ErrorText)\w*\s*=\s*(?:const\s+)?(['"])(.*?)\1''',
  dotAll: true,
);

List<String> _duplicateMessageKeys(String path) {
  final keys = RegExp(
    r'^  "([^"@][^"]*)"\s*:',
    multiLine: true,
  ).allMatches(File(path).readAsStringSync()).map((match) => match.group(1)!);
  final seen = <String>{};
  final duplicates = <String>{};
  for (final key in keys) {
    if (!seen.add(key)) duplicates.add(key);
  }
  return duplicates.toList()..sort();
}

Map<String, Object?> _messages(String path) {
  final raw = jsonDecode(File(path).readAsStringSync()) as Map<String, Object?>;
  return Map<String, Object?>.fromEntries(
    raw.entries.where((entry) => !entry.key.startsWith('@')),
  );
}

void _expectInOrder(String source, List<String> needles) {
  var position = -1;
  for (final needle in needles) {
    final next = source.indexOf(needle, position + 1);
    expect(next, greaterThan(position), reason: '$needle is out of order');
    position = next;
  }
}

const _reviewedLiterals = <String>{
  '',
  r'$label:',
  r'\u200b',
  '·',
  'diff',
  'Workspace',
  'Europe/London',
};

bool _reviewedLiteral(String path, String text) {
  final normalized = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (_reviewedLiterals.contains(normalized)) return true;
  return _reviewedLiteralByLocation.contains('$path::$normalized');
}

// Non-product literals must be justified one by one. Do not replace this with
// casing, interpolation, path, or punctuation heuristics: those broad
// exemptions are exactly how reachable English escaped the S2 audit.
const _reviewedLiteralByLocation = <String>{
  // URL example: executable syntax, not natural-language copy.
  'lib/src/features/connection/view/connection_page.dart::'
      'http://127.0.0.1:7734',

  // Developer-only Debug surface. This class lives in the Files/Terminal part
  // file, so path-based Debug exclusion cannot identify it.
  'lib/src/features/sessions/view/session_detail_files_terminal.dart::'
      'Session identity',
  'lib/src/features/sessions/view/session_detail_files_terminal.dart::'
      r'${state.tool} / ${state.sessionId}',
  'lib/src/features/sessions/view/session_detail_files_terminal.dart::'
      'Inline schedule freshness',

  // Pure dynamic data/technical notation. The words around these values are
  // already supplied by AppLocalizations.
  'lib/src/features/sessions/renderers/tool_message_cards.dart::'
      r'+${additions ?? 0} −${deletions ?? 0}',
  'lib/src/features/sessions/renderers/tool_message_cards.dart::'
      r'${widget.detail.label}: $visibleText',
  'lib/src/features/sessions/view/cached_roster_pane.dart::'
      r'${group.rootCount}',
  'lib/src/features/sessions/view/new_session_sheet.dart::'
      r'$projectContextLabel · ${widget.initialDirectory}',
  'lib/src/features/sessions/view/session_detail_chrome.dart::'
      r'$label: $value',
  'lib/src/features/sessions/view/session_detail_live_cards.dart::'
      r'+${widget.additionalCount}',
  'lib/src/features/sessions/view/session_detail_live_cards.dart::'
      r'${widget.item.done ?? 0}/${widget.item.total}',
  'lib/src/features/sessions/view/session_detail_slash_palette.dart::'
      r'/$name',
  'lib/src/features/sessions/view/session_detail_transfers_artifacts.dart::'
      r'${_sessionDetailTransferDirectionLabel( l10n, transfer.direction, )}: ${transfer.fileName}',
  'lib/src/features/sessions/view/session_detail_transfers_artifacts.dart::'
      r'${l10n.fileNameLabel}: ${transfer.fileName}',
  'lib/src/features/sessions/view/session_detail_transfers_artifacts.dart::'
      r'${l10n.pathLabel}: $localPath',
  'lib/src/features/sessions/view/session_detail_transfers_artifacts.dart::'
      r'${l10n.fileNameLabel}: ${preview.displayName}',
  'lib/src/features/sessions/view/session_detail_transfers_artifacts.dart::'
      r'${l10n.pathLabel}: ${preview.path}',
  'lib/src/features/sessions/view/session_detail_transfers_artifacts.dart::'
      r'${l10n.mimeTypeLabel}: ${preview.mimeType}',
  'lib/src/features/sessions/view/session_detail_transfers_artifacts.dart::'
      r'${l10n.artifactKeyLabel}: $artifactKey',
  'lib/src/features/sessions/view/session_detail_transfers_artifacts.dart::'
      r'${l10n.hashLabel}: $contentHash',
  'lib/src/features/sessions/view/session_detail_transfers_artifacts.dart::'
      r'${l10n.sizeLabel}: ${l10n.bytesCount(size)}',
  'lib/src/features/sessions/view/session_detail_view_menu.dart::'
      r'$count',
  'lib/src/features/sessions/view/session_list_pane.dart::'
      r'${group.rootCount}',
  'lib/src/features/sessions/view/session_list_pane.dart::'
      r'$count',
  'lib/src/features/sessions/view/session_list_pane.dart::'
      r'$childCount',
  'lib/src/features/sessions/view/sessions_page.dart::'
      r'${machineState.machines.length}',
  'lib/src/features/sessions/view/sessions_page.dart::'
      r'${session.tool} ·',
  'lib/src/features/transfers/view/transfer_manager_page.dart::'
      r'${l10n.fileNameLabel}: ${transfer.fileName}',
  'lib/src/features/transfers/view/transfer_manager_page.dart::'
      r'${l10n.pathLabel}: $localPath',
  'lib/src/features/transfers/view/transfer_manager_page.dart::'
      r'${_transferFilterLabel(l10n, filter)}',
  'lib/src/features/transfers/view/transfer_manager_page.dart::'
      r'${sessionKey.tool} / ${sessionKey.sessionId}',
  'lib/src/features/transfers/view/transfer_manager_page.dart::'
      r'${_transferDirectionLabel(l10n, transfer.direction)}:',
};
