#!/bin/bash
# mini-lock (RETIRED, #13787): the Mac mini is gated by Coral's queue now, not by a lock folder on the mini. 'acquire' refuses: two systems that cannot see each other let two agents run heavy work on the
# mini at once. 'release' and 'status' still work (they reach the old script, kept beside this one as mini-lock.retired) so a stale lock folder can still be cleared.
#   claim the queue's mini slot and run in ONE command (the slot is tied to the tool call):   coral-board resource claim mini --wait && <your run>; coral-board resource release mini
cmd="${1:-status}"
case "$cmd" in
  acquire)
    cat >&2 <<'MSG'
mini-lock is retired: the mini is gated by Coral's queue now.
  Claim it (waits in line) and run in ONE command:   coral-board resource claim mini --wait && <your run>
  Give it back when you are done:                    coral-board resource release mini
  Or let a pool choose the machine for you:          coral-board heavy run -- <command>   (after the Operator's setup)
mini-idle still shows what is running on the mini. A stale old lock can be cleared with: mini-lock release <who> --force
MSG
    exit 3 ;;
  release|status)
    exec "$(dirname "$0")/mini-lock.retired" "$@" ;;
  *) echo "usage: mini-lock status|release <who> [--force]   (acquire is retired: use the queue)" >&2; exit 2 ;;
esac
