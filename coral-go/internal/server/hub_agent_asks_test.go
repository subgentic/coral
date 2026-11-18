package server

import (
	"bytes"
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #19628: a question from an agent on no team is answered, dismissed and given a picture, and the away counts are read, from the Hub's own Needs you: the OWNER's alone. A grantee (the Hub's own stamp, no owner marker) is
// refused before any handler runs and nothing happens to the question; the owner reaches the handler, which refuses a picture that is too big or not a picture.
func TestAnAgentsQuestionIsTheHubOwnersAloneToAnswerDismissOrAddAPictureTo(t *testing.T) {
	r := newE2ERemote(t, "hub-agent-asks", nil)
	h := r.srv.Router()
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/max-mode", `{"mode":"interact"}`, map[string]string{"Content-Type": "application/json"}).Code) // the machine's own mode: Interact reaches these routes
	const owner = "hub-user-1234abcd"
	routes.SetHubOwnerLabel(func(context.Context) (string, error) { return owner, nil })
	t.Cleanup(func() { routes.SetHubOwnerLabel(nil) })
	grantee := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "grantee", tunnel.HubUserHeader: "hub-user-99999999", "Content-Type": "application/json"}
	own := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: owner, "Content-Type": "application/json"}

	sid := "0123456789abcdef0123456789abcdef"
	ss := store.NewSessionStore(r.db)
	id, err := ss.CreateAgentAsk(context.Background(), sid, "claude-"+sid, "Ship it?", nil, time.Now())
	require.NoError(t, err)
	base := "/api/agent-asks/" + strconv.FormatInt(id, 10)

	for _, c := range []struct{ method, path, body string }{
		{"POST", base + "/answer", `{"answer":"yes"}`},
		{"POST", base + "/dismiss", `{}`},
		{"POST", base + "/images", "x"},
		{"GET", "/api/away?since=" + time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), ""},
	} {
		rec := call(h, c.method, c.path, c.body, grantee)
		assert.Equal(t, 403, rec.Code, "%s %s as a grantee: %s", c.method, c.path, rec.Body.String())
		assert.Contains(t, rec.Body.String(), "owner_only", "%s %s", c.method, c.path)
	}
	still, err := ss.OpenAgentAsk(context.Background(), id)
	require.NoError(t, err)
	require.NotNil(t, still, "the grantee changed nothing: the question is still open")

	// The owner's picture: a file that is too big, and one that is not a picture, are refused by the handler (not by the table).
	big := call(h, "POST", base+"/images", strings.Repeat("a", 26<<20), map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: owner, "Content-Type": "image/png"})
	assert.Equal(t, 413, big.Code, big.Body.String())
	notPic := call(h, "POST", base+"/images", "<html>not a picture</html>", map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: owner, "Content-Type": "image/png"})
	assert.Equal(t, 415, notPic.Code, notPic.Body.String())
	wrongType := call(h, "POST", base+"/images", string(bytes.Repeat([]byte{1}, 10)), map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: owner, "Content-Type": "image/svg+xml"})
	assert.Equal(t, 415, wrongType.Code, wrongType.Body.String())

	// The owner reads the away counts and dismisses the question.
	away := call(h, "GET", "/api/away?since="+time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), "", own)
	assert.Equal(t, 200, away.Code, away.Body.String())
	dis := call(h, "POST", base+"/dismiss", `{}`, own)
	assert.Equal(t, 200, dis.Code, dis.Body.String())
}
