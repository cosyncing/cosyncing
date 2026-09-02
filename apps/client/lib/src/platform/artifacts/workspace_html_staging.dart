import 'dart:convert';
import 'dart:io';

import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_html_policy.dart';
import 'package:path/path.dart' as path;

/// How long a staged copy is kept, matching the artifact preview's retention.
const Duration workspaceHtmlStagingRetention = Duration(hours: 24);

/// The marker directory staged workspace copies live under.
///
/// Deliberately a *sibling* of the artifact preview's marker rather than the
/// same tree. That tree's sweep deletes any HTML-named file under it on an
/// mtime pass, and its root check asserts an exact two-segment tail -- two
/// features sharing one tree is an avoidable race, not a saving.
const String workspaceHtmlStagingMarker = 'workspace_html_previews';

/// The root staged copies live under.
Directory workspaceHtmlStagingRoot({Directory? rootDirectory}) => Directory(
  path.join(
    (rootDirectory ?? Directory.systemTemp).path,
    'cosyncing_client',
    workspaceHtmlStagingMarker,
  ),
);

/// A deterministic, filesystem-safe stem for one workspace file's staged copy.
///
/// Seeded from the identity of the read rather than a random name, so
/// reopening the same file reuses one path instead of littering the temp
/// directory with a copy per click.
String workspaceHtmlStagingStem({
  required String sessionKey,
  required String workspacePath,
  required int size,
  required bool truncated,
}) {
  final seed = '$sessionKey $workspacePath $size $truncated';
  final encoded = base64Url
      .encode(utf8.encode(seed))
      .replaceAll('=', '')
      .replaceAll(RegExp('[^A-Za-z0-9_-]'), '_');
  final stem = 'workspace_$encoded';
  return stem.length <= 120 ? stem : stem.substring(0, 120);
}

/// Whether [directory] is exactly the staging root.
bool isWorkspaceHtmlStagingRoot(Directory directory) {
  final segments = path.split(path.normalize(directory.absolute.path));
  return segments.length >= 2 &&
      segments[segments.length - 1] == workspaceHtmlStagingMarker &&
      segments[segments.length - 2] == 'cosyncing_client';
}

/// Removes staged copies older than [retention].
///
/// Refuses to sweep anything that is not the known staging root, so a wrong
/// argument cannot turn this into a directory deleter. Failures are ignored by
/// design: a hand-off must not fail because yesterday's copy would not delete.
Future<void> sweepWorkspaceHtmlStaging({
  Directory? root,
  Directory? rootDirectory,
  DateTime? now,
  Duration retention = workspaceHtmlStagingRetention,
}) async {
  final target = root ?? workspaceHtmlStagingRoot(rootDirectory: rootDirectory);
  if (!isWorkspaceHtmlStagingRoot(target)) return;
  if (!target.existsSync()) return;
  final cutoff = (now ?? DateTime.now()).subtract(retention);
  for (final entry in target.listSync()) {
    try {
      if (entry.statSync().modified.isAfter(cutoff)) continue;
      if (entry is Directory) {
        entry.deleteSync(recursive: true);
      } else if (entry is File) {
        entry.deleteSync();
      }
    } on FileSystemException {
      // A copy that will not delete is not a reason to refuse the hand-off.
    }
  }
}

/// Writes [html] to a staged file and returns it, hardened.
///
/// The workspace path itself is never opened: it names a file on the
/// **broker's** machine, so against a remote broker it either does not exist
/// on this one or, worse, resolves to a different file with the same path. A
/// local copy is the only behaviour that is correct for both.
Future<File> stageWorkspaceHtmlFile({
  required String sessionKey,
  required String workspacePath,
  required String html,
  required int size,
  required bool truncated,
  Directory? rootDirectory,
  DateTime? now,
  Duration retention = workspaceHtmlStagingRetention,
}) async {
  final root = workspaceHtmlStagingRoot(rootDirectory: rootDirectory);
  await sweepWorkspaceHtmlStaging(root: root, now: now, retention: retention);
  final stem = workspaceHtmlStagingStem(
    sessionKey: sessionKey,
    workspacePath: workspacePath,
    size: size,
    truncated: truncated,
  );
  final scope = Directory(path.join(root.path, stem));
  await scope.create(recursive: true);
  final name = workspacePath.split('/').last;
  final safe = name.replaceAll(RegExp('[^A-Za-z0-9._-]'), '_');
  final file = File(
    path.join(scope.path, safe.endsWith('.html') ? safe : '$safe.html'),
  );
  // The browser runs this page with full local privileges, which is a weaker
  // posture than every in-app renderer. Injecting the restrictive policy --
  // and stripping any the file declared for itself -- closes most of that
  // gap; the rest is stated to the reader before they choose to open it.
  await file.writeAsString(
    SessionArtifactPreviewHtmlPolicy.injectRestrictiveContentSecurityPolicy(
      html,
    ),
  );
  return file;
}
