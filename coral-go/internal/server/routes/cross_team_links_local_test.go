package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #9893: the links between this computer's teams: the Operator's route and command, an entry on the target's list, both ways by default, files a grant of the link; recorded and counted
// while the list is not enforced, and the door's answer once it is.

func (e *attachEnv) call(method, path string, hdr map[string]string, body any) (int, map[string]any) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.url+path, rd)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(e.t, err)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func ends(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(map[string]any)["label"].(string))
	}
	return out
}

func TestLocalLinkRoutesLinkBothWaysByDefaultAndOneWayOnRequest(t *testing.T) {
	e := newAttachEnv(t, true)
	const links = "/api/board/alpha/cross-team-links"

	code, st := e.call("GET", links, opHdr, nil)
	require.Equal(t, http.StatusOK, code, "%v", st)
	assert.Empty(t, st["may_message_this_team"], "a team starts with no links")
	assert.Equal(t, false, st["enforced"], "and nothing is enforced")

	code, st = e.call("POST", links, opHdr, map[string]any{"with": "beta"})
	require.Equal(t, http.StatusOK, code, "%v", st)
	assert.Equal(t, []string{"beta"}, ends(st["may_message_this_team"]), "both ways: beta may message alpha")
	assert.Equal(t, []string{"beta"}, ends(st["this_team_may_message"]), "and alpha may message beta")
	assert.EqualValues(t, 2, st["changed"])
	a, _ := e.h.bs.GetBoardSettings(context.Background(), "alpha")
	b, _ := e.h.bs.GetBoardSettings(context.Background(), "beta")
	assert.True(t, a.AllowsSender(board.LocalServer, e.idOf("beta")))
	assert.True(t, b.AllowsSender(board.LocalServer, e.idOf("alpha")))
	assert.True(t, b.AllowsFilesFrom(board.LocalServer, e.idOf("alpha")), "files are on by default")
	logA, _ := e.h.bs.ListLog(context.Background(), "alpha")
	logB, _ := e.h.bs.ListLog(context.Background(), "beta")
	assert.NotEmpty(t, logA, "each edited team's list change is audited")
	assert.NotEmpty(t, logB)

	// asking again changes nothing
	_, st = e.call("POST", links, opHdr, map[string]any{"with": "beta"})
	assert.EqualValues(t, 0, st["changed"])

	// unlink one way: "alpha may message beta" goes, "beta may message alpha" stays
	code, st = e.call("DELETE", links, opHdr, map[string]any{"with": "beta", "both": false})
	require.Equal(t, http.StatusOK, code, "%v", st)
	b, _ = e.h.bs.GetBoardSettings(context.Background(), "beta")
	a, _ = e.h.bs.GetBoardSettings(context.Background(), "alpha")
	assert.False(t, b.AllowsSender(board.LocalServer, e.idOf("alpha")))
	assert.True(t, a.AllowsSender(board.LocalServer, e.idOf("beta")))

	// one way on request, files off
	code, _ = e.call("POST", links, opHdr, map[string]any{"with": "gamma", "both": false, "files": false})
	require.Equal(t, http.StatusOK, code)
	g, _ := e.h.bs.GetBoardSettings(context.Background(), "gamma")
	a, _ = e.h.bs.GetBoardSettings(context.Background(), "alpha")
	assert.True(t, g.AllowsSender(board.LocalServer, e.idOf("alpha")), "alpha may message gamma")
	assert.False(t, g.AllowsFilesFrom(board.LocalServer, e.idOf("alpha")), "with files off for the link")
	assert.False(t, a.AllowsSender(board.LocalServer, e.idOf("gamma")), "and gamma may not message alpha")

	// unlink both: everything of the pair goes
	_, _ = e.call("POST", links, opHdr, map[string]any{"with": "beta"})
	code, _ = e.call("DELETE", links, opHdr, map[string]any{"with": "beta"})
	require.Equal(t, http.StatusOK, code)
	a, _ = e.h.bs.GetBoardSettings(context.Background(), "alpha")
	b, _ = e.h.bs.GetBoardSettings(context.Background(), "beta")
	assert.False(t, a.AllowsSender(board.LocalServer, e.idOf("beta")))
	assert.False(t, b.AllowsSender(board.LocalServer, e.idOf("alpha")))
}

