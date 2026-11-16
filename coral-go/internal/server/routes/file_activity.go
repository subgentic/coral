package routes

import (
	"context"
	"net/http"
	"path/filepath"

	"github.com/subgentic/coral/internal/board"
)

// recordFileActivity writes the Activity row of something that happened to a file that the Operator would otherwise not see in the record (#17360): their own comment, an agent's reply in the thread, an agent's
// new version. The file's name is the title and the words are the note (a comment is redacted and cut as every note is), so the row is found by searching the comment's words. An agent's row names the agent
// (actor "agent:<name>", and the asker the page reads). Best effort, as every row is: nothing here fails the request.
func (h *SessionsHandler) recordFileActivity(r *http.Request, action, team, fileID, fileName, agent, note string) {
	if h.bs == nil {
		return
	}
	m := activityMetaFor(r, fileName, note)
	if agent != "" {
		m.Actor, m.Source, m.Hint, m.Surface = "agent:"+agent, "local", "", ""
		m.Asker = agent
	}
	_ = h.bs.RecordActivity(context.WithoutCancel(r.Context()), m, action, "file", fileID, "", team)
}

// recordCommentActivity is recordFileActivity for a new comment: the person's own is file_comment, an agent's is file_reply; a Hub viewer's or a guide's is not the Operator's record.
func (h *SessionsHandler) recordCommentActivity(r *http.Request, caller commentCaller, artifactID, team, body string) {
	name := ""
	if m, ok := readSidecar(filepath.Join(h.cfg.CoralDir(), "artifacts", "objects", artifactID+".json")); ok {
		name = m.Name
	}
	switch caller.Kind {
	case commentCallerOwner:
		h.recordFileActivity(r, board.ActFileComment, team, artifactID, name, "", body)
	case commentCallerAgent:
		h.recordFileActivity(r, board.ActFileReply, team, artifactID, name, caller.Name, body)
	}
}

// withName is the caller with the name the thread shows for it (an agent's label), for the row's words.
func (c commentCaller) withName(name string) commentCaller {
	c.Name = name
	return c
}
