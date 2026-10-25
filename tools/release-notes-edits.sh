#!/usr/bin/env bash
# notes_drop_edited TAG: reads a release's notes section on stdin and, for TAG, applies the corrections tools/release-notes-edits.txt lists for the
# published body (a deliberate correction after publication): a row of two columns DROPS every line that starts with the text; a row of three columns
# REPLACES it with the third column, the line as the published body now has it. Sourced by tools/verify-release.sh. RELEASE_NOTES_EDITS_FILE overrides
# the table (the tests).
_rne_file() { echo "${RELEASE_NOTES_EDITS_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-notes-edits.txt}"; }
notes_drop_edited() {
  local tag="$1" f prefixes=() repl=() p t r line i
  f="$(_rne_file)"
  if [ -f "$f" ]; then
    while IFS=$'\t' read -r t p r; do
      case "$t" in ''|'#'*) continue ;; esac
      [ "$t" = "$tag" ] && [ -n "$p" ] && { prefixes+=("$p"); repl+=("$r"); }
    done < "$f"
  fi
  if [ "${#prefixes[@]}" = 0 ]; then cat; return; fi
  while IFS= read -r line || [ -n "$line" ]; do
    for i in "${!prefixes[@]}"; do
      case "$line" in
        "${prefixes[$i]}"*) [ -n "${repl[$i]}" ] && printf '%s\n' "${repl[$i]}"; continue 2 ;;
      esac
    done
    printf '%s\n' "$line"
  done
}

# release_notes_section VER < RELEASE_NOTES.md: the lines of this version's section (after its "## vVER" heading, up to the next "## "). A heading whose version
# goes on with a digit, a dot or a dash is another release: v1.4.167-rc2 is not v1.4.167, so a final's section stops at the first release-candidate heading
# below it (before, the dash did not stop it, and the final's expected notes ran on through the rc1 and rc2 sections).
release_notes_section() {
  awk -v v="## v$1" 'index($0, v) == 1 && substr($0, length(v)+1, 1) !~ /[0-9.-]/ {on=1; next} on && /^## / {exit} on {print}' | sed '/./,$!d'
}
