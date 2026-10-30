package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// startKind is what the start found: open sets config.DataDirMadePrivate for the folder after config.Load (whose own EnsureDataDir would
// set it on a machine whose temp folder other accounts can read, as a shared drive's is), private clears it, asFound leaves what EnsureDataDir
// decided (the real startup order).
type startKind int

const (
	private startKind = iota
	open
	asFound
	pending // private, with the marker an earlier start left when it did not finish
)

// oldSecrets writes what a data folder held before this start: an API key, a command-line token and a login token file.
func oldSecrets(t *testing.T, dir string) (key, cliToken, loginToken string) {
	t.Helper()
	key, cliToken, loginToken = strings.Repeat("a1", 32), strings.Repeat("c2", 32), strings.Repeat("d3", 32)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "api_key"), []byte(key), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, cloud.CLITokenFile), []byte(cliToken), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, auth.LoginTokenFile), []byte(loginToken), 0o600))
	return key, cliToken, loginToken
}

func openFolderServer(t *testing.T, dir string, kind startKind, before func(db *store.DB)) (*Server, *httptest.Server) {
	t.Helper()
	cfg := newE2EConfig(t, dir)
	t.Cleanup(func() {
		config.SetDataDirMadePrivate(dir, false)
		config.SetDataDirNotice("")
	})
	switch kind {
	case open:
		config.SetDataDirMadePrivate(dir, true)
		config.SetDataDirNotice("Coral made its data folder private to this user: Users could use it.")
	case private, pending:
		require.NoError(t, config.ClearDataDirExposed(dir)) // config.Load's own EnsureDataDir may have found this machine's temp folder open
		config.SetDataDirNotice("")
		if kind == pending {
			require.NoError(t, os.WriteFile(filepath.Join(dir, config.ExposedPendingFile), []byte("x"), 0o600))
		}
	}
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	if before != nil {
		before(db)
	}
	stack := newTermStack(t)
	srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)
	ts := httptest.NewServer(srv.Router())
	t.Cleanup(ts.Close)
	return srv, ts
}

func statusWithKey(t *testing.T, ts *httptest.Server, key string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/board/projects", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	return resp.StatusCode
}

// A start that made the data folder private renews the API key: the old one is refused at once and the new one works. The command-line
// token and the login token are new too (they are at every start), and the notice says what was renewed and names the stored remote Coral.
func TestAStartAfterAnOpenDataFolderReplacesTheAPIKey(t *testing.T) {
	dir := t.TempDir()
	oldKey, oldCLI, oldLogin := oldSecrets(t, dir)
	srv, ts := openFolderServer(t, dir, open, func(db *store.DB) {
		_, err := store.NewRemoteServerStore(db, dir).Add(context.Background(), "b", "build box", "http://127.0.0.1:9", strings.Repeat("e4", 32), true)
		require.NoError(t, err)
	})

	newKey := srv.keyStore.Key()
	assert.NotEqual(t, oldKey, newKey, "the API key is replaced")
	assert.Equal(t, http.StatusUnauthorized, statusWithKey(t, ts, oldKey), "the old key is refused at once")
	assert.Equal(t, http.StatusOK, statusWithKey(t, ts, newKey))
	onDisk, err := auth.ReadAPIKey(dir)
	require.NoError(t, err)
	assert.Equal(t, newKey, onDisk, "and kept: the next start does not bring the old one back")

	cli, err := cloud.ReadCLIToken(dir)
	require.NoError(t, err)
	assert.NotEqual(t, oldCLI, cli, "the command-line token is new")
	login, err := srv.WriteLoginToken()
	require.NoError(t, err)
	assert.NotEqual(t, oldLogin, login, "the login token is new")

	notice := config.DataDirNotice()
	assert.True(t, strings.HasPrefix(notice, "Coral made its data folder private"), "EnsureDataDir's own sentence comes first: %s", notice)
	assert.Contains(t, notice, "the conversations and board messages")
	assert.Contains(t, notice, "Coral replaced the API key")
	assert.Contains(t, notice, "coral api-key prints it")
	assert.Contains(t, notice, "the API keys of the other Corals stored here among them.")
	assert.Contains(t, notice, "the API keys of the other Corals stored here (build box): make a new key on each of those computers")
	b, err := store.NewRemoteServerStore(srv.db, dir).Get(context.Background(), "b")
	require.NoError(t, err)
	require.NotNil(t, b.KeyExposedSince, "the stored server is marked: Settings > Servers keeps saying it")
	assert.NotContains(t, notice, "Coral Hub", "no link is stored")
	assert.NotContains(t, notice, "password", "no password is set")
	assert.NotContains(t, notice, ".db_key", "no database key")
}

