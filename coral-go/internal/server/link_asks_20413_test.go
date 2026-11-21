package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

const (
	askAdded  = "lnk-0000000b"
	askPerson = "hub-user-bbbb2222"
)

// askWorld is a server with its enrollment link and one link added here, the Hub mode at Launch so the tunnel table is not what refuses anything.
func askWorld(t *testing.T) (r *e2eRemote, enrolled string, hubOf func(link string) map[string]string, local func(method, path, body string) (int, string)) {
	t.Helper()
	r, cs, l := linkedRemote(t, &fakeRevoker{})
	r.srv.cloudHandler.SetLinkedCheck(func() bool { return true }) // a linked computer: the Hub's owner may act as the Operator
	pinned, perr := cs.PinOwnerUser(context.Background(), "srv_a", askPerson)
	require.NoError(t, perr)
	require.True(t, pinned)
	_, err := r.db.ExecContext(context.Background(), `INSERT INTO cloud_link (link_id, hub_origin, server_id, label, token, state, max_mode, scope, owner_account, owner_user, created_at, source)
		VALUES (?, 'https://hub-b.example.com', 'srv_b', 'Laptop B', 'v1:b-sealed', 'active', 'launch', 'all', 'acct-b', ?, '2026-01-01T00:00:00Z', 'added')`, askAdded, askPerson)
	require.NoError(t, err)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/links/"+l.LinkID+"/cap", `{"mode":"launch"}`, js).Code)
	hubOf = func(link string) map[string]string {
		return map[string]string{"Content-Type": "application/json", tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: link, tunnel.ActorHeader: askPerson, tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: askPerson}
	}
	local = func(method, path, body string) (int, string) {
		rec := call(h, method, path, body, js)
		return rec.Code, rec.Body.String()
	}
	return r, l.LinkID, hubOf, local
}

func codeOf(body string) string {
	var m map[string]any
	_ = json.Unmarshal([]byte(body), &m)
	s, _ := m["code"].(string)
	return s
}

// #20413: through an added link a route that answers an ask passes only for a kind the person allowed, read on every call; a route that settles something agents will run never passes; the enrollment's link is unchanged.
func TestAnAddedHubAnswersOnlyTheAsksThePersonAllowed(t *testing.T) {
	r, enrolled, hubOf, local := askWorld(t)
	h := r.srv.Router()
	refused := func(link, method, path string) bool {
		rec := call(h, method, path, `{}`, hubOf(link))
		return rec.Code == 403 && codeOf(rec.Body.String()) == cloud.LinkRefusedCode
	}
	dismiss, button, closeAsk := "/api/agent-asks/1/dismiss", "/api/board/team/asks/1/buttons/1/claim", "/api/board/team/asks/1/close"
	assert.True(t, refused(askAdded, "POST", dismiss), "empty by default")
	// Spellings the table does not know are refused, not passed as "not an ask route" (Security's MUST 2): the router would serve some of them with the same handler.
	for _, p := range []string{"/api/agent-asks//1/dismiss", "/api/agent-asks/1/dismiss/", "/api/agent-asks/./1/dismiss", "/api/x/../agent-asks/1/dismiss", "/api/agent-asks%2F1/dismiss",
		"/api/agent-asks/1%2Fdismiss", "/api/board/team//asks/1/close", "/api/board/team/asks/1/close/", "/api/board/team/asks%2F1/close", "/api/board/team/asks/1/buttons/1%2Fclaim"} {
		rec := call(h, "POST", p, `{}`, hubOf(askAdded))
		assert.Equal(t, 403, rec.Code, p+" "+rec.Body.String())
	}
	assert.True(t, refused(askAdded, "POST", button))
	assert.False(t, refused(enrolled, "POST", dismiss), "the enrollment's own link answers as it always has")
	assert.False(t, refused(enrolled, "POST", button))

	code, body := local("PUT", "/api/cloud/links/"+askAdded+"/asks", `{"kind":"agent_ask","allow":true}`)
	require.Equal(t, 200, code, body)
	assert.False(t, refused(askAdded, "POST", dismiss), "allowed: the request reaches its own handler")
	assert.True(t, refused(askAdded, "POST", button), "one kind is not another")
	assert.True(t, refused(askAdded, "POST", closeAsk))

	// Read on every call: stopping it makes the very next request refused.
	require.Equal(t, 200, func() int {
		c, _ := local("PUT", "/api/cloud/links/"+askAdded+"/asks", `{"kind":"agent_ask","allow":false}`)
		return c
	}())
	assert.True(t, refused(askAdded, "POST", dismiss))

	// Everything allowed: a proposal and a file review still do not pass for an added link.
	for _, k := range tunnel.AskKinds() {
		c, b := local("PUT", "/api/cloud/links/"+askAdded+"/asks", `{"kind":"`+k+`","allow":true}`)
		require.Equal(t, 200, c, b)
	}
	for _, rt := range [][2]string{{"POST", "/api/board/team/proposals/1/approve"}, {"POST", "/api/board/team/proposals/1/reject"}, {"POST", "/api/board/team/artifacts/ab/review"}, {"PUT", "/api/board/team/artifacts/ab/review"}, {"DELETE", "/api/board/team/artifacts/ab/review"}} {
		assert.True(t, refused(askAdded, rt[0], rt[1]), "stays at this computer: "+rt[0]+" "+rt[1])
		assert.False(t, refused(enrolled, rt[0], rt[1]), "and is unchanged for the enrollment's link: "+rt[0]+" "+rt[1])
	}
	assert.False(t, refused(askAdded, "POST", button), "the allowed kinds pass")
}