func TestLocalLinkRoutesAreTheOperatorsAloneAndCheckTheirInput(t *testing.T) {
	e := newAttachEnv(t, true)
	const links = "/api/board/alpha/cross-team-links"
	for _, m := range []string{"GET", "POST", "DELETE"} {
		code, _ := e.call(m, links, agentHdr(alphaOrchSID), map[string]any{"with": "beta"})
		assert.Equal(t, http.StatusForbidden, code, m+": an agent token (an Orchestrator's included) cannot read or change links")
		code, out := e.call(m, links, map[string]string{tunnel.ViaHeader: "x"}, map[string]any{"with": "beta"})
		assert.Equal(t, http.StatusForbidden, code, m+": nor Coral Hub")
		_ = out
	}
	a, _ := e.h.bs.GetBoardSettings(context.Background(), "alpha")
	assert.Empty(t, a.CrossTeamAllowed, "a refused edit changes nothing")

	for name, c := range map[string]struct {
		path string
		body any
		want int
	}{
		"no with":             {links, map[string]any{}, http.StatusBadRequest},
		"itself":              {links, map[string]any{"with": "alpha"}, http.StatusBadRequest},
		"a team that is not":  {links, map[string]any{"with": "nobody"}, http.StatusNotFound},
		"an unknown field":    {links, map[string]any{"with": "beta", "server": "x"}, http.StatusOK}, // decodeJSON is lenient on extras, as the board routes are
		"a team of the route": {"/api/board/nobody/cross-team-links", map[string]any{"with": "beta"}, http.StatusNotFound},
	} {
		code, out := e.call("POST", c.path, opHdr, c.body)
		assert.Equal(t, c.want, code, "%s: %v", name, out)
	}
}

// The point of the links: with the list in force an unlinked pair is refused and a linked one is admitted, one way as made; with it off nothing changes.
func TestLocalLinksAreWhatTheDoorChecksOnceTheListIsEnforced(t *testing.T) {
	e := newAttachEnv(t, true)
	var on atomic.Bool
	e.h.SetAllowlistFlag(func(context.Context) bool { return on.Load() })
	ctx := context.Background()
	for _, b := range []string{"alpha", "beta"} { // the switches are the owner's explicit on, which the same-computer door needs
		_, err := e.h.bs.UpdateBoardSettings(ctx, b, board.BoardSettingsUpdate{CrossTeamMessaging: ptrBool(true)})
		require.NoError(t, err)
	}

	// not enforced: both ways go through, links or none
	code, out := e.send("alpha", "beta", alphaOrchSID)
	require.Equal(t, http.StatusOK, code, "%v", out)

	on.Store(true)
	code, out = e.send("alpha", "beta", alphaOrchSID)
	assert.Equal(t, http.StatusForbidden, code, "enforced and not linked: refused")
	assert.Equal(t, crossTeamRefusedCode, out["code"])

	// alpha may message beta, one way
	code, _ = e.call("POST", "/api/board/alpha/cross-team-links", opHdr, map[string]any{"with": "beta", "both": false})
	require.Equal(t, http.StatusOK, code)
	code, out = e.send("alpha", "beta", alphaOrchSID)
	assert.Equal(t, http.StatusOK, code, "linked: admitted: %v", out)
	code, out = e.send("beta", "alpha", betaOrchSID)
	assert.Equal(t, http.StatusForbidden, code, "the other way was not linked: refused")
	assert.Equal(t, crossTeamRefusedCode, out["code"])

	// both ways: now beta may message alpha too
	code, _ = e.call("POST", "/api/board/alpha/cross-team-links", opHdr, map[string]any{"with": "beta"})
	require.Equal(t, http.StatusOK, code)
	code, out = e.send("beta", "alpha", betaOrchSID)
	assert.Equal(t, http.StatusOK, code, "%v", out)

	// unlinked: refused again
	code, _ = e.call("DELETE", "/api/board/alpha/cross-team-links", opHdr, map[string]any{"with": "beta"})
	require.Equal(t, http.StatusOK, code)
	code, _ = e.send("alpha", "beta", alphaOrchSID)
	assert.Equal(t, http.StatusForbidden, code)
}

