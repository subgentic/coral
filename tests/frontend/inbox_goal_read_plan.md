# Goals folder request plan (#22040)

The expanded Goals ledger must show every task, its actual state, and the review documents/questions belonging to it. The goal rollup supplies counts, not task records, so the existing board Tasks View endpoint supplies the rows.

On opening a goal: GET /api/board/{team}/tasks?goal={positive-id}&limit=200. Follow next_cursor using cursor until exhausted; deduplicate task IDs and reject repeated cursors. Cost is one task read per open goal up to200 tasks, otherwise ceil(task-count/200) pages. It does not read task details. Reads use the existing qualified board transport through the goal reader and a shared concurrency limit of3.

Review files use the existing artifacts endpoint with goal, repeated review-history tag filters, versions=newest, sort=name, limit=50 and explicit Load more pagination. Questions use the existing source-qualified Operator questions list, without another per-goal question request.

Folded cards read nothing, including when visible or previously loaded: both observer loads and poll/event refreshes are gated by current expansion. The first two goals start expanded; other cards wait for expansion. Open-goal results are cached30seconds, with review-change invalidation; normal background refresh runs every30seconds only while the mounted ledger is visible. Closing a card during an in-flight read does not cancel requests already dispatched.

This adds only goal, limit and cursor keys on the existing board Tasks route to the cloud Inbox folder plan. The fixed Chats/Board baseline and all cloud route authorization remain unchanged. The census checks positive goal IDs and limit200. No additional Hub route or write is introduced.
