package routes

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #12536: comments on an agent's diff are the document comments pointed at one changed file of one live agent: the subject key diff:<team>:<session>:<16 hex of the path>, the same routes, table, ask gate and
// reply command. The path is the key's and is in the agent's changed list; the lines are redacted and sent as quoted data; the person at this computer alone writes; never through Coral Hub.

// diffRig makes agent n (title) on team-a with a changed list holding paths, and answers the comment path and key of path.
func (rig *cmtRig) diffRig(n int, title string, paths ...string) (sid string) {
	rig.t.Helper()
	rig.agent(n, title, false)
	sid = sendSid(n)
	var files []store.ChangedFile
	for _, p := range paths {
		files = append(files, store.ChangedFile{Filepath: p, Status: "modified", Additions: 1})
	}
	s := sid
	require.NoError(rig.t, rig.h.gs.ReplaceChangedFiles(context.Background(), title, rig.t.TempDir(), files, &s, "branch_point"))
	return sid
}

func diffAnchor(path string, extra map[string]any) map[string]any {
	a := map[string]any{"path": path, "side": "new", "start_line": 3, "end_line": 4, "quote": "if err != nil {\n\treturn err", "prefix": "x := f()\n", "suffix": "\n}", "base": "branch_point 2 files"}
	for k, v := range extra {
		a[k] = v
	}
	return a
}

func TestTheOperatorsCommentOnAnAgentsDiffGoesToThatAgentNamingTheFileAndLinesAndItAnswersInTheThread(t *testing.T) {
	rig := newCmtRig(t)
	sid := rig.diffRig(1, "Dev", "pkg/a.go")
	rig.agent(2, "QA", false)
	key := diffSubject("team-a", sid, "pkg/a.go")

	code, out := rig.do("POST", cp(key), cmtAsOwner, map[string]any{"body": "Why not wrap this error?", "anchor": diffAnchor("pkg/a.go", nil)})
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Equal(t, "Dev", out["sent_to"])
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1, "one message, to the agent whose diff it is")
	m := msgs[0].Content
	cid := int64(out["id"].(float64))
	for _, want := range []string{"@Dev ", "Why not wrap this error?", "pkg/a.go, lines 3-4 on the new side of your changes", "return err", "From the Operator", "untrusted",
		fmt.Sprintf("coral-agent artifact reply coral://diffs/team-a/%s/%s %d", sid, diffPathHash("pkg/a.go"), cid)} {
		assert.Contains(t, m, want)
	}
	assert.NotContains(t, m, "@QA")

	code, rep := rig.do("POST", fmt.Sprintf("%s/%d/reply", cp(key), cid), asAgentSession(1), map[string]any{"body": "Good point, wrapping it."})
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(rep))
	assert.Equal(t, float64(cid), rep["parent_id"])
	code, _ = rig.do("POST", fmt.Sprintf("%s/%d/reply", cp(key), cid), asAgentSession(2), map[string]any{"body": "me too"})
	assert.Equal(t, http.StatusForbidden, code, "an agent that was not asked cannot answer")

	code, list := rig.do("GET", cp(key), cmtAsOwner, nil)
	require.Equal(t, http.StatusOK, code, fmt.Sprint(list))
	assert.Contains(t, fmt.Sprint(list), "pkg/a.go", "the thread's anchor names its file")
}

func TestAnAgentCannotStartAThreadOnADiffAndTheHubNeverReachesOne(t *testing.T) {
	rig := newCmtRig(t)
	sid := rig.diffRig(1, "Dev", "pkg/a.go")
	key := diffSubject("team-a", sid, "pkg/a.go")
	body := map[string]any{"body": "I comment on myself", "anchor": diffAnchor("pkg/a.go", nil)}
	code, out := rig.do("POST", cp(key), asAgentSession(1), body)
	assert.GreaterOrEqual(t, code, 400, "an agent opens no thread: "+fmt.Sprint(out))
	for name, hdr := range map[string]map[string]string{"hub viewer": cmtAsHub, "owner through the tunnel": cmtAsOwnerThroughTunnel, "hub owner": cmtAsHubOwner, "forged": cmtAsForged} {
		code, out = rig.do("POST", cp(key), hdr, body)
		assert.GreaterOrEqual(t, code, 400, name+": "+fmt.Sprint(out))
		code, out = rig.do("GET", cp(key), hdr, nil)
		assert.GreaterOrEqual(t, code, 400, name+": "+fmt.Sprint(out))
	}
	assert.Empty(t, rig.operatorMessages())
}

func TestADiffKeyIsNeverAnArtifactIdOrAGoalKey(t *testing.T) {
	sid := sendSid(1)
	key := diffSubject("team-a", sid, "pkg/a.go")
	assert.Len(t, strings.TrimPrefix(key, "diff:"), len("team-a")+1+len(sid)+1+16)
	_, _, _, ok := parseDiffSubject(key)
	assert.True(t, ok)
	_, _, ok = parseGoalSubject(key)
	assert.False(t, ok)
	for _, bad := range []string{cmtDoc, "goal:team-a:1", "diff:team-a:" + sid, "diff:team-a:" + sid + ":ZZZZZZZZZZZZZZZZ", "diff:team-a:" + sid + ":0123456789abcdef0", "diff:../x:" + sid + ":0123456789abcdef"} {
		_, _, _, ok := parseDiffSubject(bad)
		assert.False(t, ok, bad)
	}
}

