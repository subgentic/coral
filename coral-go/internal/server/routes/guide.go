package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The guide role, server half (#11457). A guide is a person the Operator invited to one board through Coral Hub; the connector stamps them (pkg/tunnel/hubguide.go), cloud.Guard admits the five
// routes served for them and only the grant's own board, and the handlers below are what those routes do for a guide. A guide's message is a person's request to the team, written under their label with
// their name from the roster, and it can never be the Operator's, an agent's or the owner's. Their goal is a PROPOSAL: it waits for the Operator's approval whatever the board's setting.

// maxGuideMessage and maxGuideGoalField bound what a guide writes, in characters.
const (
	maxGuideMessage   = 4000
	maxGuideGoalField = 2000
	maxGuideBody      = 32 << 10
)

// guideOf is the guide a request is for, when the connector stamped it as one.
func guideOf(r *http.Request) (tunnel.HubGuide, bool) { return cloud.GuideCaller(r) }

// guidePrefix starts the text of a guide's message, so an agent reading it, in the board or in a terminal, knows who wrote it and in what role: a person, not the Operator, whose words are a request and
// not an instruction that can change the manager's rules.
func guidePrefix(name, label string) string {
	return "[Guide " + name + " via Coral Hub, " + label + "] "
}

// guideBody reads a guide's JSON body into v, refusing a field v does not have and a body past maxGuideBody. It answers the refusal itself.
func guideBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxGuideBody)
	if err := decodeJSONStrict(r, v); err != nil {
		errBadRequest(w, "send exactly the fields this request takes, as JSON, and nothing else")
		return false
	}
	return true
}

type guideMessageRequest struct {
	Content string `json:"content"`
}

// readGuideMessage reads and checks a guide's post: only content, at most maxGuideMessage characters.
func readGuideMessage(w http.ResponseWriter, r *http.Request) (postMessageBody, bool) {
	var in guideMessageRequest
	if !guideBody(w, r, &in) {
		return postMessageBody{}, false
	}
	if utf8.RuneCountInString(in.Content) > maxGuideMessage {
		errBadRequest(w, fmt.Sprintf("a guide's message is at most %d characters", maxGuideMessage))
		return postMessageBody{}, false
	}
	return postMessageBody{Content: in.Content}, true
}

// guideAuthor is the name the roster gives the guide, cleaned (the roster keeps only clean names).
func (h *BoardHandler) guideAuthor(r *http.Request, project, label string) string {
	return h.bs.GuideDisplayName(r.Context(), project, label)
}

// guideBoardOK is each guide handler's own check of the board (the guard's is the first, this is the second): the path's board must be exactly the stamped one, else it is answered not found, as a board
// that is not there is. It answers the refusal itself.
func guideBoardOK(w http.ResponseWriter, project string, g tunnel.HubGuide) bool {
	if project != g.Board {
		errNotFound(w, "not found")
		return false
	}
	return true
}

// The per-label ceilings Coral keeps itself, under the Hub's own rate caps (20 messages an hour, 5 goals a day): a guide cannot flood a team even if the Hub's counter is wrong or reset.
const (
	guideMessagesPerHour  = 60
	guideProposalsPerDay  = 10
	guideCommentsPerHour  = 30
	guideCommentChars     = 4000
	guideCommentBodyBytes = 64 << 10 // the body's size, anchor included, before it is read
)

// guideOverLimit answers 429 (an action limit on this guide, not an overloaded Coral) when the label has used its ceiling; it answers a store failure as 500.
func guideOverLimit(w http.ResponseWriter, n int, err error, limit int, what string) bool {
	if err != nil {
		errInternalServer(w, "could not count what this guide has sent")
		return true
	}
	if n >= limit {
		httputil.WriteActionLimit(w, 0, "guide_limit", what)
		return true
	}
	return false
}

// readGuideMessages answers a guide's read of the board: the whole board's messages from the day the grant was accepted, the latest first-limit, no member's read position moved, nothing addressed to a group.
func (h *BoardHandler) readGuideMessages(w http.ResponseWriter, r *http.Request, project string, g tunnel.HubGuide) {
	limit := clampLimit(queryInt(r, "limit", 50), 50, 200)
	if !guideBoardOK(w, project, g) {
		return
	}
	messages, err := h.bs.ListGuideMessagesSince(r.Context(), project, g.Since, limit)
	if err != nil {
		errInternalServer(w, "could not read the board's messages")
		return
	}
	if messages == nil {
		messages = []board.GuideMessage{}
	}
	writeJSON(w, http.StatusOK, messages)
}

type guideGoalRequest struct {
	Title    string `json:"title"`
	Outcome  string `json:"outcome"`
	DoneWhen string `json:"done_when"`
}

