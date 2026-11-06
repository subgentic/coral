# Account flags with boot fallback (#13793)

The cloud dashboard reads needs_native and goal_preview from the existing shared cached /api/account response. Each explicit boolean overrides its boot choice independently, including false overriding boot true. An absent or malformed field, refused/failed response, or bounded startup timeout retains the existing boot value. Native Needs you still requires native Inbox. Local and self-hosted dashboards do not read account flags or change behavior.

The Hub still authorizes reads/writes and enforces preview_required. This changes only the frontend choice of existing UI flows. Startup awaits the bounded account read; a late answer cannot flip routing after timeout.

Built on ci/2.0.55 candidate 945d1cbcb as Orchestrator requested. Reuses the parked, previously reviewed account-reader commits 2b0da7475, 56db75952 and 287e434e6, rebased onto that candidate, then updates strict-off semantics to the newly requested fallback rule. Must rebase onto the final v2.0.55 tag before review submission; batch after that release.

Failing-first: the 13-case unit matrix passed explicit true/false and local/self-hosted on the parked implementation, but failed eight fallback cases. After the correction all 13 pass: explicit true over boot false, false over true, absent true/false, failed/refused/malformed body/field, independent fields, timeout with late response, local and self-hosted. Browser integration checks both final flags and actual native-table/framed-Needs-you startup under a delayed account answer, explicit booleans, missing fields, invalid fields and failed read.

Validation script runs one browser suite, frontend package Go and full static sequentially under mac-heavy and posts failures. Browser passed 1/1 in 1.8 seconds, frontend Go passed in 19.367 seconds, and the full frontend static pipeline exited 0, including all 13 account-flag cases. Diff whitespace check passed. No backend authorization, route or inline markup changed.
