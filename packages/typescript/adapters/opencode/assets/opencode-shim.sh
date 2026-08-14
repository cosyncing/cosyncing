# cosyncing OpenCode terminal-attach shim.
#
# Sourced by the cosyncing managed block in ~/.bashrc / ~/.zshrc. It defines an `opencode`
# shell function that redirects ONLY the two bare-TUI invocations to the shared,
# broker-managed `opencode serve`, so their live status shows up in the cosyncing app.
# Every other invocation (any flag, any subcommand, multiple args) passes straight through
# to the real binary via `command opencode`, so the function never re-enters itself.
#
# Valid in both bash and zsh: POSIX parameter expansion only, `local` used solely inside
# functions (supported by both shells), and no bashisms that break zsh at parse time.

# Quick, side-effect-free reachability probe for the shared serve. Returns 0 when reachable.
# Args: host port. An IPv6 literal host (contains ':') is bracketed for the URL.
_cosyncing_opencode_reachable() {
  local host="$1" port="$2" hostpart="$1"
  case "$host" in *:*) hostpart="[$host]";; esac
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 1 "http://${hostpart}:${port}/session" >/dev/null 2>&1
    return
  fi
  # No curl: best-effort /dev/tcp connect (bash; IPv6 via /dev/tcp is unreliable). Unsupported shells or
  # hosts fall through as "unreachable", which only means we start a private instance — never a hard failure.
  ( exec 3<>"/dev/tcp/${host}/${port}" ) >/dev/null 2>&1
}

opencode() {
  local port="${COSYNCING_OPENCODE_PORT:-4096}"
  local host="${COSYNCING_OPENCODE_HOST:-127.0.0.1}"
  local dir=""
  local hostpart="$host"
  case "$host" in *:*) hostpart="[$host]";; esac
  local url="http://${hostpart}:${port}"

  # 0 args -> attach to the shared serve, scoped to the CURRENT directory. Bare `opencode` must open
  #   where you are: attaching WITHOUT --dir lands you in the serve's default project (the broker's
  #   working dir), not "$PWD" — so always pin --dir to the current directory.
  # exactly 1 arg that is not a flag and is an existing directory -> attach scoped to THAT directory.
  # everything else (any flag, any subcommand, multiple args) -> pass straight through untouched.
  if [ "$#" -eq 0 ]; then
    dir="$PWD"
  elif [ "$#" -eq 1 ] && [ "${1#-}" = "$1" ] && [ -d "$1" ]; then
    dir="$1"
  else
    command opencode "$@"
    return
  fi

  if _cosyncing_opencode_reachable "$host" "$port"; then
    command opencode attach "$url" --dir "$dir"
    return
  fi

  # Shared serve is down: never hard-fail the terminal — start a private OpenCode with the
  # original arguments and warn that live app status will not be available.
  printf '%s\n' "cosyncing: shared OpenCode serve on ${url} is unreachable — starting a private OpenCode; live app status won't be available" >&2
  command opencode "$@"
}
