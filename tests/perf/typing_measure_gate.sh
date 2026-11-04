#!/usr/bin/env bash
# Measurement is diagnostic by default; an explicit typing gate must propagate
# failures to its caller while keeping the child's diagnostics in its own log.
run_bigboard_measure() {
  local measure_label="$1" measure_log="$2" measure_status=0
  shift 2
  "$@" > "$measure_log" 2>&1 || measure_status=$?
  printf '%s measure exit=%s\n' "$measure_label" "$measure_status"
  if [[ "${TYPING_GATE:-}" == 1 ]]; then return "$measure_status"; fi
  return 0
}
