package transcriptlink

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var (
	hermesSession = "5f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b"
	hermesIDOne   = "local-" + strings.Repeat("1", 64)
	hermesIDTwo   = "local-" + strings.Repeat("2", 64)
)

// #11831: Hermes keys its sessions by its own id (local- and 64 hex), not Coral's. Its hooks name that id in every payload, and the hook binds the two; the chat reads the Hermes session the link names.
func TestBindHermesLinksASessionToItsHermesSession(t *testing.T) {
	data := t.TempDir()
	assert.Equal(t, "", HermesSession(data, hermesSession), "no link yet")
	require.NoError(t, BindHermes(data, hermesSession, hermesIDOne))
	assert.Equal(t, hermesIDOne, HermesSession(data, hermesSession))
	require.NoError(t, BindHermes(data, hermesSession, hermesIDOne), "the same again is a no-op")
	assert.Equal(t, "", HermesSession(data, "6f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b"), "another session has no link")
	// /new in Hermes starts another session in the same process: the link follows it
	require.NoError(t, BindHermes(data, hermesSession, hermesIDTwo))
	assert.Equal(t, hermesIDTwo, HermesSession(data, hermesSession))
}

func TestBindHermesRefusesWhatIsNotAnID(t *testing.T) {
	data := t.TempDir()
	for _, id := range []string{"", "d7b90358", "../" + hermesIDOne, hermesIDOne + "0", strings.ToUpper(hermesIDOne), "latest", "local-x"} {
		assert.Error(t, BindHermes(data, hermesSession, id), id)
	}
	for _, s := range []string{"", "../x", "claude-" + hermesSession, strings.ToUpper(hermesSession), "a"} {
		assert.Error(t, BindHermes(data, s, hermesIDOne), s)
	}
	entries, _ := os.ReadDir(data)
	assert.Empty(t, entries, "nothing was written")
}

// The link folder is one the agent can write: a file there is read as a capped regular file, never a link, and its id is believed only in the Hermes form.
func TestHermesSessionDoesNotBelieveABadLinkFile(t *testing.T) {
	data := t.TempDir()
	dir := filepath.Join(data, "hermes-session-links")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	p := filepath.Join(dir, hermesSession+".json")
	for name, body := range map[string]string{
		"not json": "xx", "wrong id": `{"hermes_id":"../etc/passwd"}`, "banner id": `{"hermes_id":"d7b90358"}`, "no key": `{}`,
		"oversize": `{"hermes_id":"` + hermesIDOne + `","pad":"` + strings.Repeat("x", maxLinkBytes) + `"}`,
	} {
		require.NoError(t, os.WriteFile(p, []byte(body), 0o600))
		assert.Equal(t, "", HermesSession(data, hermesSession), name)
	}
	if runtime.GOOS != "windows" {
		real := filepath.Join(t.TempDir(), "real.json")
		require.NoError(t, os.WriteFile(real, []byte(`{"hermes_id":"`+hermesIDOne+`"}`), 0o600))
		require.NoError(t, os.Remove(p))
		require.NoError(t, os.Symlink(real, p))
		assert.Equal(t, "", HermesSession(data, hermesSession), "a link is not read")
	}
	assert.Equal(t, "", HermesSession(data, "not-a-session"))
	assert.Equal(t, "", HermesSession("", hermesSession))
}
