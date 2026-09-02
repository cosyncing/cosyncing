# Broker release and signing

`npm` is not the production broker update channel. Packaged brokers trust the
signed stable GitHub Release manifest embedded at build time.

1. A `broker-vX.Y.Z` tag creates or resets a draft GitHub Release.
2. Architecture jobs build and hash native binaries and upload staging inputs
   directly to that draft.
3. The candidate job downloads the exact staged set, validates evidence,
   creates the reviewed inventory and SPDX 2.3 SBOM, signs manifests and checksums, removes the
   staging assets, uploads only final assets, and publishes a prerelease.
4. Each hosted architecture job executes its packaged binary and verifies its
   embedded version before staging.
5. A protected manual workflow verifies the exact candidate and promotes it
   stable without rebuilding or changing assets.

The release candidate environment stores the Ed25519 private/public key
material and key identifier. Stable promotion stores only the trusted public
key. Secrets never enter PR jobs. Private keys are written only to runner
temporary storage with restrictive permissions and are not cached or uploaded.

The client uses authenticated `GET` and `POST /api/broker/update`. A packaged
broker verifies the signed manifest, queues its existing health-checked upgrader
in an isolated systemd user unit, and rolls back an unhealthy replacement.
Candidate-manifest URLs are reserved for maintainer-controlled prerelease
acceptance.

Final release assets include the Apache-2.0 `LICENSE`, project `NOTICE`, exact
compiled software inventory, SPDX SBOM, and generated third-party notices for
the pinned Bun runtime and every external package in the compiled dependency
closure. They are covered by signed checksums.

This describes the release mechanism, not current authorization to distribute
compiled executables. Candidate creation and stable promotion fail closed unless
the protected `COSYNCING_BINARY_RELEASE_LEGAL_APPROVED` variable is exactly
`true`. Keep it unset until the Bun runtime relinking/object-material issue and
the complete licence set are resolved under
[Compiled broker distribution readiness](../legal/binary-distribution-readiness.md).

Each release is signed by a key **pair**, not a key: Ed25519 for the manifest a
broker verifies, and ECDSA P-256 beside it for installers whose crypto library
cannot load an Ed25519 SPKI — stock macOS LibreSSL, and Windows PowerShell. The
P-256 signature is published in two encodings of the same signature: raw `r||s`
for .NET, and a DER SEQUENCE for `openssl dgst -verify`.

The manifest carries one `keyId` for the pair. **Rotate both keys together, under
one new identifier.** Replacing only one leaves a release whose manifest claims an
identity that half its signatures no longer belong to, and the failure appears on
whichever hosts use the key that did not move — macOS and Windows for P-256, every
Linux host and every self-update for Ed25519. Installers pin both public keys, so
a rotated pair reaches operators only through a reviewed release, exactly as a
single key does.

If a signing key may be compromised, stop candidate creation and stable
promotion, remove affected drafts, revoke the key identifier from the trusted
key set, rotate protected environment secrets, and publish a security advisory.
Existing releases signed only by the revoked key must not be offered by the
stable channel. Introduce a new key through a reviewed client/broker release;
never replace a trusted key silently or accept an unprotected rotation manifest.

Broad private-network and specialized-device evidence is optional and never a
promotion prerequisite. A full app-triggered upgrade/unhealthy-rollback run
against a published candidate remains a maintainer acceptance lane until a
credential-free GitHub-hosted fixture can reproduce that topology.
