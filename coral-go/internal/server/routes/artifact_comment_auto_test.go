package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #11420: the Operator's comment on an artifact that waits for their review reaches the agent that uploaded it, once, and the agent answers in the thread.

// uploadedBy records that agent n uploaded cmtDoc on board (the per-session upload record the artifact lists read).
func (rig *cmtRig) uploadedBy(n int, boardID string) { rig.uploadedBySession(sendSid(n), boardID) }

func (rig *cmtRig) uploadedBySession(sid, boardID string) {
	rig.uploadedBySessionOn(sid, cmtDoc, boardID)
}

func (rig *cmtRig) uploadedBySessionOn(sid, digest, boardID string) {
	rig.t.Helper()
	dir := uploadsDir(rig.h.cfg.CoralDir(), sid)
	require.NotEmpty(rig.t, dir)
	require.NoError(rig.t, os.MkdirAll(dir, 0o755))
	rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "plan.md", MediaType: "text/markdown", Size: 4, Digest: digest}, CreatedAt: "2026-10-31T00:00:00Z", Board: boardID})
	require.NoError(rig.t, os.WriteFile(filepath.Join(dir, digest+".json"), rec, 0o644))
}

func (rig *cmtRig) tag(tags ...string) {
	rig.t.Helper()
	require.NoError(rig.t, rig.h.bs.SetArtifactTags(context.Background(), "team-a", cmtDoc, tags))
}

func (rig *cmtRig) commentAs(h map[string]string, extra map[string]any) (int, map[string]any) {
	body := map[string]any{"body": "Please use 5,000 rows per batch.", "anchor": anchorOf("the lock"), "board": "team-a"}
	for k, v := range extra {
		body[k] = v
	}
	return rig.do("POST", cp(cmtDoc), h, body)
}

func TestTheOperatorsCommentOnAForReviewUploadReachesTheUploaderOnce(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.agent(2, "QA", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")

	code, out := rig.commentAs(cmtAsOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Equal(t, "Dev", out["sent_to"], "the answer says who it went to")
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1, "one message, to the uploader only")
	m := msgs[0].Content
	assert.Contains(t, m, "@Dev ")
	assert.Contains(t, m, "Please use 5,000 rows per batch.")
	assert.Contains(t, m, "From the Operator")
	assert.Contains(t, m, "untrusted")
	cid := int64(out["id"].(float64))
	assert.Contains(t, m, fmt.Sprintf("coral-agent artifact reply coral://artifacts/%s %d", cmtDoc, cid), "the reply command, filled in")
	ask, found, err := rig.ss.GetArtifactAsk(context.Background(), cid, sendSid(1))
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, cmtDoc, ask.ArtifactID)
	_, found, _ = rig.ss.GetArtifactAsk(context.Background(), cid, sendSid(2))
	assert.False(t, found, "no ask for the other agent")

	// the uploader's answer lands in that thread, as itself
	code, rep := rig.reply(cid, asAgentSession(1), "Done: 5,000 is fine.")
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(rep))
	assert.Equal(t, float64(cid), rep["parent_id"])
	assert.Equal(t, "agent", rep["author"].(map[string]any)["kind"])
	// another agent cannot answer into it
	code, rep = rig.reply(cid, asAgentSession(2), "me too")
	assert.Equal(t, http.StatusForbidden, code, fmt.Sprint(rep))

	// the Operator's reply in the thread is one more message, with the thread's own id in the command and no second ask
	code, out = rig.commentAs(cmtAsOwner, map[string]any{"body": "Thanks. And the retries?", "parent_id": cid, "anchor": nil})
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	msgs = rig.operatorMessages()
	require.Len(t, msgs, 2, "once per comment")
	assert.Contains(t, msgs[1].Content, "And the retries?")
	assert.Contains(t, msgs[1].Content, fmt.Sprintf("%s %d \"your reply\"", cmtDoc, cid), "the reply command names the thread's first comment")
}

