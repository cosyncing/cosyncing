# Support and compatibility

Use GitHub Discussions for usage questions and GitHub Issues for reproducible
defects. Security reports follow [SECURITY.md](SECURITY.md).

The latest stable client and broker are supported. The wire protocol accepts an
equal contract revision and a one-revision overlap when each side's declared
minimum permits it. A legacy peer without contract identity is reported as
unknown. A hard-incompatible pair remains connected in read-only Observe mode;
mutating client controls are disabled.

Each stable release supports the current and immediately preceding
client/contract generation for at least six months after the newer generation
is released. A security issue may require a faster upgrade; any exception is
announced in release notes with a safe read-only fallback where possible.

Platform build support is gated on GitHub-hosted Ubuntu, macOS, and Windows
runners. Specialized devices and private-network topologies may be tested as
optional maintainer validation, but they are not required merge or release
checks.
