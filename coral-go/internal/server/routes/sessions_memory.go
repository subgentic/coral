package routes

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/agentmemory"
	"github.com/subgentic/coral/internal/safefs"
)

// An agent's instruction and memory files (#7454, the design of #7452): which files its CLI reads (CLAUDE.md, AGENTS.md, the CLI's own memory), and one of them as text. Read-only, the Operator's alone (an
// agent's token is refused: operatorOnlyRoutes) and never through Coral Hub (the tunnel table has no row for them: Never).
//
// The page never builds a path. The list route finds the files itself (internal/agentmemory: the agent's own folders, nothing from the request) and issues an OPAQUE id for each; the read route takes only
// such an id, looks it up here, and reads that one file again through its folder held open (safefs: a regular file, never through a link). An id is bound to the session it was issued for, is random, and
// is forgotten after memoryIDTTL or when the table is full.

const (
	memoryIDTTL = time.Hour
	memoryIDMax = 2048
)

var memoryIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

type memoryIssued struct {
	file      agentmemory.File
	sessionID string
	at        time.Time
}

// memoryIDs is the table of ids issued by the list route.
type memoryIDs struct {
	mu    sync.Mutex
	m     map[string]memoryIssued
	order []string // oldest first
	now   func() time.Time
}

func (t *memoryIDs) clock() time.Time {
	if t.now != nil {
		return t.now()
	}
	return time.Now()
}

// issue gives f an id for sessionID.
func (t *memoryIDs) issue(sessionID string, f agentmemory.File) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	id := hex.EncodeToString(b[:])
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.m == nil {
		t.m = map[string]memoryIssued{}
	}
	for len(t.order) >= memoryIDMax {
		delete(t.m, t.order[0])
		t.order = t.order[1:]
	}
	t.m[id] = memoryIssued{file: f, sessionID: sessionID, at: t.clock()}
	t.order = append(t.order, id)
	return id
}

// lookup is the file id was issued for, when it was issued for sessionID and has not expired.
func (t *memoryIDs) lookup(sessionID, id string) (agentmemory.File, bool) {
	if !memoryIDRe.MatchString(id) {
		return agentmemory.File{}, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.m[id]
	if !ok || e.sessionID != sessionID || t.clock().Sub(e.at) > memoryIDTTL {
		return agentmemory.File{}, false
	}
	return e.file, true
}

// memoryRow is a file as the list shows it.
type memoryRow struct {
	ID       string `json:"id"`
	File     string `json:"file"`
	Kind     string `json:"kind"`
	Level    string `json:"level"`
	Where    string `json:"where"`
	Modified string `json:"modified"`
	Size     int64  `json:"size"`
	Problem  string `json:"problem,omitempty"`
}

func rowOf(id string, f agentmemory.File) memoryRow {
	return memoryRow{ID: id, File: f.Name, Kind: f.Kind, Level: f.Level, Where: f.Where, Modified: f.Modified.UTC().Format(time.RFC3339), Size: f.Size, Problem: f.Problem}
}

// memorySession is the live session a memory request is about (session_id is required: the id of an agent), with its agent type and working folder.
func (h *SessionsHandler) memorySession(w http.ResponseWriter, r *http.Request) (sessionID, agentType, workdir string, ok bool) {
	name := chi.URLParam(r, "name")
	sessionID = r.URL.Query().Get("session_id")
	if sessionID == "" {
		errBadRequest(w, "session_id is required")
		return "", "", "", false
	}
	live, err := h.ss.GetLiveSession(r.Context(), sessionID)
	if err != nil || live == nil {
		errNotFound(w, "agent not found")
		return "", "", "", false
	}
	return sessionID, live.AgentType, h.resolveWorkdir(r.Context(), name, live.AgentType, sessionID), true
}

// ListMemory lists the instruction and memory files of an agent's CLI, nearest first, each with an opaque id.
// GET /api/sessions/live/{name}/memory?session_id=...  (Operator only; not through Coral Hub)
func (h *SessionsHandler) ListMemory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	sessionID, agentType, workdir, ok := h.memorySession(w, r)
	if !ok {
		return
	}
	home, _ := os.UserHomeDir()
	gitRoot := ""
	if workdir != "" {
		gitRoot = trustedGitRoot(r.Context(), workdir)
	}
	rows := []memoryRow{}
	for _, f := range agentmemory.Discover(agentType, workdir, gitRoot, home) {
		rows = append(rows, rowOf(h.memoryIDs.issue(sessionID, f), f))
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": rows})
}

// ReadMemory reads one file the list issued an id for, as text: at most agentmemory.MaxRead bytes (a larger file is cut and says so); a binary file says so and gives no text; a file that cannot be read gives
// its problem and no text. An id that is unknown, expired, another session's or not an id is 404, all alike.
// GET /api/sessions/live/{name}/memory/{id}?session_id=...  (Operator only; not through Coral Hub)
func (h *SessionsHandler) ReadMemory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		errBadRequest(w, "session_id is required")
		return
	}
	f, ok := h.memoryIDs.lookup(sessionID, chi.URLParam(r, "id"))
	if !ok {
		errNotFound(w, "file not found")
		return
	}
	row := rowOf(chi.URLParam(r, "id"), f)
	out := map[string]any{"id": row.ID, "file": row.File, "kind": row.Kind, "level": row.Level, "where": row.Where, "modified": row.Modified, "size": row.Size}
	c, err := f.Read()
	switch {
	case errors.Is(err, agentmemory.ErrGone):
		errNotFound(w, "file not found")
		return
	case errors.Is(err, safefs.ErrNotRegular):
		out["problem"] = agentmemory.ProblemLink
		if f.Problem != "" {
			out["problem"] = f.Problem
		}
	case err != nil:
		out["problem"] = agentmemory.ProblemUnreadable
	default:
		out["size"], out["text"], out["truncated"], out["binary"] = c.Size, c.Text, c.Truncated, c.Binary
	}
	writeJSON(w, http.StatusOK, out)
}
