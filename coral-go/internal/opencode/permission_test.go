package opencode

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// What 1.19.5 really sends on /global/event when its config says ask (captured from a real run; trimmed): each event wrapped with its folder.
const askedFrame = `data: {"directory":"/work/agent","project":"global","payload":{"id":"evt_1","type":"permission.asked","properties":{"id":"per_18f6c0f48001Wham3hu2rSX4Ne","sessionID":"ses_abc123","permission":"bash","patterns":["echo hello"],"metadata":{"command":"echo hello"},"always":["echo *"],"tool":{"messageID":"msg_1","callID":"call_1"}}}}` + "\n\n"
const askedEditFrame = `data: {"directory":"/work/agent","project":"global","payload":{"id":"evt_2","type":"permission.asked","properties":{"id":"per_18f6b122f00199lvgUKXOuXnmb","sessionID":"ses_abc123","permission":"edit","patterns":["work/agent/ask.txt"],"metadata":{"filepath":"/work/agent/ask.txt","diff":"Index: ask.txt"}}}}` + "\n\n"
const repliedFrame = `data: {"directory":"/work/agent","project":"global","payload":{"id":"evt_3","type":"permission.replied","properties":{"sessionID":"ses_abc123","requestID":"per_18f6c0f48001Wham3hu2rSX4Ne","reply":"once"}}}` + "\n\n"

func TestAPermissionAskedFrameIsReadAsTheServerStatesIt(t *testing.T) {
	var got []Event
	require.NoError(t, ParseStream(context.Background(), strings.NewReader(askedFrame+askedEditFrame+repliedFrame), func(e Event) { got = append(got, e) }))
	require.Len(t, got, 3)
	bash := got[0].Ask
	require.NotNil(t, bash)
	assert.Equal(t, "per_18f6c0f48001Wham3hu2rSX4Ne", bash.ID)
	assert.Equal(t, "ses_abc123", bash.SessionID)
	assert.Equal(t, "bash", bash.Permission)
	assert.Equal(t, "echo hello", bash.Command)
	assert.Equal(t, []string{"echo hello"}, bash.Patterns)
	assert.Equal(t, "/work/agent", bash.Directory, "the folder is the wrapper's: the reply is scoped to it")
	assert.Equal(t, "/work/agent/ask.txt", got[1].Ask.File)
	assert.Equal(t, "per_18f6c0f48001Wham3hu2rSX4Ne", got[2].RepliedID)
	st, ok := StateOf(got[0])
	assert.True(t, ok)
	assert.Equal(t, StateNeedsInput, st)
}

func TestAPermissionFrameThatIsNotWellFormedIsNotARequest(t *testing.T) {
	frame := func(props, dir string) string {
		return `data: {"directory":"` + dir + `","payload":{"id":"e","type":"permission.asked","properties":` + props + `}}` + "\n\n"
	}
	cases := map[string]string{
		"bad id":        frame(`{"id":"../x","sessionID":"ses_abc123","permission":"bash"}`, "/w"),
		"bad session":   frame(`{"id":"per_abc","sessionID":"nope","permission":"bash"}`, "/w"),
		"no properties": `data: {"payload":{"type":"permission.asked"}}` + "\n\n",
		"id not a perm": frame(`{"id":"ses_abc123","sessionID":"ses_abc123"}`, "/w"),
	}
	for name, in := range cases {
		var got []Event
		require.NoError(t, ParseStream(context.Background(), strings.NewReader(in), func(e Event) { got = append(got, e) }))
		for _, e := range got {
			assert.Nil(t, e.Ask, name)
		}
	}
	// a long command is cut, control characters are dropped, a relative or hostile folder is not kept
	var got []Event
	long := strings.Repeat("x", 2000) + `\u001b[31m` // a JSON escape: the frame stays valid JSON, the text holds a control character
	in := frame(`{"id":"per_abc","sessionID":"ses_abc123","permission":"bash\u0007","metadata":{"command":"`+long+`"}}`, "relative/dir")
	require.NoError(t, ParseStream(context.Background(), strings.NewReader(in), func(e Event) { got = append(got, e) }))
	require.Len(t, got, 1)
	require.NotNil(t, got[0].Ask)
	assert.LessOrEqual(t, len(got[0].Ask.Command), maxPermText)
	assert.Equal(t, "bash", got[0].Ask.Permission, "a control character is dropped")
	assert.Equal(t, "", got[0].Ask.Directory, "a folder that is not absolute is not passed back to the server")
	assert.Equal(t, "", cleanDir("/a\nb"))
	assert.Equal(t, "", cleanDir(strings.Repeat("/a", 3000)))
	assert.Equal(t, "/ok/dir", cleanDir("/ok/dir"))
}

func permManager(t *testing.T, version, frames string) (*Manager, string) {
	t.Helper()
	cfg, envFile := stubConfig(t)
	cfg.Version = version
	path := filepath.Join(t.TempDir(), "frames")
	require.NoError(t, os.WriteFile(path, []byte(frames), 0o600))
	t.Setenv(eventsFileVar, path)
	m := NewManager(cfg)
	t.Cleanup(m.Close)
	_, err := m.Ensure(context.Background(), "agent-1", "", "", "")
	require.NoError(t, err)
	return m, envFile
}

