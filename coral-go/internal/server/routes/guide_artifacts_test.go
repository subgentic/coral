package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #11457 slice C (Security's test 9): what a guide reads and writes of the artifacts. The one read check lets a guide read an artifact only when a record of it is on the grant's board and it was not marked
// private to the manager; every other case answers as an artifact that does not exist. Comments: a guide comments and replies on the grant's board, nothing more.

const (
	gaBoard   = "team-a"
	gaOther   = "team-b"
	gaMine    = cmtDoc  // on team-a
	gaTheirs  = cmtPic2 // on team-b
	gaPrivate = cmtPic  // on team-a, marked private
	gaMissing = "feedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed"
	gaDana    = "hub-user-1234abcd"
)

func gaGuide(label string) map[string]string {
	return map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "guide", tunnel.HubGuideBoardHeader: gaBoard, tunnel.HubGuideLabelHeader: label, tunnel.HubGuideSinceHeader: "2026-10-31T07:00:00Z", tunnel.HubUserHeader: label}
}

func newGuideArtifactRig(t *testing.T) *cmtRig {
	t.Helper()
	rig := newCmtRig(t)
	SetArtifactCircle(NewArtifactCircle(rig.ss, rig.h.bs))
	t.Cleanup(func() { SetArtifactCircle(ArtifactCircle{}) })
	coral := rig.h.cfg.CoralDir()
	record := func(session, id, boardKey string) {
		dir := uploadsDir(coral, session)
		require.NotEmpty(t, dir)
		require.NoError(t, os.MkdirAll(dir, 0o755))
		b, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "f", MediaType: "text/plain", Size: 4, Digest: id}, CreatedAt: time.Now().UTC().Format(time.RFC3339), Board: boardKey})
		require.NoError(t, os.WriteFile(filepath.Join(dir, id+".json"), b, 0o644))
	}
	record("s-a", gaMine, gaBoard)
	record("s-a", gaPrivate, gaBoard)
	record("s-b", gaTheirs, gaOther)
	require.NoError(t, rig.h.bs.SetArtifactPrivate(context.Background(), gaPrivate, true, "Operator"))
	return rig
}

func TestAGuideReadsOnlyTheGrantsBoardAndNotWhatIsPrivate(t *testing.T) {
	rig := newGuideArtifactRig(t)
	g := gaGuide(gaDana)
	for _, suffix := range []string{"", "/meta", "/comments"} { // /versions is a 404 for an artifact that is in no series, so it is only checked below as one
		code, _ := rig.do("GET", "/api/artifacts/"+gaMine+suffix, g, nil)
		assert.NotEqual(t, http.StatusNotFound, code, "this board's artifact %s: %d", suffix, code)
		assert.Less(t, code, 500, suffix)
	}
	// another board's, a private one on this board and a missing one all answer the same: not found, with the same body
	var bodies []string
	for _, id := range []string{gaTheirs, gaPrivate, gaMissing} {
		for _, suffix := range []string{"", "/meta", "/comments"} {
			req, _ := http.NewRequest("GET", rig.srv.URL+"/api/artifacts/"+id+suffix, nil)
			for k, v := range g {
				req.Header.Set(k, v)
			}
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			buf := new(strings.Builder)
			b := make([]byte, 4096)
			n, _ := resp.Body.Read(b)
			buf.Write(b[:n])
			resp.Body.Close()
			assert.Equal(t, http.StatusNotFound, resp.StatusCode, "%s%s", id[:6], suffix)
			bodies = append(bodies, suffix+"|"+strings.TrimSpace(buf.String()))
		}
	}
	for i := 3; i < len(bodies); i++ {
		assert.Equal(t, bodies[i%3], bodies[i], "private, another board's and a missing artifact look alike")
	}
	// the owner still reads the private one
	code, _ := rig.do("GET", "/api/artifacts/"+gaPrivate+"/meta", cmtAsOwner, nil)
	assert.Equal(t, http.StatusOK, code)
}

