# Pictures in every text box — inventory and proposed contract

Task #20729 · Goal #285 · Source audit of main `f1cd25e2b4` · 2026-11-23

This is a source inventory, not a live Hub acceptance test. “Local yes” means there is an attachment composer and send path in this revision; it does not assert every target agent can run now. Hub transport below is derived from the frontend requests and local handlers. The separate coral-hub service has not been inspected here. Its team must confirm which routes are enabled in its deployed revision.

## Conversation and work fields

| Surface / field | Local today | Through Hub today | Required change |
|---|---|---|---|
| Live agent chat / popout Message | Yes: choose, paste, drop; per-session chips; upload to agent’s own computer | Frontend routes multipart `/api/upload` via selected computer; existing Hub-aware uploader and refusal handling. Live verification still needed | Keep behavior, unify attachment presentation |
| Agent question card “Or type your own answer” | Yes: Add image and paste; scoped to card; no card drop handler found | Same `postImage` as chat, selected session/server | Add scoped drop and matching tray |
| Activity conversation reply to agent | Yes: choose, paste, drop; requires running target agent | Same selected-session `/api/upload`; not Hub-verified here | Keep destination; consistent tray and errors |
| Artifact viewer review note / request changes | Yes: tray, choose/paste/drop, stored before review submission | UI sends source-computer `/api/artifacts/{hex}/comment-images`; Hub team reported missing route when feature off (#264321) | Hub route prerequisite; enable rather than hide picker |
| Artifact comments: whole file, quoted text, video timestamp, replies | Yes: same tray; edits keep old images, cannot add new ones | Same artifact comment-image route and comment write permission | Support attachment changes on edit; preserve anchor/timestamps |
| Goal comments and diff comments | Yes: same tray, uploads use team `/goal-images` | Frontend sends source-computer team route; Hub availability unverified | Confirm team upload route, scope, comment POST and image reads |
| Activity file comment | Yes: shared comment-image tray | Same artifact route; missing while Hub switch off | Same prerequisite and tray |
| Needs you question: team/board ask reply | Yes: shared tray; team image upload | Uses team `/goal-images`, source computer; Hub availability unverified | Confirm team upload and downstream answer delivery |
| Needs you question: single-agent ask reply | Yes: shared tray, raw `/api/agent-asks/{id}/images` | Uses source computer; Hub availability unverified | Confirm owner-authorized image upload and answer route |
| Inbox task reply (`inbox_panel`) | No: text-only adapter; Send requires text | No attachment path in this UI | Add scoped upload, retain attachments in task conversation and delivery |
| Team chat dock / Message board post and reply | No: JSON content only | No attachment composer in either surface | Add team-scoped uploader, artifact references, image rendering and delivery |
| New goal description | Yes: choose/paste/drop; team artifact IDs in create `images` | Source-team route; Hub availability unverified | Confirm Hub route and create contract |
| Edit goal description / Done when | No new images on edit; goal description tray explicitly hidden. Done when is plain text | Same restriction | Add/edit/remove attachment associations; shared field attachment affordance |
| New task description and workflow instructions | No | No | Upload before task exists; associate with created task/field |
| Edit task description, instructions, reason; review-task text edits | No | No | Persist field references with revision, preserve existing images |
| Complete task: message / report content / evidence | Text and explicit artifact references supported; no image picker | Same UI restriction | Add tray; carry references in completion result without completing early |
| Quick Approve with note / Deny or Refuse reason | No: text-only 500-character reason | Same UI restriction | Add image references separately from bounded reason; preserve decision semantics |

### Additional prose boxes (also covered by “every text box”)

The following are text-only locally and have no picture composer through the Hub in this revision. Existing manually typed artifact/Markdown links are not an image upload flow.

| Fields | Evidence in `coral-go/pkg/frontend/` | Proposed treatment |
|---|---|---|
| New team directive / first task / additional instructions; team presets and workflow instructions | `templates/includes/modals.html` team-wizard-directive; `static/team_launch_settings.js`; `team_settings_page.js` | Same picture tray beside each prose field, scoped to team or provisional draft |
| Agent role/behavior/instructions; global Orchestrator/worker prompts and reminders | `agent_config_form.js`; `agent_instructions_dialog.js`; modals.html settings-prompt/reminder fields | Save durable picture references with instructions; resolve on agent start/delivery |
| Team Remind; agent reminder; scheduled job prompt; chief check instruction; workflow agent prompt | `team_remind_dialog.js`; `agent_reminders.js`; `job_form.js`; `chief_check_editor.js`; `workflow_editor.js` | Attach to instruction and retain until scheduled execution; verify agent receives readable refs |
| Agent UI request box; Inbox proposal description/done-when | `agent_ui.js`; `inbox_proposals.js` | Same tray; include references in existing request/proposal |
| Session notes, dock note, knowledge create/edit; Markdown artifact visual/source editor | `notes.js`; templates/includes/right_dock.html; `team_knowledge_note.js`; `team_knowledge_page.js`; `artifact_markdown_editor.js` | Insert durable picture reference at caret in document, preview it; no base64 in saved prose |
| Code/custom-view editors and fallback textareas | `preview_editor.js`; `custom_views.js` | Offer Add image as a file/reference insertion action; keep source syntax intact |
| Commit message | `team_uncommitted.js` | Attach picture as a durable reference in message text, not raw image bytes |

### Structured text controls — inventoried boundary for approval

Names/titles, search/filter text, numeric IDs, addresses/emails, paths, branch names, URLs, credentials, flags, shell commands and readonly/copy buffers also use input/textarea elements. They are not missed: an image cannot replace their validated value. Recommendation: every *prose* box gets choose/paste/drop; structured controls retain validation and may offer an adjacent record-level attachment action where useful (task/goal title attaches to that task/goal). No global paste handler should silently put a picture into another composer. This boundary is explicit in the proposal and needs Operator approval rather than silently narrowing “every”. Examples: `custom_modes.js` flags; `dropbox_share.js` email list; workflow shell steps; password settings; readonly team JSON and copied Markdown buffers.

## Source evidence / implementation map

- `static/image_composer.js:91-101` skips paste in other inputs; therefore its document handler does not supply universal text-box support. `image_upload.js:26` posts multipart file + session_id via `serverFetch(sessionServer(targetSession), '/api/upload')`.
- `static/card_attach.js:64-106`: question-card Add image and paste. `activity_dialog.js:50-85`: own preview strip, running session lookup, upload/paste/drop.
- `static/artifact_comment_images.js:15`: shared tray. `artifact_comment_composer.js:28`: no tray for edits. `artifact_review.js:251`; `activity_file_dialog.js:45`: callers.
- `static/artifact_comments_api.js:44-67`: comment `images`, PNG/JPEG/WebP, max four; goal/diff uploads go to goal-images; `version_of` marks up just-uploaded pictures. `editComment` patches only body.
- `static/operator_ask_dialog.js:174-181`; `agent_ask_answer.js`: team vs single-agent destination. Answer text contains artifact references, not a cross-computer filesystem path.
- `static/inbox_panel.js:258-295`: task reply takes only textarea content. `board_chat.js:626-643`; `board_composer.js:34-65`: text-only team send.
- `static/goal_editor.js:208-247`: raw team upload, edit disables tray, create sends image IDs. `task_create.js:29,47`; `team_task_actions.js:80-182`; `task_detail.js:73-81`: task prose fields.
- Local handlers: `internal/server/routes/artifact_comment_images.go`, `board_goal_images.go`, `agent_asks.go` (image upload handler), `uploads.go`, `upload_artifact.go`. Goal-images can use personPictureSession for a team with no agent; do not make all prose uploads depend on a running agent.

## Hub handoff — prerequisite, not a frontend-only switch

1. **Existing transports**: owner-authorized binary forwarding to the explicitly selected computer for `POST /api/artifacts/{hex}/comment-images?board=…&version_of=…`, `POST /api/board/{team}/goal-images?version_of=…`, `POST /api/agent-asks/{id}/images`, and multipart `POST /api/upload` with file/session_id. Preserve MIME, raw bytes/multipart, status and structured error bodies. Comment image reply: `{hex,name,content_type,size}`. Chat reply also carries path/filename/artifact or artifact_error. Preserve the local route’s current limits; do not pick new limits in the UI mock.
2. **Read and association paths**: source-computer `GET /api/artifacts/{hex}?v=2` / image preview reads and authorized comments/review/answer/goal-create writes must work together. Only the owner and appropriate team scope can attach/read; a hash from another team/person must not become authority. Carry source-computer ID with references; never reuse a different selected server or use a local path on another computer.
3. **Broader scopes**: add a draft/team/person upload contract for task creation, task replies, board chat, instruction/notes fields that lack a suitable upload route today. Do not repurpose goal-images for arbitrary fields: its recent-upload scope and association rules are goal-specific. Local backend must add association/update contracts; Hub must route them. Proposed reply `{hex,name,content_type,size,source}` and explicit field/record/draft scope are design input, not an existing API.
4. **Capability**: Hub team’s account `comment_images` must be true only once upload + read + association are actually available. A flag is not support. #20717 hide-the-picker patch `28236ba9fb` is held out of v2.1.6 per Orchestrator. Goal #285 needs routes enabled, with understandable upload failure if temporarily unavailable; do not claim working support by removing the gate alone.
5. **Lifecycle**: drafts retain text and thumbnails on upload/send failures; block send while any upload is pending/failed, allow remove or Retry; do not auto-resubmit an uncertain write. Cancel does not send or change review/task status. Uploaded unsent files need a defined expiry/cleanup policy. Retain saved instruction images until their instruction is replaced/deleted, not only until a short comment upload window expires.
6. **Proof before shipping**: real owner session through Hub, two computers with same record IDs, local and Hub choose/paste/drop, image-only send, remove, failed upload/retry, failed send/uncertain result, reopening/editing saved record, scheduled delivery, permission refusal, expired draft, and phone/desktop light/dark. Exercise every inventoried composer; mock interactions are not backend proof.

## Proposed UI

One shared tray adjacent to the active prose field: “Add image”, paste/drop, thumbnail, named remove control, upload/error line, Retry, and existing field action. Images belong to this field’s destination, and image-only replies are allowed. Single-line titles retain their value; the adjacent tray attaches to the containing record. Keep the recipient beside the composer. Show the ordinary image controls both locally and through the Hub once that destination’s route is live. No “Pictures aren’t available through the Hub yet” resting-state copy in the proposed finished product.

The HTML mock demonstrates six core flows, matching dark/light and phone widths, with a seeded attachment, choose/paste/drop, remove, upload failure/retry, sending and cancel. All actions are simulation; no network uploads, real approvals or task writes occur. It includes the structured-field boundary and Hub prerequisite for review.
