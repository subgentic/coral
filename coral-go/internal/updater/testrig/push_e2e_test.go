package testrig

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/updater/push"
	"github.com/subgentic/coral/internal/updater/stage"
	"github.com/subgentic/coral/internal/updater/verify"
)

// The push end to end (#15379), in process: a release signed under the fake Sigstore is staged by the real check (the sender's step), carried through the real stream into a second data folder by the real
// receive (the remote's step), and the remote's own apply-side verification (stage.Reverify, with its own pins and trust) accepts it. Then the case that matters most: a sender or a wire that swaps the
// package AND the record still gets past receive's transfer check, and the remote's verification refuses it, because the trust is the remote's, not the sender's.
func sendThroughPush(t *testing.T, r *rig, version string, tamper func(map[string][]byte)) (remoteData string, err error) {
	t.Helper()
	staged, lerr := stage.LoadStaged(r.cfg.DataDir)
	require.NoError(t, lerr)
	asset := Asset(version)
	files, ferr := push.FilesOf(staged.Dir, asset)
	require.NoError(t, ferr)
	if tamper != nil {
		contents := map[string][]byte{}
		for _, f := range files {
			rc, _ := f.Open()
			var b bytes.Buffer
			b.ReadFrom(rc)
			rc.Close()
			contents[f.Name] = b.Bytes()
		}
		tamper(contents)
		files = nil
		for _, n := range push.Names(asset) {
			b := contents[n]
			files = append(files, push.File{Name: n, Size: int64(len(b)), Open: func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(b)), nil }})
		}
	}
	var wire bytes.Buffer
	require.NoError(t, push.Write(&wire, asset, files))
	remoteData = t.TempDir()
	return remoteData, push.Receive(&wire, filepath.Join(remoteData, stage.UpdatesDir, stage.StagingDir), version, asset, stage.DefaultMaxPackage)
}

func TestPushedReleaseIsAcceptedByTheRemotesOwnVerification(t *testing.T) {
	r := newAPIRig(t)
	rel := r.publish(Spec{Version: "1.4.131", Sequence: 7})
	require.Equal(t, stage.ResultStaged, r.check().Result)
	remote, err := sendThroughPush(t, r, "1.4.131", nil)
	require.NoError(t, err)
	got, err := stage.LoadStaged(remote)
	require.NoError(t, err)
	rec, err := stage.Reverify(r.cfg.Verifier, r.cfg.Pins, got, r.cfg.Asset, verify.State{}, r.cfg.Installed, time.Now(), stage.DefaultMaxPackage)
	require.NoError(t, err, "the remote's own verification accepts what was pushed")
	assert.Equal(t, "1.4.131", rec.Version)
	onDisk, err := os.ReadFile(got.PackagePath)
	require.NoError(t, err)
	assert.Equal(t, rel.Package, onDisk, "byte for byte the released package")
}

func TestASwappedPackageWithAMatchingRecordPassesTheTransferCheckAndNotTheRemotesVerification(t *testing.T) {
	r := newAPIRig(t)
	r.publish(Spec{Version: "1.4.131", Sequence: 7})
	require.Equal(t, stage.ResultStaged, r.check().Result)
	evil := []byte("not the release")
	remote, err := sendThroughPush(t, r, "1.4.131", func(files map[string][]byte) {
		files[Asset("1.4.131")] = evil
		var rec verify.Record
		require.NoError(t, json.Unmarshal(files["record.json"], &rec))
		h := sha256.Sum256(evil)
		rec.PackageSHA256 = hex.EncodeToString(h[:])
		files["record.json"], _ = json.Marshal(rec)
	})
	require.NoError(t, err, "receive's hash check only guards a damaged transfer: the record travels in the same stream")
	got, err := stage.LoadStaged(remote)
	require.NoError(t, err)
	_, err = stage.Reverify(r.cfg.Verifier, r.cfg.Pins, got, r.cfg.Asset, verify.State{}, r.cfg.Installed, time.Now(), stage.DefaultMaxPackage)
	var f *verify.Failure
	require.ErrorAs(t, err, &f, "the remote refuses it")
	assert.Equal(t, verify.StagePackage, f.Stage)
}

func TestAnAlteredSumsFileIsRefusedByTheRemotesVerification(t *testing.T) {
	r := newAPIRig(t)
	r.publish(Spec{Version: "1.4.131", Sequence: 7})
	require.Equal(t, stage.ResultStaged, r.check().Result)
	remote, err := sendThroughPush(t, r, "1.4.131", func(files map[string][]byte) { files[stage.SumsFile] = append(files[stage.SumsFile], '\n', '#') })
	require.NoError(t, err)
	got, err := stage.LoadStaged(remote)
	require.NoError(t, err)
	_, err = stage.Reverify(r.cfg.Verifier, r.cfg.Pins, got, r.cfg.Asset, verify.State{}, r.cfg.Installed, time.Now(), stage.DefaultMaxPackage)
	require.Error(t, err)
}
