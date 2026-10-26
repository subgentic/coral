Real agy 1.4.7 captures, supplied by the Antigravity CLI tester (#7764), scrubbed of paths (same length) and with the session id replaced by 7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.

- oneturn/: a complete one-turn conversation (USER_INPUT, PLANNER_RESPONSE with a run_command call and its tokens, GENERIC tool result, final PLANNER_RESPONSE), in the compact transcript.jsonl and the transcript_full.jsonl beside it.
- launched/: rows 1-4 of a Coral-launched agy's compact transcript.jsonl, whose first row is cut at about 4,096 characters ("truncated_fields": ["content"]) before Coral's CORAL_SESSION_ID marker, and the first row of its transcript_full.jsonl, which has the marker.