func TestACommentThatIsNotOnAForReviewUploadOfAnAgentSendsNothing(t *testing.T) {
	cases := map[string]func(rig *cmtRig){
		"the artifact is not for review": func(rig *cmtRig) { rig.tag("final") },
		"no tag at all":                  func(rig *cmtRig) {},
		"no agent uploaded it": func(rig *cmtRig) {
			rig.tag("for review")
			require.NoError(rig.t, os.RemoveAll(uploadsDir(rig.h.cfg.CoralDir(), sendSid(1))))
		},
		"a legacy record that names no board is pinned to none": func(rig *cmtRig) {
			rig.tag("for review")
			rig.uploadedBy(1, "")
		},
		"it was uploaded on another board": func(rig *cmtRig) {
			rig.tag("for review")
			rig.uploadedBy(1, "team-b")
		},
		"it is a person's own upload (a paste), not an agent's": func(rig *cmtRig) {
			rig.tag("for review")
			dir := uploadsDir(rig.h.cfg.CoralDir(), sendSid(1))
			rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Digest: cmtDoc}, UploadedBy: "owner", Source: sourcePaste, Board: "team-a"})
			require.NoError(rig.t, os.WriteFile(filepath.Join(dir, cmtDoc+".json"), rec, 0o644))
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			rig := newCmtRig(t)
			rig.agent(1, "Dev", false)
			rig.uploadedBy(1, "team-a")
			setup(rig)
			code, out := rig.commentAs(cmtAsOwner, nil)
			require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
			assert.Nil(t, out["sent_to"])
			assert.Empty(t, rig.operatorMessages(), "nothing was sent")
			_, found, _ := rig.ss.GetArtifactAsk(context.Background(), int64(out["id"].(float64)), sendSid(1))
			assert.False(t, found, "no ask")
		})
	}
}

func TestTheOperatorCanKeepACommentFromTheAgentAndOnlyTheOperatorsCommentGoes(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")

	code, out := rig.commentAs(cmtAsOwner, map[string]any{"notify_agent": false})
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Empty(t, rig.operatorMessages(), "the Operator chose otherwise")

	// a Coral Hub viewer's comment (and the owner's through the tunnel) is nobody's instruction to the agent: sent to no one
	rig.hubOn()
	code, out = rig.commentAs(cmtAsHub, nil)
	assert.Contains(t, []int{http.StatusCreated, http.StatusForbidden}, code, fmt.Sprint(out))
	code, out = rig.commentAs(cmtAsOwnerThroughTunnel, nil)
	assert.Contains(t, []int{http.StatusCreated, http.StatusForbidden}, code, fmt.Sprint(out))
	assert.Empty(t, rig.operatorMessages(), "only the person at this computer reaches the agent on their own")
}

func TestAnAsleepUploaderIsToldWhenItWakesAndABoardThatIsPausedSendsNothing(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Sleeper", true)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")
	code, out := rig.commentAs(cmtAsOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Equal(t, "Sleeper", out["sent_to"], "the message waits unread on the board for it to wake")
	assert.Len(t, rig.operatorMessages(), 1)
}

func TestAnAgentThatDidNotUploadAnArtifactCannotListItsThreads(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.agent(2, "QA", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")
	code, out := rig.commentAs(cmtAsOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))

	for _, n := range []int{1, 2} { // the identity of an agent here is its session as "agent-<id>": subscribed on the board, so the board filter lets it see what it may
		_, err := rig.h.bs.Subscribe(context.Background(), "team-a", fmt.Sprintf("alias-%d", n), fmt.Sprintf("Alias%d", n), "agent-"+sendSid(n), nil, "")
		require.NoError(t, err)
	}
	code, list := rig.do("GET", cp(cmtDoc), asAgentSession(1), nil)
	require.Equal(t, http.StatusOK, code, fmt.Sprint(list))
	assert.Len(t, list["comments"], 1, "the uploader reads the threads on its own upload")
	code, list = rig.do("GET", cp(cmtDoc), asAgentSession(2), nil)
	assert.Equal(t, http.StatusForbidden, code, "another agent on the same board does not")
	assert.NotContains(t, fmt.Sprint(list), "5,000 rows")
}