func TestADiffCommentChecksTheFileTheSessionAndTheLines(t *testing.T) {
	rig := newCmtRig(t)
	sid := rig.diffRig(1, "Dev", "pkg/a.go", "pkg/b.go")
	key := diffSubject("team-a", sid, "pkg/a.go")
	post := func(k string, anchor map[string]any) (int, map[string]any) {
		return rig.do("POST", cp(k), cmtAsOwner, map[string]any{"body": "A question", "anchor": anchor})
	}
	code, out := post(key, diffAnchor("pkg/a.go", nil))
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))

	for name, tc := range map[string]struct {
		key    string
		anchor map[string]any
	}{
		"a path that is not the key's":                {key, diffAnchor("pkg/b.go", nil)},
		"a path with ..":                              {diffSubject("team-a", sid, "pkg/../a.go"), diffAnchor("pkg/../a.go", nil)},
		"an absolute path":                            {diffSubject("team-a", sid, "/etc/passwd"), diffAnchor("/etc/passwd", nil)},
		"a drive path":                                {diffSubject("team-a", sid, "C:/x"), diffAnchor("C:/x", nil)},
		"a file that is not in the changed list":      {diffSubject("team-a", sid, "pkg/z.go"), diffAnchor("pkg/z.go", nil)},
		"a bad side":                                  {key, diffAnchor("pkg/a.go", map[string]any{"side": "left"})},
		"lines that run backwards":                    {key, diffAnchor("pkg/a.go", map[string]any{"start_line": 9, "end_line": 2})},
		"no lines":                                    {key, diffAnchor("pkg/a.go", map[string]any{"start_line": 0, "end_line": 0})},
		"a quote over the cap":                        {key, diffAnchor("pkg/a.go", map[string]any{"quote": strings.Repeat("x", maxDiffQuote+1)})},
		"a quote of too many lines":                   {key, diffAnchor("pkg/a.go", map[string]any{"quote": strings.Repeat("l\n", maxDiffQuoteLines+1)})},
		"a session that is not running":               {diffSubject("team-a", sendSid(9), "pkg/a.go"), diffAnchor("pkg/a.go", nil)},
		"a session of another team":                   {diffSubject("team-b", sid, "pkg/a.go"), diffAnchor("pkg/a.go", nil)},
		"an anchor that says the whole file (no way)": {key, map[string]any{"whole": true}},
	} {
		code, out := post(tc.key, tc.anchor)
		assert.GreaterOrEqual(t, code, 400, name+": "+fmt.Sprint(out))
		assert.Less(t, code, 500, name+": "+fmt.Sprint(out))
	}
	assert.Len(t, rig.operatorMessages(), 1, "only the first comment reached the agent")
}

func TestTheLinesAreRedactedBeforeTheyAreKeptAndBeforeTheyAreSent(t *testing.T) {
	rig := newCmtRig(t)
	sid := rig.diffRig(1, "Dev", "app/.env")
	key := diffSubject("team-a", sid, "app/.env")
	secret := "ghp_" + strings.Repeat("a1B2c3D4", 5)
	code, out := rig.do("POST", cp(key), cmtAsOwner, map[string]any{"body": "Is this a real token?", "anchor": diffAnchor("app/.env", map[string]any{"quote": "TOKEN=" + secret})})
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	code, list := rig.do("GET", cp(key), cmtAsOwner, nil)
	require.Equal(t, http.StatusOK, code)
	assert.NotContains(t, fmt.Sprint(list), secret, "the kept anchor holds no token")
	for _, m := range rig.operatorMessages() {
		assert.NotContains(t, m.Content, secret, "the message holds no token")
	}
}

func TestAPathThatHidesCharactersIsKeptWrittenOut(t *testing.T) {
	assert.Equal(t, "a<U+202E>b<U+200B>c.go", writeHidden("a\u202eb\u200bc.go"))
	assert.Equal(t, "pkg/plain.go", writeHidden("pkg/plain.go"))
	for _, bad := range []string{"", "a\\b", "/abs", "a//b", "./a", "a/./b", "a/../b", "a\x00b", strings.Repeat("a", maxDiffPath+1)} {
		_, ok := repoPath(bad)
		assert.False(t, ok, bad)
	}
}

func TestTheHubsRouteTableDoesNotMatchADiffKey(t *testing.T) {
	key := diffSubject("team-a", sendSid(1), "pkg/a.go")
	for _, method := range []string{"GET", "POST", "PUT", "DELETE"} {
		for _, suffix := range []string{"", "/comments", "/comments/1/reply", "/comments/1/resolve", "/meta", "/readers", "/comment-images"} {
			pattern, mode := tunnel.OwnerRoute(method, "/api/artifacts/"+key+suffix)
			assert.False(t, mode.Stamped(), "the Hub's table reaches %s %s: %q", method, "/api/artifacts/<diff key>"+suffix, pattern)
		}
	}
	pattern, mode := tunnel.OwnerRoute("GET", "/api/artifacts/"+cmtDoc+"/comments")
	assert.True(t, mode.Stamped(), "control: an artifact's comments are in the table (%q)", pattern)
}
