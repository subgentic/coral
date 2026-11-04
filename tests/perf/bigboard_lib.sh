# Shared by the bigboard_*.sh scripts (#13154). Sourced, not run.

# stop_private_tmux SOCKET: stops the tmux server of ONE run's own socket (<a folder this run made>/data/tmux.sock, which its mock agents were started on). After #12836 no script
# may stop a tmux server it did not start, so this refuses any socket under a real Coral folder (~/.coral, $CORAL_DIR, any .coral/) or at a path that is not <something>/data/tmux.sock;
# a socket this run's own server made with -S is exempt from the rule because no other program can be attached to it.
stop_private_tmux() {
  local sock="${1:-}"
  [[ -n "$sock" && -S "$sock" ]] || return 0
  case "$sock" in
    "$HOME"/.coral/*|*/.coral/*|"${CORAL_DIR:-/nonexistent}"/*) echo "[bigboard] refusing to touch a tmux socket under a real Coral folder: $sock" >&2; return 1 ;;
  esac
  case "$sock" in
    */data/tmux.sock) ;;
    *) echo "[bigboard] refusing an unexpected tmux socket path: $sock" >&2; return 1 ;;
  esac
  tmux -S "$sock" kill-server 2>/dev/null
  return 0
}

# write_auth_header FILE KEY: a curl header file (use: curl -H @FILE), mode 600, so the API key is not in any command line another account could read with ps.
write_auth_header() { ( umask 077; printf 'Authorization: Bearer %s\n' "$2" > "$1" ); }
