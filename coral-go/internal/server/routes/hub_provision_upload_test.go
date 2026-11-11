package routes

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/sshprov"
	"github.com/subgentic/coral/internal/store"
	terms "github.com/subgentic/coral/pkg/license"
)

// #15691: the package source of a set up or an upgrade, and the upload route behind "Upload a package".

// upload sends body as the raw request body to the plan's upload route, as a person at the dashboard or not.
func (pe *provEnv) upload(person bool, plan, kind string, body []byte) (int, map[string]any) {
	req := httptest.NewRequest(http.MethodPost, "/api/servers/provision/"+plan+"/upload?kind="+kind, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	if person {
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	}
	w := httptest.NewRecorder()
	pe.router.ServeHTTP(w, req)
	return w.Code, decodeMap(w)
}

func toString(v any) string { return fmt.Sprint(v) }

// upgradeWithUploads makes an upgrade plan that is connected, with a folder for uploads.
func (me *manageEnv) upgradeWithUploads(t *testing.T) (plan, root string) {
	t.Helper()
	root = filepath.Join(t.TempDir(), "provision-uploads")
	me.p.SetUploadDir(root)
	_, v := me.plan(t, "upgrade", nil)
	plan = v["plan"].(string)
	_, st := me.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	require.Equal(t, "connected", st["phase"])
	return plan, root
}

func filesUnder(t *testing.T, root string) []string {
	var out []string
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			out = append(out, p)
		}
		return nil
	})
	return out
}

func TestAnUploadIsSavedPrivatelyAndTheAnswerHasItsSizeAndHashNeverItsPath(t *testing.T) {
	me := newManageEnv(t)
	plan, root := me.upgradeWithUploads(t)
	body := []byte("a release package")
	code, v := me.upload(true, plan, "package", body)
	require.Equal(t, 200, code, "%v", v)
	sum := sha256.Sum256(body)
	assert.Equal(t, hex.EncodeToString(sum[:]), v["sha256"])
	assert.EqualValues(t, len(body), v["bytes"])
	for k, val := range v {
		assert.NotContains(t, strings.ToLower(k+": "+toString(val)), root, "the answer names a path")
	}
	files := filesUnder(t, root)
	require.Len(t, files, 1)
	st, err := os.Stat(files[0])
	require.NoError(t, err)
	if true {
		assert.Equal(t, os.FileMode(0o600), st.Mode().Perm(), "the file is the hub user's only")
		ds, _ := os.Stat(filepath.Dir(files[0]))
		assert.Equal(t, os.FileMode(0o700), ds.Mode().Perm(), "so is its folder")
	}
	// the plan's own view says what was uploaded (size and hash), never where
	_, view := me.do("GET", "/api/servers/provision/"+plan, nil)
	up, _ := view["uploads"].(map[string]any)
	require.NotNil(t, up, "%v", view)
	assert.NotContains(t, toString(view), root)
}

// Failing-first: a script (an agent token, no dashboard) cannot upload.
func TestOnlyAPersonCanUpload(t *testing.T) {
	me := newManageEnv(t)
	plan, root := me.upgradeWithUploads(t)
	code, _ := me.upload(false, plan, "package", []byte("x"))
	assert.Equal(t, 403, code)
	assert.Empty(t, filesUnder(t, root))
}

func TestAnUploadIsRefusedWhenItIsMalformedOrTooBigAndNothingIsKept(t *testing.T) {
	me := newManageEnv(t)
	plan, root := me.upgradeWithUploads(t)
	for name, tc := range map[string]struct {
		kind string
		body []byte
		want int
	}{
		"an unknown kind":       {"script", []byte("x"), 400},
		"an empty file":         {"package", nil, 400},
		"sums over their cap":   {"sums", bytes.Repeat([]byte("a"), uploadMaxSums+1), 413},
		"a bundle over its cap": {"bundle", bytes.Repeat([]byte("a"), uploadMaxBundle+1), 413},
	} {
		code, _ := me.upload(true, plan, tc.kind, tc.body)
		assert.Equal(t, tc.want, code, name)
	}
	assert.Empty(t, filesUnder(t, root), "a refused upload leaves nothing")
	code, _ := me.upload(true, "nosuchplan", "package", []byte("x"))
	assert.Equal(t, 404, code)
}

