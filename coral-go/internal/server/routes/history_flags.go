package routes

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/store"
)

// SetChatFlags changes mailbox flags, independently of the live agent's archive/sleep state.
// Local Operator or machine credential only; the connector classifies this route Never.
func (h *HistoryHandler) SetChatFlags(w http.ResponseWriter, r *http.Request) {
	if refuseUnlessOperator(w, r, "change a chat's mailbox flags") {
		return
	}
	var body struct {
		Starred  *bool `json:"starred"`
		Archived *bool `json:"archived"`
	}
	if err := decodeJSONStrict(r, &body); err != nil {
		errBadRequest(w, "starred and archived must be booleans")
		return
	}
	if body.Starred == nil && body.Archived == nil {
		errBadRequest(w, "supply starred or archived")
		return
	}
	// chi hands the id over as it was sent: the dashboard encodes it, so "board:team" arrives as "board%3Ateam"
	id, err := url.PathUnescape(chi.URLParam(r, "sessionID"))
	if err != nil {
		errBadRequest(w, "the chat id is not valid")
		return
	}
	exists := false
	if board, ok := strings.CutPrefix(id, "board:"); ok {
		if h.bs != nil {
			projects, err := h.bs.ListProjects(r.Context())
			if err != nil {
				errInternalServer(w, "could not read chats")
				return
			}
			for _, p := range projects {
				if p.Project == board {
					exists = true
					break
				}
			}
		}
	} else {
		item, err := h.ss.GetIndexedSession(r.Context(), id)
		if err != nil {
			errInternalServer(w, "could not read chat")
			return
		}
		exists = item != nil
	}
	if !exists {
		errNotFound(w, "chat not found")
		return
	}
	if err := h.ss.UpdateChatFlags(r.Context(), id, body.Starred, body.Archived); err != nil {
		errInternalServer(w, "could not save chat flags")
		return
	}
	if body.Archived != nil && !*body.Archived { // Unarchive on a chat whose agent is archived puts the agent back in the sidebar too: the two lists are one answer (#10086); no live session is a no-op
		if err := h.ss.SetSessionArchived(r.Context(), id, false); err != nil {
			errInternalServer(w, "could not unarchive the agent")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ChatCounts returns the whole mailbox's chat counts, not a page or a separate query per folder.
func (h *HistoryHandler) ChatCounts(w http.ResponseWriter, r *http.Request) {
	if refuseUnlessOperator(w, r, "read chat folder counts") {
		return
	}
	boards := []string{}
	if h.bs != nil {
		projects, err := h.bs.ListProjects(r.Context())
		if err != nil {
			errInternalServer(w, "could not read chats")
			return
		}
		for _, p := range projects {
			boards = append(boards, p.Project)
		}
	}
	counts, err := h.ss.CountChatFolders(r.Context(), boards)
	if err != nil {
		errInternalServer(w, "could not count chats")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, counts)
}

func (h *HistoryHandler) filterBoardChatRows(r *http.Request, rows []map[string]any, params store.SessionListParams, chatType string) ([]map[string]any, error) {
	ids := make([]string, len(rows))
	for i, row := range rows {
		ids[i] = strings.TrimPrefix(row["session_id"].(string), "board:")
	}
	flags, err := h.ss.ChatFlagsForBoards(r.Context(), ids)
	if err != nil {
		return nil, err
	}
	out := rows[:0]
	for i, row := range rows {
		f := flags[ids[i]]
		if skipBoardChat(f, params, chatType) {
			continue
		}
		row["starred"], row["archived"], row["active"] = f.Starred, f.Archived, f.Active
		out = append(out, row)
	}
	return out, nil
}

// skipBoardChat is whether a board is left out of a list. Active now and Archived are the agent chats' folders: a list of
// both kinds (no type) holds no board under either; the Group chats list (type=group) holds every board, an archived one
// flagged archived, so it stays reachable. Without either, a list of both kinds shows only the boards that are not archived.
func skipBoardChat(f store.ChatFlags, params store.SessionListParams, chatType string) bool {
	if params.WithNotes || params.Starred && !f.Starred || params.Active && !f.Active {
		return true
	}
	if chatType == "group" {
		return false
	}
	return params.Archived || params.Active || f.Archived
}

// Preserve the empty-install response without dropping group-only histories.
func (h *HistoryHandler) noBoardChats(r *http.Request) bool {
	if h.bs == nil {
		return true
	}
	projects, err := h.bs.ListProjects(r.Context())
	return err == nil && len(projects) == 0
}
