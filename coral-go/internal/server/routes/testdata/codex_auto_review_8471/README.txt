Real Codex 0.163.0 capture, 2026-10-26, task #8471.
Isolated HOME, on-request/workspace-write, approvals_reviewer=auto_review.
Prompt requested harmless printf CT8471_AUTO_RUN with require_escalated.
No approval input was provided. CLI emitted PreToolUse, PermissionRequest, PostToolUse, exited 0 and printed the marker.
IDs and paths replaced. turn_context retains only the actual approval/sandbox settings.
There is no reviewer/escalation field on PermissionRequest.

A second isolated real TUI run selected approvals_reviewer=user and opened the
approval menu for the same command. Its PreToolUse/PermissionRequest captures
are user-*.json. No new hook followed PermissionRequest while it waited;
Esc cancelled the run. Its TUI emitted OSC 7501 state=blocked:app=codex.
A third real TUI run under auto_review emitted idle -> working -> idle with no
blocked state and no human menu, and printed the marker. The OSC fragments in
the parser test are extracted from those observations.
The automatic-review escalation tests compose those observed native signals
with the real dialog screen; they do not claim a real guardian-denial capture.