func TestOnlyASetUpOrAnUpgradeTakesAPackageAndOnlyBeforeItStarts(t *testing.T) {
	me := newManageEnv(t)
	{
		other := newManageEnv(t)
		other.p.SetUploadDir(filepath.Join(t.TempDir(), "u"))
		_, v := other.plan(t, "stop", nil)
		stop, _ := v["plan"].(string)
		require.NotEmpty(t, stop, "%v", v)
		code, _ := other.upload(true, stop, "package", []byte("x"))
		assert.Equal(t, 400, code, "a stop takes no package")
	}
	plan, _ := me.upgradeWithUploads(t)
	code, _ := me.upload(true, plan, "package", []byte("pkg"))
	require.Equal(t, 200, code)
	me.p.checkHealth = func(context.Context, *store.RemoteServer, string) RemoteHealth {
		return RemoteHealth{Status: store.RemoteStatusOnline, Version: config.ReportedVersion()}
	}
	code, _ = me.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"package_source": "upload", "accept_terms": true, "terms_sha256": terms.EULADigest()})
	require.Equal(t, 202, code)
	me.waitPhase(t, plan, "done")
	code, _ = me.upload(true, plan, "package", []byte("late"))
	assert.Equal(t, 409, code, "a plan that has run takes no more files")
}

func TestUploadsAreRefusedWithoutAFolderToHoldThem(t *testing.T) {
	me := newManageEnv(t)
	_, v := me.plan(t, "upgrade", nil)
	plan := v["plan"].(string)
	me.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	code, _ := me.upload(true, plan, "package", []byte("x"))
	assert.Equal(t, 409, code)
}

// Run: the source is validated before anything starts, an upload source needs an uploaded package, and the plan stays ready after a refusal.
func TestRunValidatesThePackageSourceAndKeepsThePlanReadyWhenRefused(t *testing.T) {
	me := newManageEnv(t)
	plan, _ := me.upgradeWithUploads(t)
	for name, src := range map[string]string{"an unknown source": "scp", "upload with nothing uploaded": "upload"} {
		code, v := me.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"package_source": src})
		assert.Equal(t, 400, code, "%s: %v", name, v)
	}
	_, st := me.do("GET", "/api/servers/provision/"+plan, nil)
	assert.Equal(t, "connected", st["phase"], "a refused run starts nothing")
	assert.Equal(t, sshprov.SourceFar, st["package_source"], "the default is the far computer downloading it")
}

// The plan's source and uploaded files reach the installer, and the uploaded files are gone when the run ends.
func TestTheChosenSourceAndTheUploadedFilesReachTheInstallerAndAreRemovedAfterTheRun(t *testing.T) {
	me := newManageEnv(t)
	plan, root := me.upgradeWithUploads(t)
	for kind, body := range map[string]string{"package": "pkg", "sums": "sums", "bundle": "bundle"} {
		code, v := me.upload(true, plan, kind, []byte(body))
		require.Equal(t, 200, code, "%v", v)
	}
	var seen sshprov.Installer
	var seenBodies map[string]string
	me.p.install = func(_ context.Context, p *provisionPlan, _ sshprov.Arch) error {
		seen = me.p.installerFor(p)
		seenBodies = map[string]string{}
		for k, path := range map[string]string{"package": seen.Upload.Package, "sums": seen.Upload.Sums, "bundle": seen.Upload.Bundle} {
			b, err := os.ReadFile(path)
			require.NoError(t, err)
			seenBodies[k] = string(b)
		}
		me.mu.Lock()
		me.version = config.ReportedVersion() // the new release answers once it is installed
		me.mu.Unlock()
		p.setStep("install", stepOK, "Installed.")
		return nil
	}
	code, _ := me.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"package_source": "upload", "accept_terms": true, "terms_sha256": terms.EULADigest()})
	require.Equal(t, 202, code)
	me.waitPhase(t, plan, "done")
	assert.Equal(t, sshprov.SourceUpload, seen.Source)
	assert.Equal(t, map[string]string{"package": "pkg", "sums": "sums", "bundle": "bundle"}, seenBodies)
	require.Eventually(t, func() bool { return len(filesUnder(t, root)) == 0 }, 5*time.Second, 20*time.Millisecond, "the uploaded package was kept after the run")
}

