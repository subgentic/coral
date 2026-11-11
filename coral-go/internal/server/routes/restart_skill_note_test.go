package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// #15484 (#15464 finding 2): the skills launch note is part of the stored prompt, so a person who rewrote the Instructions in Restart with changes lost it (the agent's first turn was 5,722 characters, not 6,342).
// The note is told again at the restart, from the skills attached to the agent, after the new Instructions, and never twice: Instructions that still carry it, and a restart that sends none, are as they were.

const skillNoteMarker = "Skills the Operator approved for this work."

func restartWithPrompt(t *testing.T, id string, attach bool, stored, sent string) (string, store.LiveSession, *store.SessionStore) {
	t.Helper()
	server, _, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	name := "claude-" + id
	term.addSession(name, t.TempDir())
	var rows []store.SkillRow
	if attach {
		rows = []store.SkillRow{approvedSkill(t, ss, "release-notes", "Writes release notes from merged PRs.", 1)}
		require.NoError(t, ss.AttachSkills(ctx, id, rows))
	}
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "coral-go", Prompt: ptr.NonEmpty(withSkillNote(stored, launchSkillNote(rows)))}))
	body := map[string]any{"session_id": id}
	if sent != "" {
		body["prompt"] = sent
	}
	b, _ := json.Marshal(body)
	resp, err := http.Post(server.URL+"/api/sessions/live/"+name+"/restart", "application/json", bytes.NewBuffer(b))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var out struct {
		SessionID string `json:"session_id"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	ls, err := ss.GetLiveSession(ctx, out.SessionID)
	require.NoError(t, err)
	require.NotNil(t, ls)
	return out.SessionID, *ls, ss
}

func TestRestartWithRewrittenInstructionsTellsTheAgentItsSkillsAgain(t *testing.T) {
	t.Parallel()
	_, ls, _ := restartWithPrompt(t, "note-rewrite", true, "Review the work.", "Only fix the bug in parser.go.")
	p := ptr.Value(ls.Prompt)
	assert.True(t, strings.HasPrefix(p, "Only fix the bug in parser.go."), "the person's Instructions come first: %q", p)
	assert.Equal(t, 1, strings.Count(p, skillNoteMarker), "the note is there once")
	assert.Contains(t, p, "release-notes", "and names the attached skill")
	assert.NotContains(t, p, "Review the work.", "the old Instructions are gone, as the person chose")
}

func TestRestartInstructionsThatStillCarryTheNoteGetNoSecondOne(t *testing.T) {
	t.Parallel()
	// the dialog prefills the stored prompt, note included; the person edits the first part only
	stored := withSkillNote("Review the work.", launchSkillNote([]store.SkillRow{{ID: "x", Name: "release-notes", Description: "Writes release notes from merged PRs."}}))
	edited := strings.Replace(stored, "Review the work.", "Review the work, then merge.", 1)
	_, ls, _ := restartWithPrompt(t, "note-kept", true, "Review the work.", edited)
	assert.Equal(t, 1, strings.Count(ptr.Value(ls.Prompt), skillNoteMarker), "Instructions that kept the note do not get it again")
}

func TestRestartWithNoNewInstructionsAndNoSkillsAreAsTheyWere(t *testing.T) {
	t.Parallel()
	_, ls, _ := restartWithPrompt(t, "note-same", true, "Review the work.", "")
	assert.Equal(t, 1, strings.Count(ptr.Value(ls.Prompt), skillNoteMarker), "the stored prompt already has it: once")
	_, ls2, _ := restartWithPrompt(t, "note-none", false, "Review the work.", "Do the other thing.")
	assert.Equal(t, "Do the other thing.", ptr.Value(ls2.Prompt), "no skill attached: no note")
}

func TestRestartKeepsTheSkillsAttachedToTheNewSession(t *testing.T) {
	t.Parallel()
	newID, _, ss := restartWithPrompt(t, "note-carry", true, "Review the work.", "")
	got, err := ss.AttachedSkills(context.Background(), newID)
	require.NoError(t, err)
	require.Len(t, got, 1, "the restarted agent lists the skill its note names")
	assert.Equal(t, "release-notes", got[0].Name)
}
