package transcriptlink

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	agySession = "3f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b"
	agyOther   = "4f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5c"
	convA      = "11111111-aaaa-4aaa-8aaa-111111111111"
	convB      = "22222222-bbbb-4bbb-8bbb-222222222222"
)

// agyHome is an isolated agy data folder (ANTIGRAVITY_DATA_DIR): its brain folder is where conversations go.
func agyHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("ANTIGRAVITY_DATA_DIR", home)
	require.NoError(t, os.MkdirAll(filepath.Join(home, "brain"), 0o700))
	return home
}

// agyConv writes a conversation's transcript with the given second row ("" for none).
func agyConv(t *testing.T, home, conv, row string) {
	t.Helper()
	dir := filepath.Join(home, "brain", conv, ".system_generated", "logs")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	body := `{"step_index":0,"type":"USER_INPUT","content":"hello"}` + "\n"
	if row != "" {
		body += row + "\n"
	}
	require.NoError(t, os.WriteFile(filepath.Join(dir, "transcript.jsonl"), []byte(body), 0o600))
}

func agyMarked(session string) string {
	return `{"step_index":1,"type":"USER_INPUT","content":"[CORAL_SESSION_ID: ` + session + `]"}`
}

// #7764: agy keys its transcript by its own conversation id; the hook binds the two from the payload's conversationId, and the readers open the conversation by it.
func TestBindAgyLinksASessionToItsConversation(t *testing.T) {
	home := agyHome(t)
	agyConv(t, home, convA, "")
	assert.Equal(t, "", AgyConversation(agySession), "no link yet")
	require.NoError(t, BindAgy(agySession, convA))
	assert.Equal(t, convA, AgyConversation(agySession))
	assert.Equal(t, filepath.Join(home, "brain", convA, ".system_generated", "logs", "transcript.jsonl"), AgyTranscript(convA))
	require.NoError(t, BindAgy(agySession, convA), "binding the same conversation again is a no-op")
	assert.Equal(t, "", AgyConversation(agyOther), "another session has no link")
}

// A session keeps its link unless the new conversation is marked as the session's own (an agy started from the agent's shell inherits its environment, but not its conversation).
func TestBindAgyAnExistingLinkIsKeptUnlessTheNewConversationIsMarkedAsOurs(t *testing.T) {
	home := agyHome(t)
	agyConv(t, home, convA, "")
	require.NoError(t, BindAgy(agySession, convA), "a first bind needs no marker")

	agyConv(t, home, convB, "")
	assert.Error(t, BindAgy(agySession, convB), "an unmarked conversation does not take the link")
	agyConv(t, home, convB, agyMarked(agyOther))
	assert.Error(t, BindAgy(agySession, convB), "one marked for another session does not either")
	assert.Equal(t, convA, AgyConversation(agySession))

	agyConv(t, home, convB, agyMarked(agySession)) // a restart: the new conversation carries this session's id
	require.NoError(t, BindAgy(agySession, convB))
	assert.Equal(t, convB, AgyConversation(agySession))

	require.NoError(t, os.RemoveAll(filepath.Join(home, "brain", convB)))
	agyConv(t, home, convA, "")
	require.NoError(t, BindAgy(agySession, convA), "a link over a vanished conversation needs no marker")
	assert.Equal(t, convA, AgyConversation(agySession))
}

func TestBindAgyRefusesWhatIsNotAnIDAndReadsOnlyASmallRegularLink(t *testing.T) {
	home := agyHome(t)
	assert.Error(t, BindAgy("not-a-uuid", convA))
	for _, bad := range []string{"", "../etc", "a/b", "-x", ".."} {
		assert.Error(t, BindAgy(agySession, bad), "%q", bad)
	}
	assert.Equal(t, "", AgyTranscript("../x"), "an id that is not a plain name names no path")

	// the link folder is one the agent can write: a link naming a path, or one that is a symlink, is not believed
	dir := filepath.Join(home, "coral-session-links")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(dir, agySession+".json"), []byte(`{"conversation_id":"../../x"}`), 0o600))
	assert.Equal(t, "", AgyConversation(agySession))
	target := filepath.Join(t.TempDir(), "elsewhere.json")
	require.NoError(t, os.WriteFile(target, []byte(`{"conversation_id":"`+convA+`"}`), 0o600))
	require.NoError(t, os.Remove(filepath.Join(dir, agySession+".json")))
	if err := os.Symlink(target, filepath.Join(dir, agySession+".json")); err == nil {
		assert.Equal(t, "", AgyConversation(agySession), "a symlinked link is not followed")
	}
}