// The list is written only by the person at this computer: never through a Hub (any link, any role), never by an agent, and only a kind of the vocabulary, for a link added here.
func TestOnlyThePersonAtThisComputerWritesTheAskList(t *testing.T) {
	r, enrolled, hubOf, local := askWorld(t)
	h := r.srv.Router()
	for _, link := range []string{enrolled, askAdded} {
		for _, role := range []string{"owner", "guide", "member", ""} {
			hdr := hubOf(link)
			hdr[tunnel.HubRoleHeader] = role
			for _, m := range []string{"GET", "PUT"} {
				rec := call(h, m, "/api/cloud/links/"+askAdded+"/asks", `{"kind":"agent_ask","allow":true}`, hdr)
				assert.Equal(t, 403, rec.Code, link+" "+role+" "+m)
			}
		}
	}
	agentTok, err := r.db.MintSessionToken(context.Background(), "sid-dev", "claude-dev")
	require.NoError(t, err)
	rec := call(h, "PUT", "/api/cloud/links/"+askAdded+"/asks", `{"kind":"agent_ask","allow":true}`, map[string]string{"Content-Type": "application/json", store.SessionTokenHeader: agentTok})
	assert.Equal(t, 403, rec.Code, "an agent's token is not the person: "+rec.Body.String())
	_, body := local("GET", "/api/cloud/links/"+askAdded+"/asks", "")
	assert.Contains(t, body, `"allowed":[]`, "nothing was written")

	for _, k := range []string{"permission", "check_approval", "device_key", "proposal", "local_only", "", "x"} {
		c, b := local("PUT", "/api/cloud/links/"+askAdded+"/asks", `{"kind":"`+k+`","allow":true}`)
		assert.Equal(t, 400, c, k+" "+b)
	}
	c, _ := local("PUT", "/api/cloud/links/"+enrolled+"/asks", `{"kind":"agent_ask","allow":true}`)
	assert.Equal(t, 400, c, "the list is for a Hub added here")
	c, _ = local("PUT", "/api/cloud/links/"+askAdded+"/asks", `{"kind":"agent_ask"}`)
	assert.Equal(t, 400, c, "allow is required")
	c, _ = local("PUT", "/api/cloud/links/lnk-ffffffff/asks", `{"kind":"agent_ask","allow":true}`)
	assert.Equal(t, 404, c)
}

