package routes

import (
	"context"

	"github.com/subgentic/coral/internal/logparse"
	"github.com/subgentic/coral/internal/store"
)

// LiveSessionLookup returns the lookup BoardHandler.SetLiveSessionLookup takes: a live
// session's agent type by its session id.
func LiveSessionLookup(ss *store.SessionStore) func(ctx context.Context, sessionID string) (string, bool, error) {
	return func(ctx context.Context, sessionID string) (string, bool, error) {
		ls, err := ss.GetLiveSession(ctx, sessionID)
		if err != nil || ls == nil {
			return "", false, err
		}
		return ls.AgentType, true, nil
	}
}

// SessionThinkingLookup returns the lookup BoardHandler.SetSessionThinkingLookup takes: the thinking level the live session behind a board session name is set to, "" for none or for a name
// that is not a live session (#8915).
func SessionThinkingLookup(ss *store.SessionStore) func(ctx context.Context, sessionName string) string {
	return func(ctx context.Context, sessionName string) string {
		_, sid := logparse.ParseSessionName(sessionName)
		if sid == "" {
			return ""
		}
		ls, err := ss.GetLiveSession(ctx, sid)
		if err != nil || ls == nil || ls.Thinking == nil {
			return ""
		}
		return *ls.Thinking
	}
}

// ArchivedSessionLookup returns the lookup BoardHandler.SetArchivedSessionLookup
// takes: whether a board session name (agentType-sessionID) belongs to an
// archived agent. A name that is not a session, or a lookup error, is "not
// archived": the board then behaves as before.
func ArchivedSessionLookup(ss *store.SessionStore) func(ctx context.Context, sessionName string) bool {
	return func(ctx context.Context, sessionName string) bool {
		_, sid := logparse.ParseSessionName(sessionName)
		if sid == "" {
			return false
		}
		archived, err := ss.IsSessionArchived(ctx, sid)
		return err == nil && archived
	}
}