func TestAGuidesListLeavesOutWhatTheyMayNotReadSoNothingCountsIt(t *testing.T) {
	rig := newGuideArtifactRig(t)
	items := []teamArtifact{{ID: gaMine}, {ID: gaPrivate}, {ID: gaTheirs}, {ID: "a link the team never uploaded"}}
	req := httptest.NewRequest("GET", "/api/board/team-a/artifacts", nil)
	for k, v := range gaGuide(gaDana) {
		req.Header.Set(k, v)
	}
	got := filterReadable(req, rig.h.cfg.CoralDir(), items)
	var ids []string
	for _, it := range got {
		ids = append(ids, it.ID)
	}
	assert.Equal(t, []string{gaMine, "a link the team never uploaded"}, ids, "the private one and another board's are left out whole")
	// the check cannot be had (no private marks): a guide reads nothing
	SetArtifactCircle(ArtifactCircle{})
	assert.Empty(t, guideMayRead(context.Background(), rig.h.cfg.CoralDir(), gaBoard, []string{gaMine}), "an unknown answer is a refusal")
}

func TestAGuideCommentsOnTheGrantsBoardAndCannotDoMoreThanThat(t *testing.T) {
	rig := newGuideArtifactRig(t)
	require.NoError(t, os.WriteFile(filepath.Join(rig.h.cfg.CoralDir(), "x"), nil, 0o644))
	_, err := rig.h.bs.SetGuideRoster(context.Background(), gaBoard, map[string]string{gaDana: "Dana Reyes"})
	require.NoError(t, err)
	g := gaGuide(gaDana)
	ownerCode, _ := rig.do("POST", cp(gaMine), cmtAsOwner, map[string]any{"body": "the owner's note", "anchor": anchorOf("the lock"), "board": gaBoard})
	require.Equal(t, http.StatusCreated, ownerCode)
	otherCode, _ := rig.do("POST", cp(gaMine), cmtAsOwner, map[string]any{"body": "a note on another board", "anchor": anchorOf("the lock"), "board": gaOther})
	require.Equal(t, http.StatusCreated, otherCode)

	code, out := rig.do("POST", cp(gaMine), g, map[string]any{"body": "please also cover the retry", "anchor": anchorOf("the lock")})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	author, _ := out["author"].(map[string]any)
	assert.Equal(t, "guide", author["kind"])
	assert.Equal(t, "Dana Reyes", author["name"])
	assert.Equal(t, gaBoard, out["board"], "the board is the grant's, not the request's")
	assert.Nil(t, out["sent_to"], "a guide's comment is never sent to an agent by their own request")
	// a reply
	id := int64(out["id"].(float64))
	code, out = rig.do("POST", cp(gaMine), g, map[string]any{"body": "and the timeout", "parent_id": id})
	assert.Equal(t, http.StatusCreated, code, "%v", out)

	// closed body: a board, a notify flag or anything else is a 400; so is more than 4000 characters
	for name, body := range map[string]any{"a board": map[string]any{"body": "x", "anchor": anchorOf("q"), "board": gaOther}, "a notify flag": map[string]any{"body": "x", "anchor": anchorOf("q"), "notify_agent": true},
		"an author": map[string]any{"body": "x", "anchor": anchorOf("q"), "author": "Operator"}, "too long": map[string]any{"body": strings.Repeat("a", 4001), "anchor": anchorOf("q")}} {
		code, _ = rig.do("POST", cp(gaMine), g, body)
		assert.Equal(t, http.StatusBadRequest, code, name)
	}
	// a guide reads this board's comments (the owner's and their own), not the other board's
	code, out = rig.do("GET", cp(gaMine), g, nil)
	require.Equal(t, http.StatusOK, code)
	var bodies []string
	for _, c := range out["comments"].([]any) {
		bodies = append(bodies, c.(map[string]any)["body"].(string))
	}
	assert.Contains(t, bodies, "the owner's note")
	assert.Contains(t, bodies, "please also cover the retry")
	assert.NotContains(t, bodies, "a note on another board")

	// nothing else: edit, delete, resolve and reopen are refused by the policy whatever the route table says
	for name, c := range map[string]struct{ method, path string }{
		"resolve": {"POST", cp(gaMine) + "/" + strconv.FormatInt(id, 10) + "/resolve"}, "reopen": {"POST", cp(gaMine) + "/" + strconv.FormatInt(id, 10) + "/reopen"},
		"edit": {"PATCH", cp(gaMine) + "/" + strconv.FormatInt(id, 10)}, "delete": {"DELETE", cp(gaMine) + "/" + strconv.FormatInt(id, 10)}, "lock": {"PUT", cp(gaMine) + "/lock"},
	} {
		code, _ = rig.do(c.method, c.path, g, map[string]any{"body": "x"})
		assert.GreaterOrEqual(t, code, 400, name)
		assert.Less(t, code, 500, name)
	}
	// private, another board's and a missing artifact take no comment from a guide, and look the same
	for _, id := range []string{gaPrivate, gaTheirs, gaMissing} {
		code, _ = rig.do("POST", cp(id), g, map[string]any{"body": "x", "anchor": anchorOf("q")})
		assert.Equal(t, http.StatusNotFound, code, id[:6])
	}
}

