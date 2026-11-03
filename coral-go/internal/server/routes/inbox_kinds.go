package routes

import (
	"context"
	"net/http"

	"github.com/subgentic/coral/internal/board"
)

// SetInboxSettings tells the board where to read the settings of what reaches Needs you (#12144). nil: every kind on, every team included.
func (h *BoardHandler) SetInboxSettings(fn func(ctx context.Context) (map[string]string, error)) {
	h.inboxSettings = fn
}

// inboxPrefs is what the Operator chose to reach Needs you, read now. A read that fails is the default (nothing muted): a failure never hides a file.
func (h *BoardHandler) inboxPrefs(ctx context.Context) inboxPrefs {
	if h.inboxSettings == nil {
		return readInboxPrefs(nil)
	}
	st, err := h.inboxSettings(ctx)
	if err != nil {
		return readInboxPrefs(nil)
	}
	return readInboxPrefs(st)
}

// attachArtifactKinds puts Kind and Muted on the rows of the files the Operator's settings speak of. It is the Operator's alone, as the comments are: a list an agent or a Coral Hub guest reads has neither,
// so no agent learns what is muted. A row not tagged for review is never muted: the switches are for what waits for the Operator. A read that fails leaves the rows as they are (nothing muted).
func (h *BoardHandler) attachArtifactKinds(r *http.Request, project string, items []teamArtifact) {
	if len(items) == 0 || !operatorOrKeyCaller(r) {
		return
	}
	ctx := r.Context()
	kinds, err := h.bs.ArtifactKindsOf(ctx, project)
	if err != nil {
		return
	}
	prefs := h.inboxPrefs(ctx)
	for i := range items {
		if items[i].managed == "" {
			continue
		}
		kind := kinds[items[i].managed]
		if kind != "" && kind != board.KindFile {
			items[i].Kind = kind
		}
		if prefs.muted(project, kind) {
			items[i].Muted = true
		}
	}
}

// kindOrFile is a row's kind, with the plain file's empty kind named.
func kindOrFile(k string) string {
	if k == "" {
		return board.KindFile
	}
	return k
}
