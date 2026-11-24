# #21108: bounded Live renewal and delay

Based on #21030 a17a0f0986. The newer Operator ruling replaces the mock's unlimited expiry and five-minute delay choices.

The delay select offers 30 seconds and 1 minute, matching slice 6 b087966084. “Re-confirm after” offers roster periods 1, 7, 30 and 90 days, default 90. Selecting chat fixes the period at 7 days and disables that select. Changes remain drafts until the preview is read and explicitly confirmed.

The route's `period_days` field drives renewal. `expires_in=none` remains its legacy transport value for no additional hard-stop timer; it does not disable the required renewal clock. The public page still pauses after the backend's re-confirm grace. The displayed roster renewal text uses the approved period, not a constant 90 days.

Validation:
- New option assertions fail on a17a0f0986 because it still offers delay 300 (0/1, 1.4s).
- Updated browser suite passes 1/1 (1.5s). It verifies the exact option values, the 90-day roster default, a 30-day draft write, and fixed/disabled 7-day chat renewal, plus the existing stale-preview/read/Stop and approved-snapshot regressions.
- Startup JS 405524 → 405524; CSS 106326 → 106326, gzip -9.
- Frontend Go tests pass, 29.456s.
- Full frontend static checks pass (exit 0), with CORAL_START_BASE=a17a0f0986. Final commit amendment changes only this validation report.
- Four new screenshots at 390 and 1440 in dark/light themes were opened and inspected. No horizontal overflow. Browser routes are mocked; this is not real Hub or timer integration proof. No 200% text claim.

Search of frontend tests found no Live pin or golden containing the removed choices. Other occurrences of “5 minutes” are unrelated timer/reminder wording and remain intact. The approved historical design mock is preserved as historical evidence.
