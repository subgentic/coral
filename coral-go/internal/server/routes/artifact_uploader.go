package routes

// Who made an artifact, recorded when it is uploaded (#5575, the owner's Artifacts tab in Coral Hub): the upload record of a session names the board the agent was on, the agent's name and its
// role at that moment. Older records have none of these (the list says "unknown"); the name and role can change later, so what was true at upload is kept, not looked up again.

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// uploaderLookup says which board, name and role a session has; nil (a test, or a server with no store) records none. It is set once at startup (SetUploaderLookup).
var uploaderLookup func(ctx context.Context, sessionID string) (boardID, name, role string)

// SetUploaderLookup gives the upload paths the lookup of a session's board, name and role.
func SetUploaderLookup(fn func(ctx context.Context, sessionID string) (boardID, name, role string)) {
	uploaderLookup = fn
}

// NewUploaderLookup is the server's lookup: the live session's display name (else its agent name) and board, and the role of its subscription on that board.
func NewUploaderLookup(ss *store.SessionStore, bs *board.Store) func(ctx context.Context, sessionID string) (string, string, string) {
	return func(ctx context.Context, sessionID string) (boardID, name, role string) {
		if ss == nil {
			return "", "", ""
		}
		ls, err := ss.GetLiveSession(ctx, sessionID)
		if err != nil || ls == nil {
			return "", "", ""
		}
		name = ls.AgentName
		if ls.DisplayName != nil && *ls.DisplayName != "" {
			name = *ls.DisplayName
		}
		if ls.BoardName != nil {
			boardID = *ls.BoardName
		}
		if bs != nil {
			if sub, err := bs.GetSubscriptionBySessionName(ctx, naming.SessionName(ls.AgentType, sessionID)); err == nil && sub != nil {
				role = sub.JobTitle
				if boardID == "" {
					boardID = sub.Project
				}
			}
		}
		return boardID, name, role
	}
}

// uploaderTeamCheck is the checked form of the lookup for the one decision that must not guess (#13527): which team a session is on, with a real error when it cannot be told (the store is busy or closed), so
// "no team" is never read off a failed lookup. nil (a test, a server with no store) falls back to uploaderOf, which has no error to give.
var uploaderTeamCheck func(ctx context.Context, sessionID string) (team string, err error)

// SetUploaderTeamCheck gives the upload paths the checked lookup of a session's team.
func SetUploaderTeamCheck(fn func(ctx context.Context, sessionID string) (string, error)) {
	uploaderTeamCheck = fn
}

// NewUploaderTeamCheck is the server's checked lookup: the live session's board, else the board of its subscription; a session the store has no row of is on no team, and any other store error is an error.
func NewUploaderTeamCheck(ss *store.SessionStore, bs *board.Store) func(ctx context.Context, sessionID string) (string, error) {
	return func(ctx context.Context, sessionID string) (string, error) {
		if ss == nil {
			return "", nil
		}
		ls, err := ss.GetLiveSession(ctx, sessionID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
		if ls == nil {
			return "", nil
		}
		if ls.BoardName != nil && *ls.BoardName != "" {
			return *ls.BoardName, nil
		}
		if bs != nil {
			sub, err := bs.GetSubscriptionBySessionName(ctx, naming.SessionName(ls.AgentType, sessionID))
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return "", err
			}
			if sub != nil {
				return sub.Project, nil
			}
		}
		return "", nil
	}
}

// uploaderTeamChecked is the team of the session making an upload, or the error that stopped it being told. With no checked lookup it is uploaderOf's answer and no error.
func uploaderTeamChecked(sessionID string) (string, error) {
	if uploaderTeamCheck == nil || sessionID == "" {
		b, _, _ := uploaderOf(sessionID)
		return b, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	b, err := uploaderTeamCheck(ctx, sessionID)
	if err != nil {
		return "", err
	}
	if !board.ValidLabel(b, uploaderLabelMax) {
		return "", nil
	}
	return b, nil
}

// uploaderLabelMax bounds each recorded label; one that is longer or holds a control or formatting character is dropped, never stored.
const uploaderLabelMax = 160

// uploaderOf is what the record of an upload by sessionID says about who made it. It never waits long and never fails the upload: no answer is no fields.
func uploaderOf(sessionID string) (boardID, name, role string) {
	if uploaderLookup == nil || sessionID == "" {
		return "", "", ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	b, n, r := uploaderLookup(ctx, sessionID)
	clean := func(s string) string {
		if !board.ValidLabel(s, uploaderLabelMax) {
			return ""
		}
		return s
	}
	return clean(b), clean(n), clean(r)
}

// newUploadRecord is the record of an upload by sessionID of the object described by meta, made now.
func newUploadRecord(meta agentArtifactMeta, sessionID, uploadedBy, source string) agentUploadRecord {
	b, n, r := uploaderOf(sessionID)
	rec := agentUploadRecord{agentArtifactMeta: meta, CreatedAt: time.Now().UTC().Format(time.RFC3339), UploadedBy: uploadedBy, Source: source, Board: b, Uploader: n, Role: r}
	owner := recordOwnerOf(sessionID, uploadedBy)
	rec.OwnerKind, rec.OwnerID = owner.Kind, owner.ID
	return rec
}

// recordOwnerOf is who owns an upload (#5577): the owner of the team the session was LAUNCHED onto (the launch path's board, never a subscription the agent made itself). An image the person
// pastes or attaches in the dashboard belongs to the team of the agent it is for, not to the person: the machine owner reads it anyway, and the agent it was pasted to must be able to.
// A session that cannot be placed is the machine owner's (the record then reads as legacy).
func recordOwnerOf(sessionID, uploadedBy string) artifactPrincipal {
	if sessionID == "" {
		return operatorPrincipal
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	owner, _, err := circleOf(ctx, sessionID)
	if err != nil {
		return operatorPrincipal
	}
	return owner
}
