// Shared signed stable-release metadata for native client update checks.
// ignore_for_file: public_member_api_docs

import 'dart:convert';
import 'dart:typed_data';

import 'package:broker_crypto/broker_crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

const stableReleaseManifestUrl =
    'https://github.com/cosyncing/cosyncing/releases/latest/download/'
    'release-manifest.json';
const stableReleaseManifestSignatureUrl = '$stableReleaseManifestUrl.sig';
const stableReleasePublicKey =
    'MCowBQYDK2VwAyEA212_jMFGHeMA4GFANcquhrjxzNOA37XXpUbYj4lusI8';
const int _maxManifestBytes = 256 * 1024;
const int _ed25519SignatureBytes = 64;

typedef StableReleaseManifestFetcher = Future<Map<String, Object?>> Function();

final stableReleaseDioProvider = Provider<Dio>((_) => Dio());

final stableReleaseManifestFetcherProvider =
    Provider<StableReleaseManifestFetcher>((ref) {
      return () async {
        final dio = ref.read(stableReleaseDioProvider);
        final bytes = await _boundedGet(
          dio,
          stableReleaseManifestUrl,
          maxBytes: _maxManifestBytes,
          accept: 'application/json',
        );
        final signature = await _boundedGet(
          dio,
          stableReleaseManifestSignatureUrl,
          maxBytes: _ed25519SignatureBytes,
          accept: 'application/octet-stream',
        );
        if (!await verifyStableReleaseManifestSignature(
          manifestBytes: bytes,
          signatureBytes: signature,
        )) {
          throw const FormatException('release manifest signature is invalid');
        }
        return decodeStableReleaseManifest(bytes);
      };
    });

Future<List<int>> _boundedGet(
  Dio dio,
  String url, {
  required int maxBytes,
  required String accept,
}) async {
  final response = await dio.get<ResponseBody>(
    url,
    options: Options(
      responseType: ResponseType.stream,
      receiveTimeout: const Duration(seconds: 20),
      sendTimeout: const Duration(seconds: 20),
      headers: {'Accept': accept},
    ),
  );
  final body = response.data;
  if (body == null) {
    throw const FormatException('release metadata size is invalid');
  }
  final bytes = BytesBuilder(copy: false);
  await for (final chunk in body.stream) {
    if (bytes.length + chunk.length > maxBytes) {
      throw const FormatException('release metadata size is invalid');
    }
    bytes.add(chunk);
  }
  final value = bytes.takeBytes();
  if (value.isEmpty) {
    throw const FormatException('release metadata size is invalid');
  }
  return value;
}

Future<bool> verifyStableReleaseManifestSignature({
  required List<int> manifestBytes,
  required List<int> signatureBytes,
  String publicKey = stableReleasePublicKey,
}) async {
  if (manifestBytes.isEmpty ||
      manifestBytes.length > _maxManifestBytes ||
      signatureBytes.length != _ed25519SignatureBytes) {
    return false;
  }
  return PairingCrypto.verifyIdentitySignature(
    publicKey: publicKey,
    message: manifestBytes,
    signature: base64UrlNoPadding(signatureBytes),
  );
}

Map<String, Object?> decodeStableReleaseManifest(List<int> bytes) {
  final value = jsonDecode(utf8.decode(bytes));
  if (value is! Map<String, Object?>) {
    throw const FormatException('release manifest is not an object');
  }
  return value;
}

final stableReleaseVersionPattern = RegExp(r'^\d+\.\d+\.\d+$');

int? compareStableReleaseVersions(String candidate, String current) {
  if (!stableReleaseVersionPattern.hasMatch(candidate) ||
      !stableReleaseVersionPattern.hasMatch(current)) {
    return null;
  }
  final left = candidate.split('.').map(int.parse).toList(growable: false);
  final right = current.split('.').map(int.parse).toList(growable: false);
  for (var index = 0; index < 3; index += 1) {
    if (left[index] != right[index]) return left[index].compareTo(right[index]);
  }
  return 0;
}
