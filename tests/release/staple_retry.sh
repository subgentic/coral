# staple_retry.sh: the macOS release's staple, with a few tries (#12721). Sourced by the release workflow's build-macos steps (and by
# tests/release/staple_retry_test.sh); it defines two functions and does nothing else.
#
#   staple_retry PATH   staples and validates PATH, up to STAPLE_TRIES (5) times, STAPLE_WAIT (120) seconds apart, and returns 0 at the
#                       first success. It returns 1 when every try failed: Apple's ticket service (CloudKit) can be unreachable while the
#                       notary service has already answered.
#   unstapled NAME      says in the job that NAME shipped notarized but not stapled and sets UNSTAPLED=1 for the later steps. A caller uses
#                       it only AFTER it has checked that Apple answered "Accepted": an Invalid or missing answer must still fail the job.
staple_retry() {
  local target="$1" tries="${STAPLE_TRIES:-5}" wait_s="${STAPLE_WAIT:-120}" i
  for ((i = 1; i <= tries; i++)); do
    if xcrun stapler staple "$target" && xcrun stapler validate "$target"; then return 0; fi
    echo "::warning::stapling $target failed (try $i of $tries)"
    if [ "$i" -lt "$tries" ]; then sleep "$wait_s"; fi
  done
  return 1
}

unstapled() {
  echo "::warning::$1 is notarized (Apple accepted it) but its ticket could not be stapled: Gatekeeper checks the ticket online at first launch"
  if [ -n "${GITHUB_ENV:-}" ]; then echo "UNSTAPLED=1" >> "$GITHUB_ENV"; fi
}
