// The implementation is private; only its conditional factory is exported.
// ignore_for_file: public_member_api_docs

import 'dart:io';

import 'package:cosyncing_client/src/platform/update/android_update_platform_contract.dart';
import 'package:flutter/services.dart';

AndroidUpdatePlatform createAndroidUpdatePlatform() =>
    const _MethodChannelAndroidUpdatePlatform();

final class _MethodChannelAndroidUpdatePlatform
    implements AndroidUpdatePlatform {
  const _MethodChannelAndroidUpdatePlatform();

  static const _channel = MethodChannel('com.cosyncing.client/android_update');

  @override
  bool get supported => Platform.isAndroid;

  @override
  Future<AndroidInstalledAppIdentity> installedIdentity() async {
    final value = await _channel.invokeMapMethod<String, Object?>(
      'installedIdentity',
    );
    final applicationId = value?['applicationId'];
    final versionCode = value?['versionCode'];
    final signerSha256 = value?['signerSha256'];
    if (applicationId is! String ||
        versionCode is! int ||
        signerSha256 is! String) {
      throw const FormatException('Android installed identity is malformed');
    }
    return AndroidInstalledAppIdentity(
      applicationId: applicationId,
      versionCode: versionCode,
      signerSha256: signerSha256,
    );
  }

  @override
  Future<AndroidInstallLaunchResult> installApk({
    required String path,
    required String applicationId,
    required String version,
    required int versionCode,
    required String signerSha256,
  }) async {
    final value = await _channel.invokeMethod<String>('installApk', {
      'path': path,
      'applicationId': applicationId,
      'version': version,
      'versionCode': versionCode,
      'signerSha256': signerSha256,
    });
    return switch (value) {
      'launched' => AndroidInstallLaunchResult.launched,
      'permission-required' => AndroidInstallLaunchResult.permissionRequired,
      _ => throw const FormatException('Android installer result is malformed'),
    };
  }
}