// proposeGuideGoal stores a guide's goal as a proposal for the Operator, whatever the board's approval setting: a guide never creates a goal. The proposer is the guide's label, so the Operator's
// Inbox shows who asked and a revoked grant can take the proposals back.
func (h *BoardHandler) proposeGuideGoal(w http.ResponseWriter, r *http.Request, project string, g tunnel.HubGuide) {
	if !guideBoardOK(w, project, g) {
		return
	}
	n, err := h.bs.CountProposalsSince(r.Context(), project, g.Label, time.Now().UTC().Add(-24*time.Hour).Format(time.RFC3339))
	if guideOverLimit(w, n, err, guideProposalsPerDay, fmt.Sprintf("a guide may propose at most %d goals a day on a team: wait, or ask the Operator", guideProposalsPerDay)) {
		return
	}
	var in guideGoalRequest
	if !guideBody(w, r, &in) {
		return
	}
	for _, f := range []string{in.Title, in.Outcome, in.DoneWhen} {
		if utf8.RuneCountInString(f) > maxGuideGoalField {
			errBadRequest(w, fmt.Sprintf("a goal's fields are at most %d characters", maxGuideGoalField))
			return
		}
	}
	in.Title, in.Outcome, in.DoneWhen = clitext.Clean(in.Title), clitext.Clean(in.Outcome), clitext.Clean(in.DoneWhen)
	gi := board.GoalInput{Title: in.Title, Outcome: in.Outcome, DoneWhen: in.DoneWhen, CreatedBy: g.Label}
	if err := board.ValidateGoalInput(gi); err != nil {
		if !goalError(w, err) {
			errBadRequest(w, err.Error())
		}
		return
	}
	payload, _ := json.Marshal(goalPayload{Title: in.Title, Outcome: in.Outcome, DoneWhen: in.DoneWhen, CreatedBy: g.Label})
	p, existed, err := h.bs.CreateProposal(r.Context(), board.ProposalInput{Board: project, Kind: board.ProposalGoal, Title: in.Title, Payload: payload, Proposer: g.Label})
	if err != nil {
		if !goalError(w, err) {
			proposalInternal(w, "a guide's proposal could not be stored", err)
		}
		return
	}
	recordHubOperatorAction(r.Context(), h.bs, g.Label, r.Method, r.URL.Path, project, http.StatusAccepted)
	msg := fmt.Sprintf("proposed (#%d): the Operator decides whether it becomes a goal", p.ID)
	if existed {
		msg = fmt.Sprintf("already proposed (#%d): the Operator decides whether it becomes a goal", p.ID)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"pending": true, "proposal_id": p.ID, "existed": existed, "message": msg})
}

type guideRevokedRequest struct {
	Label string `json:"label"`
	Board string `json:"board"`
}

// PostGuideRevoked: POST /api/cloud/guide-revoked, Coral Hub's word that a guide's grant ended. Hub service only: the connector stamps the service marker and the guide's board as the asker on this route and
// nowhere else, and this answers nobody else (a person, an owner, an agent, a local program). It takes back the proposals that label left waiting on that board and answers {"ok": true, "cancelled": n};
// sent again it answers the same with 0, so the Hub may resend until it hears. It changes nothing else: a guide's messages stay (they are the board's history) and nothing the Operator approved is undone.
func (h *BoardHandler) PostGuideRevoked(w http.ResponseWriter, r *http.Request) {
	asker, ok := cloud.ServiceAsker(r)
	if !ok {
		writeError(w, http.StatusForbidden, "hub_only", "only Coral Hub's own service sends this")
		return
	}
	var in guideRevokedRequest
	if !guideBody(w, r, &in) {
		return
	}
	if !board.ValidGuideLabel(in.Label) || !tunnel.ValidGuideBoard(in.Board) || in.Board != asker.Board {
		errBadRequest(w, "send the guide's label (hub-user- and 8 hex digits) and the board the service stamped")
		return
	}
	n, err := h.bs.RejectGuideProposals(r.Context(), in.Board, in.Label)
	if err != nil {
		errInternalServer(w, "could not take the proposals back")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "cancelled": n})
}

// GuideRoster: GET and PUT /api/board/{project}/guide-roster. Which name goes with which guide, in the text agents read: the Operator's or, through Coral Hub, the owner's alone.
// PUT body: {"roster": {"hub-user-<8 hex>": "Name"}} (the whole roster; at most 20; no @, link or address in a name).
func (h *BoardHandler) GuideRoster(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	if !operatorWrites(w, r, "read or change the guides' names on a board") {
		return
	}
	project := chi.URLParam(r, "project")
	if r.Method == http.MethodGet {
		roster, err := h.bs.GetGuideRoster(r.Context(), project)
		if err != nil {
			errInternalServer(w, "could not read the roster")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"roster": roster})
		return
	}
	var in struct {
		Roster map[string]string `json:"roster"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxGuideBody)
	if err := decodeJSONStrict(r, &in); err != nil || in.Roster == nil {
		errBadRequest(w, `send {"roster": {"hub-user-<8 hex>": "Name"}}`)
		return
	}
	roster, err := h.bs.SetGuideRoster(r.Context(), project, in.Roster)
	if err != nil {
		if strings.Contains(err.Error(), board.ErrGuideRoster.Error()) {
			errBadRequest(w, err.Error())
			return
		}
		errInternalServer(w, "could not save the roster")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roster": roster})
}