// Control: a start whose data folder was private already keeps its API key and adds nothing to the notice.
func TestAStartWithAPrivateDataFolderKeepsTheAPIKey(t *testing.T) {
	dir := t.TempDir()
	oldKey, _, _ := oldSecrets(t, dir)
	srv, ts := openFolderServer(t, dir, private, nil)
	assert.Equal(t, oldKey, srv.keyStore.Key())
	assert.Equal(t, http.StatusOK, statusWithKey(t, ts, oldKey))
	assert.Empty(t, config.DataDirNotice())
}

// The notice names only what applies, and a stored remote's label as plain printable text.
func TestOpenFolderWordsNameOnlyWhatApplies(t *testing.T) {
	plain := openFolderWords(openFolderFacts{keyReplaced: true, tokensRevoked: true, done: true})
	assert.Equal(t, "Until then other accounts on this computer could read what is in it: the conversations and board messages, and the keys and tokens. "+
		"So Coral replaced the API key: scripts and computers that use it need the new one (coral api-key prints it). Browser sign-ins from before no longer work. "+
		"Agent tokens from before no longer work, so an agent still running from before needs a restart.", plain)

	all := openFolderWords(openFolderFacts{keyReplaced: true, tokensRevoked: true, done: true, remotes: []string{"a", "b"}, hubLinked: true, password: true, dbKey: true})
	assert.True(t, strings.HasPrefix(all, "Until then other accounts on this computer could read what is in it: the conversations and board messages, and the keys and tokens, "+
		"the API keys of the other Corals stored here among them. So Coral replaced the API key"), all)
	assert.Contains(t, all, " needs a restart. Only you can replace the rest: ")
	for _, want := range []string{
		"the API keys of the other Corals stored here (a, b): make a new key on each of those computers and enter it here again",
		"the Coral Hub link: unlink and link again in Settings > Network and Hub",
		"the password: set a new one",
		"the database key (.db_key): it can't be changed without re-encrypting the databases",
	} {
		assert.Contains(t, all, want)
	}

	var many []string
	for i := range 7 {
		many = append(many, fmt.Sprintf("r%d", i))
	}
	assert.Contains(t, openFolderWords(openFolderFacts{keyReplaced: true, tokensRevoked: true, done: true, remotes: many}), "(r0, r1, r2, r3, r4, r5, r6)", "each one by name")

	odd := openFolderWords(openFolderFacts{keyReplaced: true, tokensRevoked: true, done: true, remotes: []string{"evil\x1b[31m\u202ename" + strings.Repeat("x", 60)}})
	assert.NotContains(t, odd, "\x1b")
	assert.NotContains(t, odd, "\u202e")
	assert.Contains(t, odd, "evil[31mname"+strings.Repeat("x", 28)+"…")

	failed := openFolderWords(openFolderFacts{tokensRevoked: true})
	assert.Contains(t, failed, "Coral could not replace the API key (coral.log says why), so the old one still works.")
	assert.NotContains(t, failed, "Browser sign-ins")
	assert.True(t, strings.HasSuffix(failed, " Coral tries again at its next start."), failed)

	again := openFolderWords(openFolderFacts{again: true, keyReplaced: true, tokensRevoked: true, done: true})
	assert.True(t, strings.HasPrefix(again, "Coral found its data folder had been open to other accounts, and an earlier start did not finish replacing what was in it. Until then"), again)
	assert.NotContains(t, again, "tries again")
}

// Only the start that made the folder private replaces the key: a second start of the same folder (a restart in place, in the same process)
// keeps the new key and the sign-ins made with it.
func TestOnlyTheStartThatMadeTheFolderPrivateReplacesTheKey(t *testing.T) {
	dir := t.TempDir()
	oldSecrets(t, dir)
	first, _ := openFolderServer(t, dir, open, nil)
	key := first.keyStore.Key()
	first.Close()
	again, _ := openFolderServer(t, dir, asFound, nil)
	assert.Equal(t, key, again.keyStore.Key(), "the second start keeps the key the first one made")
}

// A marker left by an earlier start that did not finish (it crashed, or something could not be replaced) is done again by the next start,
// even though that start finds the folder private; once everything is replaced the marker goes, and the start after that keeps the key.
func TestAStartRedoesWhatAnEarlierStartLeftUnfinished(t *testing.T) {
	dir := t.TempDir()
	oldKey, _, _ := oldSecrets(t, dir)
	first, ts := openFolderServer(t, dir, pending, nil)
	newKey := first.keyStore.Key()
	assert.NotEqual(t, oldKey, newKey, "the key is replaced although EnsureDataDir found nothing to do")
	assert.Equal(t, http.StatusUnauthorized, statusWithKey(t, ts, oldKey))
	assert.NoFileExists(t, filepath.Join(dir, config.ExposedPendingFile), "done: the marker is gone")
	assert.True(t, strings.HasPrefix(config.DataDirNotice(), "Coral found its data folder had been open to other accounts, and an earlier start did not finish"), config.DataDirNotice())
	first.Close()

	again, _ := openFolderServer(t, dir, private, nil)
	assert.Equal(t, newKey, again.keyStore.Key(), "the next start has nothing left to do")
}
