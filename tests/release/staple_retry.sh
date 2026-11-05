# staple_retry.sh: the macOS release's staple, with a few tries (#12721). Sourced by the release workflow's build-macos steps (and by
# tests/release/staple_retry_test.sh); it defines three functions and does nothing else.
#
#   staple_retry PATH   staples and validates PATH, up to STAPLE_TRIES (5) times, STAPLE_WAIT (120) seconds apart, and returns 0 at the
#                       first success. It returns 1 when every try failed: Apple's ticket service (CloudKit) can be unreachable while the
#                       notary service has already answered.
#   validate_retry PATH runs `xcrun stapler validate PATH` up to VALIDATE_TRIES (3) times, VALIDATE_WAIT (30) seconds apart, and returns 0 at the
#                       first success, 1 when every try failed (#13568): the verify step's validate asks the same ticket service, which answered
#                       "The network connection was lost" (CloudKit error 68) after Apple had accepted the notarization. A ticket that is
#                       really missing or wrong fails every try, so the job still fails; the caller runs it bare, under set -e.
#   unstapled FLAG NAME says in the job (a warning line and the job summary) that NAME shipped notarized but not stapled, and sets FLAG=1
#                       (UNSTAPLED_APP or UNSTAPLED_DMG, one per artifact) for the later steps. A caller uses it only AFTER it has
#                       checked that Apple answered "Accepted": an Invalid or missing answer must still fail the job.
staple_retry() {
  local target="$1" tries="${STAPLE_TRIES:-5}" wait_s="${STAPLE_WAIT:-120}" i
  for ((i = 1; i <= tries; i++)); do
    if xcrun stapler staple "$target" && xcrun stapler validate "$target"; then return 0; fi
    echo "::warning::stapling $target failed (try $i of $tries)"
    if [ "$i" -lt "$tries" ]; then sleep "$wait_s"; fi
  done
  return 1
}

validate_retry() {
  local target="$1" tries="${VALIDATE_TRIES:-3}" wait_s="${VALIDATE_WAIT:-30}" i
  for ((i = 1; i <= tries; i++)); do
    if xcrun stapler validate "$target"; then return 0; fi
    echo "::warning::validating the ticket of $target failed (try $i of $tries)"
    if [ "$i" -lt "$tries" ]; then sleep "$wait_s"; fi
  done
  return 1
}

unstapled() {
  local flag="$1" name="$2" item
  echo "::warning::$name is notarized (Apple accepted it) but its ticket could not be stapled: Gatekeeper checks the ticket online at first launch"
  if [ -n "${GITHUB_ENV:-}" ]; then echo "$flag=1" >> "$GITHUB_ENV"; fi
  # The release run's own record of which artifact is unstapled (uploaded as the run artifact coral-macos-unstapled): tools/verify-release.sh
  # --allow-unstapled skips the ticket checks for exactly these artifacts and for no other.
  case "$flag" in UNSTAPLED_APP) item=app ;; UNSTAPLED_DMG) item=dmg ;; *) item="" ;; esac
  if [ -n "$item" ] && [ -d "${STAPLE_MARKER_DIR:-dist}" ]; then echo "$item" >> "${STAPLE_MARKER_DIR:-dist}/unstapled.txt"; fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "- **$name shipped notarized but not stapled** (Apple's ticket service was unreachable after 5 tries): Gatekeeper checks its ticket online at first launch." >> "$GITHUB_STEP_SUMMARY"; fi
}
