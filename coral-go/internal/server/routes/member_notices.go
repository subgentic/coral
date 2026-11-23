package routes

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
)

// The feed of access given to a Hub's people, and the Revoke for it (#20914, for #20909; contract coral://artifacts/81f00bdeb93662ac5a707247d228f956e48c74d7f91f5b1083d802af8d72ecc4). Both routes are local only:
// they are not in the tunnel table (tier never), they are in operatorOnlyRoutes (an agent token is refused), and each asks humanInputCaller. A Hub, an agent and Hub B cannot read the feed or press Revoke.

const (
	noticeMaxRows = 50
	noticeDays    = 30
	noticeHostCap = 80
)

var (
	noticeHub    func(ctx context.Context, linkID string) string // the Hub origin of a link; "" when the link is gone
	noticeDevice func(ctx context.Context, kid string) string    // the label of a trusted device; "" when none
)

// SetNoticeLookups wires the two reads the feed needs from the link store and the device list.
func SetNoticeLookups(hub func(context.Context, string) string, device func(context.Context, string) string) {
	noticeHub, noticeDevice = hub, device
}

type noticeTeam struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type noticeRow struct {
	GrantID   string     `json:"grant_id"`
	State     string     `json:"state"`
	Level     string     `json:"level"`
	Team      noticeTeam `json:"team"`
	Person    string     `json:"person"`
	HubUser   string     `json:"hub_user"`
	LinkID    string     `json:"link_id"`
	Hub       string     `json:"hub"`
	SignedBy  string     `json:"signed_by"`
	Device    string     `json:"device"`
	Via       string     `json:"via"`
	CreatedAt string     `json:"created_at"`
	ExpiresAt string     `json:"expires_at"`
	RevokedAt *string    `json:"revoked_at"`
	RevokedBy string     `json:"revoked_by"`
}

// hubHost is the Hub's host, first, and cut with a mark when it is long, so a cut can never hide which Hub it was.
func hubHost(origin string) string {
	u, err := url.Parse(origin)
	host := origin
	if err == nil && u.Host != "" {
		host = u.Host
	}
	host = board.CleanMemberLabel(host)
	if r := []rune(host); len(r) > noticeHostCap {
		return string(r[:noticeHostCap]) + "…"
	}
	return host
}

func noticeState(g board.MemberGrant, now time.Time) string {
	if g.RevokedAt != nil {
		return "revoked"
	}
	if t, err := time.Parse(time.RFC3339, g.ExpiresAt); err == nil && !t.After(now) {
		return "expired"
	}
	return "live"
}

// RelayedGrantNotices answers GET /api/relayed-grant-notices[?state=live|all].
func (h *BoardHandler) RelayedGrantNotices(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) || !humanInputCaller(r) {
		errForbidden(w, "only the person at this computer reads who was given access")
		return
	}
	liveOnly := false
	switch r.URL.Query().Get("state") {
	case "", "all":
	case "live":
		liveOnly = true
	default:
		errBadRequest(w, `state is "live" or "all"`)
		return
	}
	now := time.Now()
	gs, err := h.bs.MemberGrantNotices(r.Context(), now.AddDate(0, 0, -noticeDays), now, liveOnly, noticeMaxRows)
	if err != nil {
		errInternalServer(w, "could not read who has access")
		return
	}
	rows := make([]noticeRow, 0, len(gs))
	for _, g := range gs {
		if g.Level == board.MemberLevelFull && !board.MemberFullOpen {
			continue // a full grant is not offered while its gate is shut
		}
		row := noticeRow{GrantID: g.GrantID, State: noticeState(g, now), Level: g.Level, Person: capRunes(board.CleanMemberLabel(g.Label), 40), HubUser: g.HubUser, LinkID: g.LinkID,
			SignedBy: shortKID(g.SignedBy), Via: "here", CreatedAt: g.CreatedAt, ExpiresAt: g.ExpiresAt, RevokedAt: g.RevokedAt, RevokedBy: g.RevokedBy}
		if g.ViaHub {
			row.Via = "hub"
		}
		if g.BoardID != "" {
			row.Team = noticeTeam{ID: g.BoardID}
			if b, err := h.bs.GetBoard(r.Context(), g.BoardID); err == nil {
				row.Team.Name = capRunes(board.CleanMemberLabel(b.Label), 60)
			}
		}
		if noticeHub != nil {
			if o := noticeHub(r.Context(), g.LinkID); o != "" {
				row.Hub = hubHost(o)
			}
		}
		if noticeDevice != nil {
			row.Device = capRunes(board.CleanMemberLabel(noticeDevice(r.Context(), g.SignedBy)), 40)
		}
		rows = append(rows, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"notices": rows, "total": len(rows)})
}

// RevokeRelayedGrantNotice answers POST /api/relayed-grant-notices/{id}/revoke: ends the access at once, here. A grant already ended answers the same 200; an unknown or malformed id is one 404.
func (h *BoardHandler) RevokeRelayedGrantNotice(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) || !humanInputCaller(r) {
		errForbidden(w, "only the person at this computer ends someone's access from this list")
		return
	}
	id := urlParam(r, "id")
	g, err := h.bs.MemberGrantByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, board.ErrNoMemberGrant) {
			errNotFound(w, "no one has that access here")
			return
		}
		errInternalServer(w, "could not end the access")
		return
	}
	state := noticeState(*g, time.Now())
	if state == "live" {
		g, err = h.bs.RevokeMemberGrantBy(r.Context(), id, time.Now(), board.MemberRevokedHere)
		if err != nil && !errors.Is(err, board.ErrNoMemberGrant) {
			errInternalServer(w, "could not end the access")
			return
		}
		if g != nil {
			recordHubOwnerAction(r.Context(), h.bs, hubOwnerRequest(r), r.Method, "revoked at this computer grant="+id+" level="+g.Level+" scope="+g.ScopeKind, g.BoardID, http.StatusOK)
			if g.BoardID != "" {
				if _, perr := h.bs.PostHubNotice(r.Context(), g.BoardID, "Access for "+capRunes(board.CleanMemberLabel(g.Label), 40)+" ("+g.HubUser+") was ended at this computer."); perr != nil {
					slogWarnNotice(perr)
				}
			}
		}
		state = "revoked"
	}
	writeJSON(w, http.StatusOK, map[string]string{"grant_id": id, "state": state})
}
