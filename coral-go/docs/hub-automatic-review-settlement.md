# Automatic older-version settlement (#13192)

Existing POST /api/board/{project}/artifacts/{id}/review accepts optional boolean
`quiet` with `decision: "ignore"`. The owner's/person's authorization checks stay
unchanged. Quiet is refused on every other decision. A verified upload record must
place the target strictly before another member of the same series and team. That
newer member must still be for review or have a recorded approved/denied decision;
the state check runs inside the settlement transaction. Otherwise the request is
409 `not_older_version`, with no changes.

The client sends quiet only when Approve or Deny automatically settles an older
version through Hub. The server marks that version `superseded` using the existing
supersede transaction, instead of `ignored`: it leaves Needs you, Saved, and the
Dismissed filter; its unrelated tags remain. No uploader message, Operator-ignore
activity or inbox_item_actioned event is emitted. A separate `supersede` Activity
row is written atomically with the settlement; failure rolls back both. Normal
Dismiss retains its existing ignored tag, Undo behavior, and Inbox action event.

An older-version settlement receiving HTTP 409 with code `not_for_review` counts
as settled (another operation already settled it). Other errors count as failed;
the same 409 on the person's current decision is still surfaced to them.

Release-diff / coral-hub handoff: one optional request field on the existing owner
review route, no new route or tunnel-table changes. Response state for automatic
settlement is `superseded`, delivered=false. Retrying an already settled version
returns 409 not_for_review while that version is no longer waiting; the updated
client treats it as success for older versions only.

Until coral-hub opens the review POST, an automatic older-version request may
receive 404 from Hub. That Hub-only refusal is skipped silently (neither settled
nor failed). Other errors, and a real 404 on the computer, still count as failed.
The current version’s own decision always surfaces its refusal. Retrying returns
409 not_for_review only while that version is no longer waiting for a review.
