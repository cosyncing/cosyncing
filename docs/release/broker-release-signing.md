# Broker release and signing

The signed GitHub release distributes the broker as JavaScript with a separate
web sidecar. This source change prepares that path; it does not publish a
release or repair the live one-liner before candidate publication and promotion.

1. After matching Flutter clients have been released and physically accepted,
   a new `broker-vX.Y.Z` tag on accepted public `main` creates a draft release.
2. The JavaScript job builds `cosyncing-app.js` with `bun build --target=bun`,
   without `--compile`, stamped `distribution=bootstrap-js`. It executes that
   exact bundle through Bun to collect version, source, schema and contract
   evidence. The web job builds and stages the matching web sidecar and evidence.
3. Candidate assembly downloads exactly those four staging files. It parses the
   broker payload as JavaScript, verifies its evidence, and executes that bundle
   through an explicitly resolved Bun to verify broker/web browser parity in an
   isolated fixture with managed agent runtimes disabled.
4. Assembly takes the broker contract from verified JavaScript evidence and
   cross-checks web evidence. It imports the three desktop client archives from
   the already stable `client-vX.Y.Z` release at the **same source commit**.
5. Assembly signs the manifest, provenance and checksum list; the candidate job
   replaces staging inputs with the exact final set, downloads and verifies that
   set, then publishes a prerelease. Nothing containing a compiled native broker
   or a bundled Bun archive is an allowed publication input or output.
6. The protected promotion workflow checks the expected tag version and source
   commit, trusted public keys, signatures, digests, provenance and exact asset
   set. It promotes accepted bytes without rebuilding or replacing assets.

The `broker-release-candidate` environment stores signing material and the key
identifier. `broker-production` stores only trusted public keys. Secrets never
enter PR jobs. Private keys use restrictive permissions in runner temporary
storage and are never cached or uploaded. The PR gate may still compile native
brokers for ephemeral testing; it does not upload them.

## Final asset inventory

The release contains 28 files. `<version>` is the new release version:

- `cosyncing-app.js` and `cosyncing-web-app.tar.gz`, each with
  `.intoto.jsonl` provenance and its `.intoto.jsonl.sig` Ed25519 signature;
- `cosyncing-client-<version>-linux-x64.tar.gz`,
  `cosyncing-client-<version>-macos-arm64-unsigned.zip`, and
  `cosyncing-client-<version>-windows-x64-unsigned.zip`;
- `install.sh`, `install-server.sh`, `install.ps1`, `install-server.ps1`;
- `release-manifest.json` and `SHA256SUMS`, each with `.sig`, `.p256.sig`
  and `.p256.der.sig` signatures;
- `release-key.pem`, `release-key-p256.pem`;
- `software-inventory.json`, `software-bom.spdx.json`, `LICENSE`, `NOTICE`,
  `THIRD_PARTY_NOTICES.txt`.

Staging evidence is not a final asset. No `cosyncing-linux-*` or
`cosyncing-darwin-*` broker, platform broker archive, or Bun runtime archive is
published. The exact-set checks include hidden files, directories and symlinks.
The JavaScript payload check requires UTF-8 JavaScript with the Bun interpreter
line and parses its syntax; renaming a native executable to `.js` cannot pass.
Flutter client binaries remain allowed inside their expected desktop archives.

The software inventory and SPDX 2.3 SBOM enumerate the broker JavaScript
dependency closure and identify the distributed web/client archives. They do
not claim to enumerate Flutter's dependency closure: the web sidecar retains
`app/assets/NOTICES`, and desktop archives retain their Flutter/plugin licence
files. Generated broker notices contain each bundled JavaScript dependency's
licence. Bun is recorded as an **external runtime requirement**, not a bundled
component. Installers reuse a suitable Bun or fetch the pinned upstream archive
directly; users do not need to preinstall Bun. cosyncing does not mirror that
archive into its release.

## Manifest and installed-version compatibility

`schemaVersion: 1` and the Ed25519 signing payload encoding stay unchanged.
The parser now accepts `artifacts: []` only with valid `jsApp`, `contract` and
`webApp` metadata. Empty releases, malformed metadata, untrusted keys and invalid
signatures fail closed. Native-target verification remains available for legacy
manifests and tests; no fake native descriptor represents JavaScript.

This is an extension to the manifest's accepted shapes, **not backward
compatibility with every schema-1 reader**. Published 0.5.2 installer-owned
brokers reject an empty native list before selecting `jsApp`. Those installations
must rerun the new release's installer, followed by `setup` if using the server
installer, to acquire the updated parser. Earlier native installer builds also
cannot select a JS upgrade and require reinstallation. Do not delete state or
edit receipts by hand. See [installer migration](../installation/script-install.md#migrating-older-installer-owned-brokers).

New `bootstrap-js` builds retain the signed self-update path, recorded runtime,
installation receipt, versioned web sidecar and health-checked rollback. The
client uses authenticated `GET` and `POST /api/broker/update` for that path.
`bun-js` npm installations, including published 0.5.1 and 0.5.2, remain package-
manager owned: update the global npm package, then run `cosyncing setup`. They
do not consume this signed self-update channel.

No broker/client wire fields or compatibility rules change, so no wire contract
revision or client minimum revision changes with this packaging work. Matching
release clients still need new builds at the new release commit. Previously
published 0.5.2 clients cannot be relabelled as same-commit candidates.

## Native distribution boundary

Keep `COSYNCING_BINARY_RELEASE_LEGAL_APPROVED` **unset**. The JavaScript workflow
has no native publication path, even if that variable is set. Any future channel
carrying an embedded-runtime broker requires the dated approval and protected
legal gate specified in
[Compiled broker distribution readiness](../legal/binary-distribution-readiness.md),
as well as a reviewed packaging/workflow change. This is an engineering packaging
control, not legal clearance for compiled Bun applications.

## Signing and acceptance

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
