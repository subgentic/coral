package routes

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The Hub's service-only per-machine read (#7364, the #7331 note sections 6, 11 point 4 and 12): GET /api/goal-links?request_id=<id>. Coral Hub shows the tasks another team made for a goal request, and
// only the Hub does: no local Coral reads another machine's rows. It answers the stream Coral Hub's own SERVICE stamped (tunnel/hubservice.go: authentic connector stamp, the service flag, and the server
// and board the request was sent from) and nobody else: an owner, a viewer, an agent and a local program all get 403 service_only. The asker comes from the stamp, never from the query.

// goalLinksMaxRequestID bounds the request id in the query (the ids Coral makes are 32 hex digits).
const goalLinksMaxRequestID = 128

// serviceAsker is who the Hub's service says the read is for, when the request is a stream the connector really stamped for the service.
func serviceAsker(r *http.Request) (tunnel.HubAsker, bool) {
	if !cloud.TunneledAuthentic(r) || r.Header.Get(tunnel.HubServiceHeader) != "1" {
		return tunnel.HubAsker{}, false
	}
	a := tunnel.HubAsker{Server: r.Header.Get(tunnel.HubAskServerHeader), Board: r.Header.Get(tunnel.HubAskBoardHeader)}
	return a, tunnel.ValidHubAsker(a)
}

// GoalLinks: GET /api/goal-links?request_id=<id>[&cursor=<c>].
func (h *BoardHandler) GoalLinks(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	asker, ok := serviceAsker(r)
	if !ok {
		writeError(w, http.StatusForbidden, "service_only", "this read is for Coral Hub's own service")
		return
	}
	requestID, cursor, ok := goalLinksQuery(r)
	if !ok {
		errBadRequest(w, "the query is exactly one request_id, and a cursor from a previous page")
		return
	}
	red := requestRedactor(r)
	page, err := h.bs.GoalLinks(r.Context(), requestID, asker.Server, asker.Board, cursor, func(s string) string {
		if out, rerr := red.Text([]byte(s)); rerr == nil {
			return string(out)
		}
		return "(a title that could not be checked for secrets)"
	})
	if err != nil {
		if errors.Is(err, board.ErrBadGoalLinksQuery) {
			errBadRequest(w, "that cursor is not one this server gave for this request")
			return
		}
		errInternalServer(w, "could not read the links")
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// goalLinksQuery reads the query: exactly one non-empty request_id (at most goalLinksMaxRequestID bytes, valid text with no control character) and at most one non-empty cursor; any other
// parameter, a repeated one, or a key in another case is not a query this read answers.
func goalLinksQuery(r *http.Request) (requestID, cursor string, ok bool) {
	q := r.URL.Query()
	for k, v := range q {
		if (k != "request_id" && k != "cursor") || len(v) != 1 {
			return "", "", false
		}
	}
	requestID = q.Get("request_id")
	cursor = q.Get("cursor")
	if _, has := q["cursor"]; has && cursor == "" {
		return "", "", false
	}
	if requestID == "" || len(requestID) > goalLinksMaxRequestID || !utf8.ValidString(requestID) || strings.ContainsFunc(requestID, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return "", "", false
	}
	return requestID, cursor, true
}
