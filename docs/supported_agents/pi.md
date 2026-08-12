# Pi

cosyncing requires Pi 0.78.1 or newer. The official installer is recommended:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

The official npm package is also supported:

```bash
npm install --global --ignore-scripts @earendil-works/pi-coding-agent
```

Pi's Node runtime is part of compatibility. cosyncing reads the installed Pi
package's `engines.node` requirement and checks the interpreter that the `pi`
launcher will actually use. If that metadata cannot be read, cosyncing requires
Node 22.19.0 or newer as a conservative fallback.

This matters when a shell still puts an old version-manager directory before a
new Node installation on `PATH`. Pi may start but then crash in `undici` with
`zlib.createZstdDecompress is not a function`. Fix the active Node selection,
then reinstall Pi under that Node installation; do not work around the check by
pointing cosyncing at a different launcher.

The shell used by setup and the persistent broker service have related but
separate `PATH` values. Read the shared [PATH, preflight, and Node migration
guide](README.md#the-two-path-environments) before changing an existing Node
installation.

Verify the effective commands before rerunning setup:

```bash
type -a node npm pi
node -p 'process.execPath + " " + process.version'
head -n 1 "$(command -v pi)"
pi --version
cosyncing setup
cosy restart
cosy doctor
```

Setup installs cosyncing's Pi bridge after Pi passes these checks. It does not
install Pi or replace Node. The legacy `@mariozechner/pi-coding-agent` package
name is still recognized for existing installations, but new installations
should use the current `@earendil-works/pi-coding-agent` package.

See the [official Pi installation guide](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md).