// #11428: the owner's comment made through Coral Hub is delivered to the uploader like the one at this computer's dashboard: once, with the reply command. The owner is whoever artifactCommentCaller makes the
// owner kind (the stamp, the owner marker and the enrolled label); a Coral Hub viewer and a forged stamp are never the owner and send nothing.
func TestTheOwnersCommentThroughCoralHubReachesTheUploaderOnceAndAViewersNever(t *testing.T) {
	rig := newCmtRig(t)
	withLabel(t, cmtHubUser, nil)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")

	code, out := rig.commentAs(cmtAsHubOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Equal(t, "Dev", out["sent_to"])
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1, "delivered once")
	cid := int64(out["id"].(float64))
	assert.Contains(t, msgs[0].Content, fmt.Sprintf("coral-agent artifact reply coral://artifacts/%s %d", cmtDoc, cid))
	code, rep := rig.reply(cid, asAgentSession(1), "Done.")
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(rep))
	assert.Equal(t, float64(cid), rep["parent_id"], "the uploader answers in that thread")

	// a Hub viewer (every write flag on), a forged stamp and the owner's key with a viewer's stamp send nothing
	rig.hubOn()
	before := len(rig.operatorMessages())
	for who, h := range map[string]map[string]string{
		"a hub viewer":                 cmtAsHub,
		"a second hub viewer":          cmtAsHubTwo,
		"a forged stamp":               cmtAsForged,
		"the owner's key and a viewer": cmtAsOwnerThroughTunnel,
	} {
		code, out := rig.commentAs(h, nil)
		assert.Contains(t, []int{http.StatusCreated, http.StatusForbidden}, code, who+": "+fmt.Sprint(out))
		assert.Nil(t, out["sent_to"], who)
	}
	assert.Len(t, rig.operatorMessages(), before, "no viewer, guest or forged request sent anything to the agent")
}

// #11425 (b): what an agent reads is checked for secrets again at the read, as delivery does: a comment stored with a secret in it (written before the check, or by a path that skipped it) is shown redacted.
func TestAnAgentReadsCommentsRedactedAgain(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	_, err := rig.h.bs.Subscribe(context.Background(), "team-a", "alias-1", "Alias1", "agent-"+sendSid(1), nil, "")
	require.NoError(t, err)
	secret := "ghp_" + strings.Repeat("a1B2c3D4e5", 4)
	anchor, _ := json.Marshal(commentAnchor{Quote: "the key " + secret, Prefix: "p ", Suffix: " s"})
	_, err = rig.ss.CreateArtifactComment(context.Background(), store.ArtifactComment{ArtifactID: cmtDoc, Board: "team-a", AnchorJSON: string(anchor), Body: "use " + secret + " for it", AuthorIssuer: "local", AuthorSubject: "install-owner-id", AuthorName: "Owner", AuthorKind: commentCallerOwner})
	require.NoError(t, err)

	code, list := rig.do("GET", cp(cmtDoc), asAgentSession(1), nil)
	require.Equal(t, http.StatusOK, code, fmt.Sprint(list))
	require.Len(t, list["comments"], 1)
	assert.NotContains(t, fmt.Sprint(list), secret, "the secret is in neither the text nor the quote the agent reads")
	assert.Contains(t, fmt.Sprint(list), "use ", "the rest of the comment is there")
	// the owner's own view is the stored text, as before (the owner wrote it)
	_, own := rig.do("GET", cp(cmtDoc), cmtAsOwner, nil)
	assert.Contains(t, fmt.Sprint(own), secret[:8], "only an agent's read is redacted again")
}