// A post that arrives through a link added here without message_reply never counts as an answer, by reply_to or by an @mention of the asker, and is still delivered; with the row, or through the enrollment's own link,
// it answers as it always has. Both forms, through the real router.
func TestAPostThroughAnAddedHubAnswersAnAskOnlyWithMessageReply(t *testing.T) {
	r, enrolled, hubOf, local := askWorld(t)
	h := r.srv.Router()
	ctx := context.Background()
	bs := r.srv.boardStore
	for _, who := range []string{"Lead", "Operator"} {
		_, err := bs.Subscribe(ctx, "team", who, who, "", nil, "all")
		require.NoError(t, err)
	}
	ask := func(text string) int64 {
		q, err := bs.PostMessage(ctx, "team", "Lead", text, nil)
		require.NoError(t, err)
		to, err := bs.AskTargets(ctx, "team", "Lead", q.Content)
		require.NoError(t, err)
		require.NoError(t, bs.RecordAsk(ctx, "team", q, to))
		return q.ID
	}
	open := func(id int64) bool {
		m, err := bs.GetMessageByID(ctx, "team", id)
		require.NoError(t, err)
		require.NotNil(t, m.Ask)
		return len(m.Ask.Open) > 0 && !m.Ask.Closed
	}
	post := func(link string, body map[string]any) (int, string) {
		body["subscriber_id"] = "Operator"
		b, _ := json.Marshal(body)
		rec := call(h, "POST", "/api/board/team/messages", string(b), hubOf(link))
		return rec.Code, rec.Body.String()
	}
	byReply := func(id int64) map[string]any { return map[string]any{"content": "ship A", "reply_to": id} }
	byMention := map[string]any{"content": "@Lead ship A"}

	q1 := ask("@Operator which design? (reply)")
	c, b := post(askAdded, byReply(q1))
	assert.Equal(t, 200, c, "the post is delivered: "+b)
	assert.True(t, open(q1), "but it answers nothing: a reply_to through a link with no message_reply")
	q2 := ask("@Operator which design? (mention)")
	c, b = post(askAdded, byMention)
	assert.Equal(t, 200, c, "delivered: "+b)
	assert.True(t, open(q2), "an @mention of the asker answers nothing either")
	assert.True(t, open(q1))
	c, _ = post(askAdded, map[string]any{"content": "ship A", "reply_to": 987654})
	assert.Equal(t, 400, c, "an unresolvable reply_to is still the handler's own 400")

	// The same posts through the enrollment's own link answer, as they always have.
	c, b = post(enrolled, byReply(q1))
	require.Equal(t, 200, c, b)
	assert.False(t, open(q1), "unchanged for the enrollment's link")

	// With the row the added link answers too, both forms.
	code, body := local("PUT", "/api/cloud/links/"+askAdded+"/asks", `{"kind":"message_reply","allow":true}`)
	require.Equal(t, 200, code, body)
	c, b = post(askAdded, byMention)
	require.Equal(t, 200, c, b)
	assert.False(t, open(q2), "allowed: the mention answers")
	q3 := ask("@Operator once more")
	c, b = post(askAdded, byReply(q3))
	require.Equal(t, 200, c, b)
	assert.False(t, open(q3), "allowed: the reply answers")

	// Taken away again: the next post answers nothing.
	local("PUT", "/api/cloud/links/"+askAdded+"/asks", `{"kind":"message_reply","allow":false}`)
	q4 := ask("@Operator and again")
	c, _ = post(askAdded, byMention)
	assert.Equal(t, 200, c)
	assert.True(t, open(q4), "stopped: read on every post")
}

// Adding a route or a code path that answers or closes an ask must fail here until it is mapped: the files that call the functions which answer or close one are pinned, each with where its callers are gated.
func TestOnlyTheKnownRoutesAnswerOrCloseAnAsk(t *testing.T) {
	want := map[string]string{
		"routes/board_ask_close.go":        "POST /api/board/{project}/asks/{id}/close: mapped (ask_button)",
		"routes/board_ask_button_click.go": "POST .../buttons/{id}/claim and settle: mapped (ask_button); the custom-check button runs from here",
		"routes/board_messages.go":         "POST /api/board/{project}/messages: reply_to gated by refuseUnallowedReply (message_reply)",
		"routes/board_task_reply.go":       "POST .../tasks/{id}/reply: reply_to gated by refuseUnallowedReply (message_reply)",
		"routes/team_artifact_review.go":   "artifact review decisions: mapped (local_only for an added link)",
		"routes/health_check_approval.go":  "closes a custom-check approval ask, called from the button route above and from the check's own code",
		"routes/cross_team.go":             "the cross-team relay: not a Hub link route (never in the tunnel table)",
	}
	calls := []string{".RecordReply(", ".CloseAsk(", ".ClaimAskButton(", ".ReopenAsk("}
	var found []string
	err := filepath.Walk("routes", func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return err
		}
		src, rerr := os.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		for _, c := range calls {
			if strings.Contains(string(src), c) {
				found = append(found, filepath.ToSlash(p))
				break
			}
		}
		return nil
	})
	require.NoError(t, err)
	sort.Strings(found)
	var known []string
	for f := range want {
		known = append(known, f)
	}
	sort.Strings(known)
	assert.Equal(t, known, found, "a file that answers or closes an ask is not in the list: map its route in pkg/tunnel/askkinds.go (or gate it like message_reply), then name it here")
	for _, rt := range tunnel.AskRoutePatterns() {
		pat := strings.NewReplacer("{id}", "{}", "{project}", "{}").Replace(rt)
		golden, gerr := os.ReadFile("testdata/cloud_routes.golden")
		require.NoError(t, gerr)
		found := false
		for _, line := range strings.Split(string(golden), "\n") {
			parts := strings.Fields(line)
			if len(parts) == 3 {
				n := strings.NewReplacer("{messageID}", "{}", "{buttonID}", "{}", "{id}", "{}", "{project}", "{}").Replace(parts[0] + " " + parts[1])
				found = found || n == pat
			}
		}
		assert.True(t, found, "a mapped route that is not a route of the server: "+rt)
	}
}
