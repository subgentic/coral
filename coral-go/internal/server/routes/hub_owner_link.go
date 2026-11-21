package routes

import (
	"context"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The owner check for a request that came through an added Hub (#20407). The label a request is compared with is read by the link it came through (the id the connector stamped and LinkStamp checked), and never
// falls back to another link's: an added link with no confirmed owner has none, and refuses every route that needs the owner. A request with no Hub stamp at all is a local call and keeps the enrollment's own record.

type linkOwnerReader interface {
	OwnerUser(ctx context.Context) (string, error)
	OwnerRecord(ctx context.Context) (kind, org string, err error)
	LinkOwnerOf(ctx context.Context, linkID string) (source, ownerUser string, err error)
}

// addedLinkOf is the id of the added link the request came through, "" for the enrollment's own link and for a local call. A link that cannot be read is an error (the callers fail closed).
func addedLinkOf(ctx context.Context, cs linkOwnerReader) (id string, owner string, err error) {
	v, ok := cloud.ViaFrom(ctx)
	if !ok || v.LinkID == "" {
		return "", "", nil
	}
	src, user, err := cs.LinkOwnerOf(ctx, v.LinkID)
	if err != nil {
		return "", "", err
	}
	if src != store.LinkSourceAdded {
		return "", "", nil
	}
	return v.LinkID, user, nil
}

// LinkOwnerSources are the label and record readers the owner routes use: the link-aware versions of the enrollment's own.
func LinkOwnerSources(cs linkOwnerReader) (label func(context.Context) (string, error), record func(context.Context) (string, string, error)) {
	label = func(ctx context.Context) (string, error) {
		id, user, err := addedLinkOf(ctx, cs)
		if err != nil {
			return "", err
		}
		if id != "" {
			return user, nil // that link's own, empty until the Operator confirms it
		}
		return cs.OwnerUser(ctx)
	}
	record = func(ctx context.Context) (string, string, error) {
		id, _, err := addedLinkOf(ctx, cs)
		if err != nil {
			return "", "", err
		}
		if id != "" {
			return tunnel.OwnerKindPersonal, "", nil // a team's enrollment is refused for an added link: it is always a person's
		}
		return cs.OwnerRecord(ctx)
	}
	return label, record
}

// hubLinkAdded says whether the request came through an added link; unset, none did. An added link needs its own label on every route, the update routes' marker-alone rule included.
var hubLinkAdded func(ctx context.Context) bool

// SetHubLinkAdded sets where the owner check asks whether a request came through an added link.
func SetHubLinkAdded(cs linkOwnerReader) {
	hubLinkAdded = func(ctx context.Context) bool {
		id, _, err := addedLinkOf(ctx, cs)
		return err != nil || id != "" // a link that cannot be read is treated as one that needs its label
	}
}

// hubLinkAdopt records the owner of an added link from the armed request (the store's own guard: only when it has none); hubLinkIDOf reads the id of the added link a request came through.
var (
	hubLinkAdopt func(ctx context.Context, linkID, user string) bool
	hubLinkIDOf  func(ctx context.Context) string
)

// SetHubLinkAdopt wires the per-link adoption and the id lookup.
func SetHubLinkAdopt(cs interface {
	linkOwnerReader
	ConfirmLinkOwner(ctx context.Context, linkID, account, user, how string) error
}) {
	hubLinkAdopt = func(ctx context.Context, linkID, user string) bool {
		return cs.ConfirmLinkOwner(ctx, linkID, "", user, "request") == nil
	}
	hubLinkIDOf = func(ctx context.Context) string { id, _, _ := addedLinkOf(ctx, cs); return id }
}

func addedLinkIDOf(ctx context.Context) string {
	if hubLinkIDOf == nil {
		return ""
	}
	return hubLinkIDOf(ctx)
}

func viaAddedLink(ctx context.Context) bool { return hubLinkAdded != nil && hubLinkAdded(ctx) }
