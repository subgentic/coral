package startup

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// A start that made the data folder private revokes every agent session token from before, and the sweep removes their files (a Codex
// agent's stays for its session); a token minted afterwards works. Without that start, a live token and its file are kept (#13).
func TestAnOpenDataFolderRevokesTheAgentsSessionTokens(t *testing.T) {
	for _, open := range []bool{true, false} {
		home := t.TempDir()
		db, err := storetest.Open(t, filepath.Join(home, "sessions.db"))
		require.NoError(t, err)
		dir := filepath.Join(home, "session_tokens")
		require.NoError(t, os.MkdirAll(dir, 0o700))
		ctx := context.Background()
		old, err := db.MintSessionToken(ctx, "sid-codex", "codex-sid-codex")
		require.NoError(t, err)
		file := filepath.Join(dir, "t-codex")
		require.NoError(t, os.WriteFile(file, []byte(old), 0o600))

		config.SetDataDirMadePrivate(home, open)
		setupSessionTokens(db, home)
		config.SetDataDirMadePrivate(home, false)
		agent.SessionTokenMinter = nil

		_, err = db.SessionTokenOwnerOf(ctx, old)
		if open {
			assert.ErrorIs(t, err, store.ErrUnknownSessionToken, "the token from before is refused")
			assert.NoFileExists(t, file, "and its file is gone")
			fresh, err := db.MintSessionToken(ctx, "sid-codex", "codex-sid-codex")
			require.NoError(t, err)
			o, err := db.SessionTokenOwnerOf(ctx, fresh)
			require.NoError(t, err)
			assert.Equal(t, "codex-sid-codex", o.SessionName, "a token minted afterwards works")
		} else {
			assert.NoError(t, err, "control: a live token survives an ordinary start")
			assert.FileExists(t, file)
		}
		db.Close()
	}
}
