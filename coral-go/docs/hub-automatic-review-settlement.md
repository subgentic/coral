# Automatic older-version settlement (#13192)

Existing POST /api/board/{project}/artifacts/{id}/review accepts optional boolean
`quiet` with `decision: "ignore"`. The owner's/person's authorization checks stay
unchanged. Quiet is refused on every other decision.

The client sends quiet only when Approve or Deny automatically settles an older
version through Hub. The server marks that version `superseded` using the existing
supersede transaction, instead of `ignored`: it leaves Needs you, Saved, and the
Dismissed filter; its unrelated tags remain. No uploader message, Operator-ignore
activity or inbox_item_actioned event is emitted. Normal Dismiss retains its
existing ignored tag, Undo behavior, and Inbox action event.

An older-version settlement receiving HTTP 409 with code `not_for_review` counts
as settled (another operation already settled it). Other errors count as failed;
the same 409 on the person's current decision is still surfaced to them.

Release-diff / coral-hub handoff: one optional request field on the existing owner
review route, no new route or tunnel-table changes. Response state for automatic
settlement is `superseded`, delivered=false. Retrying an already settled version
returns 409 not_for_review, which the updated client treats as success for older
versions only.