func TestTheHubDownloadsSourceReachesTheInstallerWithNoUploadedFiles(t *testing.T) {
	me := newManageEnv(t)
	plan, _ := me.upgradeWithUploads(t)
	var got sshprov.Installer
	me.p.install = func(_ context.Context, p *provisionPlan, _ sshprov.Arch) error {
		got = me.p.installerFor(p)
		me.mu.Lock()
		me.version = config.ReportedVersion() // the new release answers once it is installed
		me.mu.Unlock()
		p.setStep("install", stepOK, "Installed.")
		return nil
	}
	code, _ := me.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"package_source": "hub", "accept_terms": true, "terms_sha256": terms.EULADigest()})
	require.Equal(t, 202, code)
	me.waitPhase(t, plan, "done")
	assert.Equal(t, sshprov.SourceHub, got.Source)
	assert.Equal(t, sshprov.Upload{}, got.Upload)
}

func TestCancellingAPlanRemovesItsUploads(t *testing.T) {
	me := newManageEnv(t)
	plan, root := me.upgradeWithUploads(t)
	code, _ := me.upload(true, plan, "package", []byte("pkg"))
	require.Equal(t, 200, code)
	require.Len(t, filesUnder(t, root), 1)
	code, _ = me.do("DELETE", "/api/servers/provision/"+plan, nil)
	require.Equal(t, 200, code)
	assert.Empty(t, filesUnder(t, root))
}

func TestStartupEmptiesWhatAnEarlierRunLeft(t *testing.T) {
	me := newManageEnv(t)
	root := filepath.Join(t.TempDir(), "provision-uploads")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "plan-old"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(root, "plan-old", "package"), []byte("x"), 0o600))
	me.p.SetUploadDir(root)
	assert.Empty(t, filesUnder(t, root))
}

// #15699 (Security's SHOULD on #15691): a cancel or an expiry that lands between the moment an upload is read and the moment it is recorded must not panic (the plan's table was emptied) or leave a file behind: the late upload is refused cleanly.
func TestACancelLandingWhileAnUploadArrivesRefusesItCleanly(t *testing.T) {
	me := newManageEnv(t)
	plan, root := me.upgradeWithUploads(t)
	p := me.p.plan(plan)
	require.NotNil(t, p)
	me.p.beforeUploadCommit = func(pp *provisionPlan) { pp.removeUploads() } // the cancel lands exactly here
	code, v := me.upload(true, plan, "package", []byte("pkg"))
	assert.Equal(t, 409, code, "%v", v)
	assert.Empty(t, filesUnder(t, root), "the late upload left a file")
	assert.Empty(t, p.uploadsViewLockedCopy(), "the plan holds nothing")
}

func TestAnUploadToAPlanWhoseFilesWereRemovedIsRefusedAndMakesNoFolder(t *testing.T) {
	me := newManageEnv(t)
	plan, root := me.upgradeWithUploads(t)
	me.p.plan(plan).removeUploads() // cancelled or expired before any file arrived
	code, v := me.upload(true, plan, "package", []byte("pkg"))
	assert.Equal(t, 409, code, "%v", v)
	entries, _ := os.ReadDir(root)
	assert.Empty(t, entries, "a plan that is over made a folder for the file")
}

// uploadsViewLockedCopy is uploadsViewLocked taken under the plan's lock (for tests).
func (p *provisionPlan) uploadsViewLockedCopy() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.uploadsViewLocked()
}
