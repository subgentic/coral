# Internal Coral links from Inbox questions (#13771)

Opening a file suspends the question without destroying its DOM. Closing the artifact restores the same draft, uploaded images and focus. About Goal/Task and goal URI navigation restore it on browser Back, with an explicit Return to question action; diff preview close or phone Back restores it too.

Both native capture listeners now defer validated dashboard-managed links to internal openers. Already-handled events are respected, so external HTTPS dispatches once. Same-origin route, exact identity and closed URI grammar checks prevent markers exempting external/lookalike destinations. No webview/AppKit/native GUI process was launched: app checks used explicit pure Go files, CGO disabled and Node harnesses; browser checks used Chrome CDP with the actual injected native capture scripts.

Question source computer is frozen at open. Artifact and comment image/body links carry that source. Goal/diff subjects resolve against it; diffs resolve only a matching live team/session's changed-file hash and use the existing read-only preview. Chat artifact links retain Preview in Coral; question, comment, chat and board text share validated goal/diff parsing.

## Validation

- Failing-first baseline reproduced obstruction at desktop/390/320 and lost remote source. Native Node harness reproduced external handoff.
- Requested Inbox/Needs you/mailbox/artifact families plus native download, asks and preview: 203/205 passed in 389.8s, two shards, no retries.
- Follow-up fixed stale metadata/href assertions and a real nested image title regression. Final focused run: 4/4 in 4.2s (artifact_refs, artifact_viewer, preview_pane_artifact_refs, artifact_question_links), no retries. Nested viewer links preserve label and source.
- Frontend Go passed in 18.851s; explicit-file native Go/Node tests passed in 1.632s.
- Full frontend static pipeline passed (exit 0), including new strict URI/source/native policy tests. Static caught and corrected import hygiene and a document-stub guard; the final guard preserves normal browser behavior.
- Diff whitespace check passed. No route, template markup or inline-script CSP hash changed.

## Evidence

Broad results: coral://artifacts/adec01b11f6ba33674a12ddc6b1c484eca4638f5184ff60f71b79ff4bab137ec
Final focused results: coral://artifacts/fd4c0f06296d6792ff61a8d6c8e4f07d1caad0c864e5bb728409dd193a8dc207
Before phone: coral://artifacts/84c01aa8db23d19f4989f094b14643d5ad372002e292f3aee73ebe9a783dd51f
After phone: coral://artifacts/f3ea241ccc8f833525c5a86d3a07e693a51fe9c76a3ce8bff84056c0407de290
After desktop: coral://artifacts/2938b85485382d6efe616d0de6565fceb1cd679f65ea8e7bb41729f1557ffbe6

Phone before/after are tagged for Operator review (question #176109); screenshots were visually inspected. Headless integration covers local/remote widths 1280/390/320, uploaded draft retention, About Goal/Task, goal/diff, remote comment, chat preview and external HTTPS exactly once.

Release: AFTER v2.0.55; base main 515cf72c5 (v2.0.54). UI and Security review required; DevOps owns landing. No claim of native GUI execution or real Hub integration: remote source behavior uses CDP API fixtures.

## v2.0.55 integration

Rebased onto the published v2.0.55 tag ef89652c9 at Orchestrator's request. The sole conflict was the artifact_comments import; both boardTeamKey and LOCAL_SERVER are retained. Range-diff preserves the approved functional patch. v2.0.55's check/X reply buttons, draft-and-picture send logic, owner-stamped identity checks and viewer/editor work remain present.

Post-rebase checks: 5/5 focused browser suites passed in 15.9s on two shards with no retries: artifact_question_links, artifact_refs, artifact_viewer, preview_pane_artifact_refs, and inbox_ask_buttons_real. Frontend Go passed in 21.131s; explicit-file headless native tests passed in 1.608s; full static pipeline exited 0. No webview/AppKit/native GUI process ran. This is focused integration proof, not a full final-head 205-suite rerun.
