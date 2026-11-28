# Needs you v19: regression check replacements (#22094)

The Orchestrator's 2026-11-28 08:52 ruling makes v19 authoritative and permits retiring old inline file-row placement checks. No suite is removed. Each named suite still runs against the real Inbox. This map describes retired checks, not passing test results; see the run logs for verdicts.

| Retired check | Replacement proof |
| --- | --- |
| inbox_one: first group must be a table | Named Needs you ledger and one row per pending request in inbox_one. |
| inbox_one: Item/CLI/Folder/Team/Goal/Waiting/Actions column headings | Ledger row identity, team, timestamp and action ownership in inbox_one; goal link in flat grouping. CLI/folder columns are absent from v19. |
| inbox_one: old title/count row and exact old font scale | Phone title/Select header in inbox_one and needs_ledger; current typography scale in inbox_one. |
| inbox_needs_toolbar: kind pills and phone native select | All/Unread/Questions quick views plus separate real Kind menu; Permission/Needs input filtering retained in the same suite. |
| inbox_needs_toolbar: visible Sort field in Waiting on you | Ledger's pinned-prompt/newest-group order in needs_ledger; facet filtering, persistence and clear-all retained in the toolbar suite. |
| inbox_needs_v3: two-row phone toolbar | One phone title/count/Select row, count-triggered tools, named robot/44px targets and unclipped quick views in the same suite. |
| inbox_needs_rows_v3: identical page x for all rows across groups | Separate icon/title/check and timestamp per grouped row in the same suite; nested group indentation is intentional. |
| inbox_needs_rows_v3: permission Dismiss and no kebab | Permission Dismiss absence plus phone More ownership in needs_ledger; permission allow/deny remain owned by inbox_answer. |
| inbox_needs_rows_v3: amber old-age triangle | Explicit source timestamp and muted, short elapsed time in the same suite. v19 omits the triangle. |
| inbox_needs_rows_v4: grey one-line Goal/Task chips | Goal identity in its group and an actual task link in row metadata, containment, choice collapse and task navigation in the same suite. |
| inbox_needs_rows_v4: two-line question clipping | Full question body availability in needs_ask_expand and needs_ask_preview. |
| needs_agent_actions: Item/Actions columns, missing-details subtitle | Explicit permission status, readable separated body, terminal action and asynchronous answers before/after fields in the same suite. |
| needs_agent_actions: permission Dismiss fallback | Explicitly removed by v19; permission owner choices and terminal remain, with absence checked in needs_ledger. |
| needs_agent_ask_expand: mixed table headers/four-line preview | One asker, metadata above full numbered question, fifth step available and no overflow; all retry/empty/caching/source/keyboard/focus/turnover assertions retained. |
| needs_ask_expand: board-question preview and Show all/less | Complete separate question bodies, numbered lines, no repeated address/cut marker, readable measure/no overlap and real Enter/Space group folding with focus retained. Agent asynchronous expansion is retained separately. |
| needs_ask_subjects_inline: 20px chips and Question-word placement | Real task links beneath the question and parent goal identity/Open goal action, aligned and contained, in the same suite. |
| needs_computer_chip: phone chip/desktop column | Source-qualified metadata for both mixed kinds and same-named agents, with containment at 1280/390/320, in the same suite. |
| needs_computer_chip_long: ellipsis and chip title | Complete wrapped computer name and asker text kept inside the row, separate from time, at 320/390 and 100/200%, in the same suite. |
| needs_card_rows: inline Approve always shown | One named file opener at rest; decisions reached in the viewer in needs_actions_b. |
| needs_card_rows: action footer/right-edge geometry | File hover has no geometry/action movement; long answer controls wrap and remain contained at 100/200%, in the same suite. |
| needs_actions_b: inline Approve/Request changes positions | File opener reaches the actual viewer Approve/Request changes, with enabled state and phone targets, in the same suite. |
| needs_actions_b: inline More menu with note/Deny/copy | Viewer More retains Approve with a note, Refuse and Copy version ID, checked in the same suite. |
| needs_actions_b: old Deny fill colour | Old row control no longer exists; Refuse is the current viewer action. Its appearance remains owned by artifact review CSS, not the ledger. |
| needs_actions_b: single-row Dismiss menu and named toast | Select one file → Dismiss writes one ignore decision and offers Undo, in the same suite; stale-read Undo covered in needs_bulk_dismiss_undo. |
| needs_actions_b: Save for later on row | No Save path appears in v19's desktop, phone, Select or menu states, or the current viewer. Reported to Orchestrator in board286326 for an Operator follow-up; no new control added. |
| inbox_goal_groups: main-list star button target/overlap | File opener accessibility/44px and grouped geometry in needs_ledger/inbox_phone_cards; Star is exercised in the unchanged agent tab and existing Artifacts owner. |
| inbox_goal_groups: pinned section and goal-less inline pin metadata | Source-qualified goal/Direct groups, all 13 producer documents retained, and full goal identities in the same suite. v19 has no pinned section. |
| inbox_goal_groups: main-list star must not open viewer | Current file opens viewer; retained Star owner writes on Waiting on an agent and Artifacts, independent of file opening. |
| inbox_goal_groups: pinned file ARIA/first-line timing at 200% | File opener identity/version and source-specific New state in the same suite; small-screen identity/containment in inbox_phone_cards and needs_computer_chip_long. |
| inbox_goal_groups: source-qualified main-list star write | Same m2 PUT route checked through existing Artifacts star at 1280; agent-tab Star remains tested. |
| inbox_phone_cards: chat bubble paint/radius/tint/12px inter-card gap | Grouped ledger file/icon/word containment at six viewport/theme/text combinations, including 200%, in the same suite. |
| inbox_phone_cards: Goal/Task/Closes goal pills and old version-line layout | Parent goal number/title plus real file name/version; complete review question retained in viewer Details. v19 omits those pills. |
| inbox_phone_cards: old footer button geometry | Named 44px file opener and separate glyph; one tap still reaches viewer and unread attention drops while both files remain. |
| inbox_phone_cards: Group by checkbox inside Filters | Reachable 44px shared Group by button inside count-triggered tools in the same suite. |
| inbox_phone_cards: long press on Goal chip | Header Select → file checkbox → one selected → Clear, in the same suite; v19 explicitly uses Select and has no file goal chip. |

Selectors alone changed in count, paging, filter-empty, live-announcement, alerts, bulk Undo, bulk partial-selection and welcome Dismiss/Undo/Restore suites; their existing behavior assertions remain. No waiver of the combined 68-suite run, census/golden, current static checks or reviewer verdict is implied.

- `needs_full_width`: Orchestrator ruling 2026-11-28 09:05: approved v19 supersedes #18358; assert the 880px cap at all three desktop widths.