func TestAnAgentsOpenPermissionRequestsAreTrackedAndAnsweredThroughItsServer(t *testing.T) {
	m, envFile := permManager(t, "1.19.5", askedFrame+askedEditFrame)
	waitFor(t, "two requests", func() bool { return len(m.AgentPermissions("agent-1")) == 2 })
	st, _, ok := m.AgentTurn("agent-1")
	require.True(t, ok)
	assert.Equal(t, StateNeedsInput, st, "the dot says it needs the person")
	reqs := m.AgentPermissions("agent-1")
	assert.Equal(t, "per_18f6b122f00199lvgUKXOuXnmb", reqs[0].ID, "newest first")
	assert.Empty(t, m.AgentPermissions("agent-2"), "another agent's are not this one's")

	require.NoError(t, m.ReplyPermission(context.Background(), "agent-1", "per_18f6c0f48001Wham3hu2rSX4Ne", "once"))
	raw, err := os.ReadFile(envFile + ".replies")
	require.NoError(t, err)
	assert.Equal(t, "per_18f6c0f48001Wham3hu2rSX4Ne|once|/work/agent\n", string(raw), "the server got the answer, scoped to the request's folder")
	assert.Len(t, m.AgentPermissions("agent-1"), 1, "answered: no longer open")
	assert.ErrorIs(t, m.ReplyPermission(context.Background(), "agent-1", "per_18f6c0f48001Wham3hu2rSX4Ne", "once"), ErrPermissionGone, "answered twice is refused here, without asking the server again")

	require.NoError(t, m.ReplyPermission(context.Background(), "agent-1", "per_18f6b122f00199lvgUKXOuXnmb", "reject"))
	raw, _ = os.ReadFile(envFile + ".replies")
	assert.Contains(t, string(raw), "per_18f6b122f00199lvgUKXOuXnmb|reject|/work/agent")
}

func TestOnlyARequestTheServerAskedCanBeAnsweredAndOnlyWithAKnownAnswer(t *testing.T) {
	m, envFile := permManager(t, "1.19.5", askedFrame)
	waitFor(t, "the request", func() bool { return len(m.AgentPermissions("agent-1")) == 1 })
	for _, bad := range []string{"per_neverasked", "../../x", "", "ses_abc123"} {
		assert.ErrorIs(t, m.ReplyPermission(context.Background(), "agent-1", bad, "once"), ErrPermissionGone, "%q", bad)
	}
	assert.Error(t, m.ReplyPermission(context.Background(), "agent-1", "per_18f6c0f48001Wham3hu2rSX4Ne", "yes please"), "a word that is not an answer")
	_, err := os.Stat(envFile + ".replies")
	assert.True(t, os.IsNotExist(err), "nothing reached the server for any of them")
	assert.ErrorIs(t, m.ReplyPermission(context.Background(), "agent-2", "per_18f6c0f48001Wham3hu2rSX4Ne", "once"), ErrPermissionGone, "another agent's server is not asked")
}

func TestAnAnswerIsOnlyCheckedOnOneDotX(t *testing.T) {
	m, _ := permManager(t, "2.2.4", `data: {"id":"e","type":"permission.asked","properties":{"id":"per_abc","sessionID":"ses_abc123","permission":"bash"}}`+"\n\n")
	waitFor(t, "the request", func() bool { return len(m.AgentPermissions("agent-1")) == 1 })
	assert.ErrorIs(t, m.ReplyPermission(context.Background(), "agent-1", "per_abc", "once"), ErrPermissionUnsupported, "the route is not known on another version: nothing is guessed")
}

func TestARequestIsClearedWhenItIsRepliedOrItsTurnEnds(t *testing.T) {
	m, _ := permManager(t, "1.19.5", askedFrame+repliedFrame)
	waitFor(t, "the stream to be read", func() bool { s, _, ok := m.AgentTurn("agent-1"); return ok && s == StateWorking })
	assert.Empty(t, m.AgentPermissions("agent-1"), "replied elsewhere (in the terminal): gone")

	idle := `data: {"directory":"/work/agent","payload":{"id":"e9","type":"session.idle","properties":{"sessionID":"ses_abc123"}}}` + "\n\n"
	m2, _ := permManager(t, "1.19.5", askedFrame+idle)
	waitFor(t, "idle", func() bool { s, _, ok := m2.AgentTurn("agent-1"); return ok && s == StateIdle })
	assert.Empty(t, m2.AgentPermissions("agent-1"), "the turn ended: nothing is open")
}

func TestTheAskFirstConfigAsksBeforeEditsAndCommandsAndOnlyWhenAsked(t *testing.T) {
	dir := t.TempDir()
	read := func(path string) map[string]any {
		raw, err := os.ReadFile(path)
		require.NoError(t, err)
		var m map[string]any
		require.NoError(t, json.Unmarshal(raw, &m))
		return m
	}
	p, err := writeModelConfig(dir, "openai/gpt-6", true)
	require.NoError(t, err)
	conf := read(p)
	assert.Equal(t, "openai/gpt-6", conf["model"])
	assert.Equal(t, map[string]any{"edit": "ask", "bash": "ask"}, conf["permission"])

	p, err = writeModelConfig(dir, "", true)
	require.NoError(t, err)
	conf = read(p)
	assert.NotContains(t, conf, "model", "ask first with no model: a config of the permission block alone")
	assert.Contains(t, conf, "permission")

	p, err = writeModelConfig(dir, "openai/gpt-6", false)
	require.NoError(t, err)
	assert.NotContains(t, read(p), "permission", "not asked: opencode's own defaults")

	p, err = writeModelConfig(dir, "", false)
	require.NoError(t, err)
	assert.Equal(t, "", p, "no model and no ask: no file")
}