// #11425 (c): with series=1 an agent also reads the earlier versions' comments, each by its own id: a version it did not upload (and was not asked into) is not read through a newer one.
func TestAnAgentReadsAnEarlierVersionsCommentsOnlyForAnEarlierVersionItMayRead(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	_, err := rig.h.bs.Subscribe(context.Background(), "team-a", "alias-1", "Alias1", "agent-"+sendSid(1), nil, "")
	require.NoError(t, err)
	rig.twoVersions("intro\ntake the lock first\nend\n", "intro\ntake the lock first, then go\nend\n")
	commentOnQuote(rig, cmtDoc, "the lock", "take ", " first") // on v1
	code, out := rig.do("POST", cp(cmtPic2), cmtAsOwner, map[string]any{"body": "on v2", "anchor": anchorOf("then go"), "board": "team-a"})
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	rig.uploadedBySessionOn(sendSid(1), cmtPic2, "team-a") // Dev uploaded v2 only

	seen := func() (own, carried int) {
		code, list := rig.do("GET", cp(cmtPic2)+"?series=1", asAgentSession(1), nil)
		require.Equal(t, http.StatusOK, code, fmt.Sprint(list))
		for _, c := range list["comments"].([]any) {
			if c.(map[string]any)["from_version"] != nil {
				carried++
			} else {
				own++
			}
		}
		return
	}
	own, carried := seen()
	assert.Equal(t, 1, own, "its own version's comment")
	assert.Equal(t, 0, carried, "v1 is not Dev's to read, so not through v2 either")
	rig.uploadedBySessionOn(sendSid(1), cmtDoc, "team-a") // now Dev uploaded v1 too
	own, carried = seen()
	assert.Equal(t, 1, own)
	assert.Equal(t, 1, carried, "an earlier version it uploaded is carried")
}

// operatorComment is the one place that says a comment is the Operator's own: the owner at this computer's dashboard, or the owner through Coral Hub whose caller was made by the owner check. Each
// other caller is refused here whatever it carries, so the route's own refusals are not the only thing between a viewer and an agent.
func TestOperatorCommentSaysOnlyTheOwnerIsTheOperator(t *testing.T) {
	rig := newCmtRig(t)
	req := func(via string, human bool) *http.Request {
		r, _ := http.NewRequest("POST", "http://x/api/artifacts/"+cmtDoc+"/comments", nil)
		if via != "" {
			r.Header.Set(tunnel.ViaHeader, via)
		}
		if human {
			r = r.WithContext(context.WithValue(r.Context(), callerKindKey{}, callerDashCookie))
		}
		return r
	}
	owner := commentCaller{Kind: commentCallerOwner, Issuer: "local", Subject: "o"}
	hubOwner := commentCaller{Kind: commentCallerOwner, Issuer: "local", Subject: "o", ViaHub: true}
	for name, tc := range map[string]struct {
		r    *http.Request
		c    commentCaller
		want bool
	}{
		"the owner at the dashboard":                         {req("", true), owner, true},
		"the owner through the Hub, authentic stamp":         {req(cloud.ViaSecret(), false), hubOwner, true},
		"the owner kind through the Hub with a forged stamp": {req("not-the-secret", false), hubOwner, false},
		"a Hub viewer": {req(cloud.ViaSecret(), false), commentCaller{Kind: commentCallerHub, Issuer: hubIssuer, Subject: "hub-user-aaaaaaaa"}, false},
		"an agent":     {req("", false), commentCaller{Kind: commentCallerAgent, Subject: "s"}, false},
		"nobody":       {req("", true), commentCaller{}, false},
		"a stamped request that is not the owner's through Hub": {req(cloud.ViaSecret(), false), owner, false},
		"the owner kind marked ViaHub with no stamp at all":     {req("", true), hubOwner, false},
		"a team machine's owner (an organisation's issuer)":     {req(cloud.ViaSecret(), false), commentCaller{Kind: commentCallerOwner, Issuer: commentTeamIssuer("org-1"), Subject: "u1", ViaHub: true}, false},
		"the dashboard owner without a human input caller":      {req("", false), owner, false},
	} {
		assert.Equal(t, tc.want, rig.h.operatorComment(tc.r, tc.c), name)
	}
}
