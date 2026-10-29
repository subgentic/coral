package machinelaunch

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func goodRecord(name string) Record {
	return Record{Name: name, Provider: "digitalocean", Region: "nyc3", LaunchTag: "coral-launch-0123456789ab", DropletID: "4242", VPCID: vpcUUID, FirewallID: fwUUID, SSHKeyID: "ab:cd:ef:01", CredentialID: "5b6c0f2e-0000-4000-8000-000000000001", Created: time.Date(2026, 10, 29, 10, 0, 0, 0, time.UTC)}
}

// The file is 0600 in a 0700 folder, holds ids, and survives a reopen.
func TestStateFileIsPrivateAndHoldsIdsOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "coral", "machines.json")
	s, err := OpenState(path)
	require.NoError(t, err)
	require.NoError(t, s.Put(goodRecord("m1")))
	require.NoError(t, s.Put(goodRecord("m2")))
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(path)
		require.NoError(t, err)
		assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm(), "the file is 0600")
		di, err := os.Stat(filepath.Dir(path))
		require.NoError(t, err)
		assert.Equal(t, os.FileMode(0o700), di.Mode().Perm(), "its folder is 0700")
	}
	b, err := os.ReadFile(path)
	require.NoError(t, err)
	for _, secret := range []string{"dop_v1_", "chb_", "chd_", "chk_", "ssh-", "BEGIN", "token", "password", "address", "ip"} {
		assert.NotContains(t, string(b), secret, "no secret and no address: ids only")
	}
	again, err := OpenState(path)
	require.NoError(t, err)
	assert.Equal(t, []Record{goodRecord("m1"), goodRecord("m2")}, again.Records())
	r, ok := again.Get("m2")
	require.True(t, ok)
	assert.Equal(t, "4242", r.DropletID)
	entries, _ := os.ReadDir(filepath.Dir(path))
	assert.Len(t, entries, 1, "no temporary file is left behind")
}

// Nothing that is not an id goes in, however it got there.
func TestStateFileRefusesAnythingThatIsNotAnId(t *testing.T) {
	s, err := OpenState(filepath.Join(t.TempDir(), "machines.json"))
	require.NoError(t, err)
	for field, mutate := range map[string]func(*Record){
		"a provider token as an id":     func(r *Record) { r.DropletID = "dop_v1_abcdef0123456789" },
		"a bootstrap credential":        func(r *Record) { r.CredentialID = "chb_0123456789abcdef" },
		"a destroy credential":          func(r *Record) { r.CredentialID = "chd_0123456789abcdef" },
		"a Hub key":                     func(r *Record) { r.SSHKeyID = "chk_0123" },
		"a private key":                 func(r *Record) { r.SSHKeyID = "-----BEGIN OPENSSH PRIVATE KEY-----" },
		"an id with a slash":            func(r *Record) { r.VPCID = "a/b" },
		"an id with a space":            func(r *Record) { r.FirewallID = "a b" },
		"a name that is not a hostname": func(r *Record) { r.Name = "Not A Host" },
		"a launch tag of another shape": func(r *Record) { r.LaunchTag = "mine" },
		"a very long id":                func(r *Record) { r.DropletID = strings.Repeat("1", 200) },
	} {
		r := goodRecord("m1")
		mutate(&r)
		assert.Error(t, s.Put(r), field)
	}
	assert.Empty(t, s.Records())
	_, err = os.Stat(s.path)
	assert.True(t, os.IsNotExist(err), "a refused record writes no file")
}

// A file this tool did not write is not trusted: a looser mode, a symlink, a field it does not know, a secret in it, a version it does not read.
func TestStateFileRefusesAFileItDoesNotTrust(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string, mode os.FileMode) string {
		p := filepath.Join(dir, name)
		require.NoError(t, os.WriteFile(p, []byte(body), mode))
		require.NoError(t, os.Chmod(p, mode))
		return p
	}
	good := `{"version":1,"machines":[{"name":"m1","provider":"digitalocean","region":"nyc3","launch_tag":"coral-launch-0123456789ab","droplet_id":"1","created":"2026-10-29T10:00:00Z"}]}`
	_, err := OpenState(write("ok.json", good, 0o600))
	require.NoError(t, err)

	cases := map[string]string{
		"an unknown field (a secret added by hand)": strings.Replace(good, `"droplet_id":"1"`, `"droplet_id":"1","token":"dop_v1_x"`, 1),
		"a secret in an id":                         strings.Replace(good, `"droplet_id":"1"`, `"droplet_id":"dop_v1_0123"`, 1),
		"another version":                           strings.Replace(good, `"version":1`, `"version":2`, 1),
		"not json":                                  "machines: []",
	}
	for name, body := range cases {
		_, err := OpenState(write(strings.ReplaceAll(name, " ", "_")+".json", body, 0o600))
		require.Error(t, err, name)
		assert.ErrorIs(t, err, ErrUnsafeStateFile, name)
		assert.NotContains(t, err.Error(), "dop_v1_0123", "the refusal does not echo it")
	}
	if runtime.GOOS != "windows" {
		_, err = OpenState(write("loose.json", good, 0o644))
		assert.ErrorIs(t, err, ErrUnsafeStateFile, "readable by others")
		link := filepath.Join(dir, "link.json")
		require.NoError(t, os.Symlink(filepath.Join(dir, "ok.json"), link))
		_, err = OpenState(link)
		assert.ErrorIs(t, err, ErrUnsafeStateFile, "a symlink is not followed")
	}
}

func TestStatePutReplacesAndRemoveIsIdempotent(t *testing.T) {
	s, err := OpenState(filepath.Join(t.TempDir(), "machines.json"))
	require.NoError(t, err)
	r := goodRecord("m1")
	require.NoError(t, s.Put(r))
	r.FirewallID = ""
	require.NoError(t, s.Put(r))
	got, _ := s.Get("m1")
	assert.Empty(t, got.FirewallID, "a step done is written down: the next delete skips it")
	require.NoError(t, s.Remove("m1"))
	require.NoError(t, s.Remove("m1"), "removing what is gone is fine")
	_, ok := s.Get("m1")
	assert.False(t, ok)
	again, err := OpenState(s.path)
	require.NoError(t, err)
	assert.Empty(t, again.Records())
}