// Files are a grant of the link: with the list in force a link made with files off lets the messages through and refuses what is attached; on, both go.
func TestALinkCanTurnFilesOffForOneSender(t *testing.T) {
	e := newAttachEnv(t, true)
	e.h.SetAllowlistFlag(func(context.Context) bool { return true })
	ctx := context.Background()
	for _, b := range []string{"alpha", "beta"} {
		_, err := e.h.bs.UpdateBoardSettings(ctx, b, board.BoardSettingsUpdate{CrossTeamMessaging: ptrBool(true)})
		require.NoError(t, err)
	}
	code, _ := e.call("POST", "/api/board/alpha/cross-team-links", opHdr, map[string]any{"with": "beta", "both": false, "files": false})
	require.Equal(t, http.StatusOK, code)
	d := e.upload(alphaOrchSID, "alpha's report")
	code, out := e.send("alpha", "beta", alphaOrchSID)
	assert.Equal(t, http.StatusOK, code, "the message goes: %v", out)
	code, out = e.send("alpha", "beta", alphaOrchSID, uri(d))
	assert.Equal(t, http.StatusForbidden, code, "its file does not: %v", out)
	assert.Equal(t, "link_files_off", out["code"])
	assert.Equal(t, 1, e.messages("beta"), "nothing of the refused send is stored")

	code, _ = e.call("POST", "/api/board/alpha/cross-team-links", opHdr, map[string]any{"with": "beta", "both": false, "files": true})
	require.Equal(t, http.StatusOK, code)
	code, out = e.send("alpha", "beta", alphaOrchSID, uri(d))
	assert.Equal(t, http.StatusOK, code, "files on for the link: %v", out)
}

// With the list in force, a sender whose own cross-team id cannot be read is not granted files (fail closed, Security Reviewer's SHOULD on #9900).
func TestAttachmentsFailClosedWhenTheSenderHasNoReadableID(t *testing.T) {
	e := newAttachEnv(t, true)
	e.h.SetAllowlistFlag(func(context.Context) bool { return true })
	ctx := context.Background()
	d := e.upload(alphaOrchSID, "alpha's report")
	_, err := e.h.bs.UpdateBoardSettings(ctx, "alpha", board.BoardSettingsUpdate{CrossTeamMessaging: ptrBool(true)})
	require.NoError(t, err)
	_, err = e.h.bs.UpdateBoardSettings(ctx, "beta", board.BoardSettingsUpdate{CrossTeamMessaging: ptrBool(true)})
	require.NoError(t, err)
	m := &externalMessage{FromBoard: "alpha", SubscriberID: "Orchestrator", Content: "x", Attach: []string{uri(d)}}
	// a linked sender with files on gets past the files check ...
	code, _ := e.call("POST", "/api/board/alpha/cross-team-links", opHdr, map[string]any{"with": "beta", "both": false})
	require.Equal(t, http.StatusOK, code)
	_, refused := e.h.crossTeamAttachments(ctx, httptest.NewRequest("POST", "/", nil), m, "beta", "", "Orchestrator")
	if refused != nil { // a bare request may fail a later step (who uploaded it); what matters is that it is not the files grant
		rec := httptest.NewRecorder()
		refused(rec)
		assert.NotContains(t, rec.Body.String(), "link_files_off", "linked, files on: the grant lets it on to the next step")
	}
	// ... and a sender with no readable id of its own (a board with no row) does not, even with its files switch explicitly on
	_, err = e.h.bs.UpdateBoardSettings(ctx, "ghost", board.BoardSettingsUpdate{CrossTeamMessaging: ptrBool(true), CrossTeamArtifacts: ptrBool(true)})
	require.NoError(t, err)
	_, err = e.h.bs.UpdateBoardSettings(ctx, "beta", board.BoardSettingsUpdate{CrossTeamArtifacts: ptrBool(true)})
	require.NoError(t, err)
	ghost := &externalMessage{FromBoard: "ghost", SubscriberID: "Orchestrator", Content: "x", Attach: []string{uri(d)}}
	_, refused = e.h.crossTeamAttachments(ctx, httptest.NewRequest("POST", "/", nil), ghost, "beta", "", "Orchestrator")
	require.NotNil(t, refused, "no id, no files")
	rec := httptest.NewRecorder()
	refused(rec)
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Contains(t, rec.Body.String(), "link_files_off")
}