func TestAGuidesCommentsAreCappedByCoralItselfPerGuide(t *testing.T) {
	rig := newGuideArtifactRig(t)
	for i := 0; i < guideCommentsPerHour; i++ {
		_, err := rig.ss.CreateArtifactComment(context.Background(), storeComment(gaMine, gaBoard, "earlier"))
		require.NoError(t, err)
	}
	code, out := rig.do("POST", cp(gaMine), gaGuide(gaDana), map[string]any{"body": "one too many", "anchor": anchorOf("q")})
	assert.Equal(t, http.StatusTooManyRequests, code, "%v", out)
	code, out = rig.do("POST", cp(gaMine), gaGuide("hub-user-00000001"), map[string]any{"body": "another guide", "anchor": anchorOf("q")})
	assert.Equal(t, http.StatusCreated, code, "%v", out)
}

func TestOnlyTheOwnerMarksAnArtifactPrivateAndAGuideNeverReachesIt(t *testing.T) {
	rig := newGuideArtifactRig(t)
	ctx := context.Background()
	mark := func(h map[string]string, private bool) int {
		code, _ := rig.do("PUT", "/api/artifacts/"+gaMine+"/private", h, map[string]any{"private": private})
		return code
	}
	assert.Equal(t, http.StatusNotFound, mark(gaGuide(gaDana), false), "a guide cannot set or clear it, and is told nothing")
	assert.Equal(t, http.StatusNotFound, mark(gaGuide(gaDana), true))
	assert.GreaterOrEqual(t, mark(cmtAsAgent, true), 400, "an agent's token cannot")
	assert.GreaterOrEqual(t, mark(cmtAsHub, true), 400, "a Hub viewer who is not the owner cannot")
	assert.GreaterOrEqual(t, mark(cmtAsForged, true), 400)
	p, _ := rig.h.bs.ArtifactPrivate(ctx, gaMine)
	assert.False(t, p, "nothing changed")
	assert.Equal(t, http.StatusOK, mark(cmtAsOwner, true))
	p, _ = rig.h.bs.ArtifactPrivate(ctx, gaMine)
	assert.True(t, p)
	code, _ := rig.do("GET", "/api/artifacts/"+gaMine+"/meta", gaGuide(gaDana), nil)
	assert.Equal(t, http.StatusNotFound, code, "marked, it is gone for a guide at once")
	assert.Equal(t, http.StatusOK, mark(cmtAsOwner, false))
	code, _ = rig.do("GET", "/api/artifacts/"+gaMine+"/meta", gaGuide(gaDana), nil)
	assert.NotEqual(t, http.StatusNotFound, code, "cleared, it is back")
	// bad bodies
	for name, body := range map[string]any{"no value": map[string]any{}, "an extra field": map[string]any{"private": true, "x": 1}, "not a bool": map[string]any{"private": "yes"}} {
		code, _ = rig.do("PUT", "/api/artifacts/"+gaMine+"/private", cmtAsOwner, body)
		assert.Equal(t, http.StatusBadRequest, code, name)
	}
	code, _ = rig.do("PUT", "/api/artifacts/"+gaMissing+"/private", cmtAsOwner, map[string]any{"private": true})
	assert.Equal(t, http.StatusNotFound, code, "no such artifact")
	_ = board.OriginHubGuide
}

func storeComment(artifact, boardKey, body string) store.ArtifactComment {
	return store.ArtifactComment{ArtifactID: artifact, Board: boardKey, AnchorJSON: `{"whole":true}`, Body: body, AuthorIssuer: guideIssuer, AuthorSubject: gaDana, AuthorName: "Dana", AuthorKind: commentCallerGuide}
}
