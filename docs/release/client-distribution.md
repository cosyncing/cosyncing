# Client distribution

Client releases are separate from the npm broker package and compiled native
broker releases. A `client-vX.Y.Z` tag stages four client artifacts from the
reviewed tag:

- a project-key-signed Android APK;
- a Linux x64 tarball;
- an unsigned Apple Silicon macOS DMG; and
- an unsigned Windows x64 portable ZIP.

iOS distribution is deferred. TestFlight and App Store distribution require an
active Apple Developer Program membership; simulator compilation remains part
of public CI.

## Release controls

`.github/workflows/client-release.yml` requires the tag version to equal both
the root package version and the base version in `apps/client/pubspec.yaml`. The
tagged commit must already be on `main`, and the complete repository check runs
before packaging.

The workflow creates or resets only the matching draft, builds each platform on
its native hosted runner, uploads the four final assets, generates
`SHA256SUMS`, downloads and verifies the remote set, and publishes a GitHub
prerelease for physical acceptance. It never builds or ships the native broker.

After physical acceptance, `.github/workflows/client-release-promote.yml`
requires the exact tag plus typed `PROMOTE` confirmation. It verifies the same
five remote assets and promotes them stable without rebuilding or replacing
anything.

## Pairing protocol rollout order

Pairing payload version 3 is a client-first change because broker and client
releases use separate channels. Before publishing an npm broker that emits v3:

1. publish and physically accept the matching client release;
2. promote that client release stable;
3. confirm every supported client download includes the v3 parser; and
4. only then publish the npm broker release.

Do not reverse these steps. A v1/v2 client cannot parse a v3 pairing offer.
The updated client remains able to pair with v1/v2 brokers during the rollout.
While connected to a revision-15 broker, that client also retains the old
WebSocket query credential path. It selects the fallback only after an
authenticated health response identifies revision 15; current brokers always
use one-use tickets. The revision-16 broker raises its minimum client revision
to 16 and rejects long-lived query credentials.

## Protected configuration

The `client-release-candidate` environment holds:

- `COSYNCING_ANDROID_KEYSTORE_B64`
- `COSYNCING_ANDROID_KEYSTORE_PASSWORD`
- `COSYNCING_ANDROID_KEY_ALIAS`
- `COSYNCING_ANDROID_KEY_PASSWORD`

The keystore must be backed up outside GitHub. Losing it prevents Android from
accepting future updates over the installed app. The workflow materializes it
only in runner temporary storage and fails closed rather than falling back to
Flutter's debug certificate. The final APK signer must also match the reviewed,
non-secret certificate fingerprint in
`docs/release/android-signing-certificate.sha256`; replacing the environment
secret with a different release key therefore fails publication.

The `client-production` environment guards manual stable promotion and contains
no signing key.

## Unsigned desktop policy

The macOS and Windows filenames, release notes, and user instructions state
that those builds are unsigned. macOS Gatekeeper and Windows SmartScreen may
warn or block first launch. Checksums provide file integrity, not publisher
authentication. A later signing/notarization lane must publish a new version;
it must not silently replace existing assets.
