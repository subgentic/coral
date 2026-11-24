package live

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestFileStoreRoundTripsPrivatelyAndRefusesAFileItCannotRead(t *testing.T) {
	p := filepath.Join(t.TempDir(), "live_links.json")
	fs := FileStore{Path: p}
	ls, err := fs.Load()
	require.NoError(t, err)
	require.Empty(t, ls, "no file is no links")
	in := []Link{{ID: "L1", HubLink: hubA, Team: "team", State: StateLive, ConfirmedAt: time.Unix(1700000000, 0).UTC(), Approved: &Approved{AgentKeys: []string{"a"}}}}
	require.NoError(t, fs.Save(in))
	st, err := os.Stat(p)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), st.Mode().Perm())
	got, err := fs.Load()
	require.NoError(t, err)
	require.Equal(t, in, got)
	require.NoError(t, os.WriteFile(p, []byte("{broken"), 0o600))
	_, err = fs.Load()
	require.Error(t, err, "a broken file is an error, not an empty list")
	_, err = NewManager(Config{Store: fs, Source: func(string) LiveSource { return &mutSource{} }, Redactor: hubScan()})
	require.Error(t, err, "the manager does not start empty over a file it cannot read")
}

func TestTheGateIsShut(t *testing.T) {
	require.False(t, Open, "Coral Live ships shut: only a reviewed change flips it")
}
