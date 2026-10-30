package routes

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/sshprov"
)

type provEnv struct {
	e       *rsEnv
	p       *Provisioner
	dir     string
	router  chi.Router
	known   string
	sshLog  string
	keyBlob string
}

// newProvEnv wires a Provisioner to a fake ssh and a fake ssh-keyscan. mode: "known" (the host key is in known_hosts: ssh answers), "unknown" (ssh exits 255 with the host key refusal until the key is trusted),
// "changed" (the key has changed).
func newProvEnv(t *testing.T, mode, uname string, tmux bool) *provEnv {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake ssh is a shell script")
	}
	e := newRSEnv(t)
	dir := t.TempDir()
	known := filepath.Join(dir, "known_hosts")
	log := filepath.Join(dir, "ssh.log")
	blob := make([]byte, 4, 64)
	binary.BigEndian.PutUint32(blob, 11)
	blob = append(blob, "ssh-ed25519"...)
	blob = append(blob, 0, 0, 0, 8, 1, 2, 3, 4, 5, 6, 7, 8)
	b64 := base64.StdEncoding.EncodeToString(blob)
	tm := "1"
	if tmux {
		tm = "0"
	}
	script := `#!/bin/sh
for a in "$@"; do last="$a"; echo "$a" >> '` + log + `'; done
case "$last" in
  *"uname -sm"*)
    case "` + mode + `" in
      known) echo '` + uname + `'; exit 0;;
      changed) echo '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@' >&2; exit 255;;
      unknown) if grep -q 'box.example.com' '` + known + `' 2>/dev/null; then echo '` + uname + `'; exit 0; fi; echo 'Host key verification failed.' >&2; exit 255;;
    esac;;
  *"command -v tmux"*) exit ` + tm + `;;
esac
exit 0
`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "ssh"), []byte(script), 0o700))
	scan := "#!/bin/sh\necho 'box.example.com ssh-ed25519 " + b64 + "'\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "ssh-keyscan"), []byte(scan), 0o700))
	pr := NewProvisioner(e.h.store)
	pr.runner = sshprov.Runner{SSH: filepath.Join(dir, "ssh"), KeyScan: filepath.Join(dir, "ssh-keyscan")}
	pr.configs = func() string { return filepath.Join(dir, "config") }
	pr.known = func() string { return known }
	r := chi.NewRouter()
	r.Post("/api/servers/provision/plan", pr.Plan)
	r.Post("/api/servers/provision/{plan}/connect", pr.Connect)
	r.Post("/api/servers/provision/{plan}/run", pr.Run)
	r.Get("/api/servers/provision/{plan}", pr.Status)
	r.Delete("/api/servers/provision/{plan}", pr.Cancel)
	return &provEnv{e: e, p: pr, dir: dir, router: r, known: known, sshLog: log, keyBlob: b64}
}

func (pe *provEnv) do(method, path string, body any) (int, map[string]any) {
	e := &rsEnv{router: pe.router}
	w := e.do(method, path, body)
	return w.Code, decodeMap(w)
}

func decodeMap(w *httptest.ResponseRecorder) map[string]any {
	m := map[string]any{}
	_ = jsonUnmarshal(w.Body.Bytes(), &m)
	return m
}

func (pe *provEnv) waitPhase(t *testing.T, plan, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, v := pe.do("GET", "/api/servers/provision/"+plan, nil)
		if v["phase"] == want || time.Now().After(deadline) {
			require.Equal(t, want, v["phase"], "%v", v)
			return v
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestProvisionPlanValidatesAndConnectsNothing(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	for _, bad := range []map[string]any{
		{}, {"target": "x"}, {"target": "rich@-oProxyCommand=x"}, {"target": "rich@box.example.com;id"}, {"target": "rich@box.example.com", "alias": "x"},
		{"alias": "not-in-config"}, {"alias": "-oProxyCommand=x"}, {"target": "rich@box.example.com", "mode": "systemd"},
	} {
		code, v := pe.do("POST", "/api/servers/provision/plan", bad)
		assert.Equal(t, 400, code, "%v %v", bad, v)
	}
	code, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@box.example.com:2222", "label": "Build box"})
	require.Equal(t, 201, code, "%v", v)
	assert.Equal(t, "planned", v["phase"])
	assert.Equal(t, "ssh-box-example-com", v["server_id"])
	assert.Equal(t, "rich@box.example.com:2222", v["target"])
	assert.Len(t, v["steps"], 5)
	if b, err := os.ReadFile(pe.sshLog); err == nil && len(b) > 0 {
		t.Errorf("a plan started ssh: %s", b)
	}
}

func TestProvisionRefusesAnIdThatIsTaken(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	_, err := pe.e.h.store.AddSSH(context.Background(), "ssh-box-example-com", "Taken", "u@other", 8420, "inst-1", routeSecret)
	require.NoError(t, err)
	code, _ := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@box.example.com"})
	assert.Equal(t, 409, code)
}

func TestProvisionUnknownHostShowsTheScannedKeyAndTrustsOnlyThatAfterAccept(t *testing.T) {
	pe := newProvEnv(t, "unknown", "Linux x86_64", true)
	_, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@box.example.com"})
	plan := v["plan"].(string)

	code, v := pe.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	require.Equal(t, 200, code)
	require.Equal(t, "needs_keys", v["phase"], "%v", v)
	keys := v["host_keys"].([]any)
	require.Len(t, keys, 1)
	sum := sha256.Sum256(mustB64(t, pe.keyBlob))
	assert.Equal(t, "SHA256:"+base64.RawStdEncoding.EncodeToString(sum[:]), keys[0].(map[string]any)["fingerprint"])
	_, err := os.Stat(pe.known)
	assert.True(t, os.IsNotExist(err), "a key was trusted before the owner accepted it")

	// no acceptance of the terms, or of the keys: nothing runs
	code, _ = pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_keys": true})
	assert.Equal(t, 400, code)
	code, _ = pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true})
	assert.Equal(t, 400, code)
	_, err = os.Stat(pe.known)
	assert.True(t, os.IsNotExist(err))

	// a key sent by the browser is not read at all: the one trusted is the scanned one
	code, v = pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "accept_keys": true, "host_keys": []map[string]string{{"host": "evil", "type": "ssh-ed25519", "blob": "AAAA"}}})
	require.Equal(t, 202, code, "%v", v)
	b, err := os.ReadFile(pe.known)
	require.NoError(t, err)
	assert.Equal(t, "box.example.com ssh-ed25519 "+pe.keyBlob+"\n", string(b))
	st, _ := os.Stat(pe.known)
	assert.Equal(t, os.FileMode(0o600), st.Mode().Perm())

	done := pe.waitPhase(t, plan, "done")
	steps := done["steps"].([]any)
	assert.Equal(t, "ok", steps[0].(map[string]any)["state"])
	assert.Equal(t, "ok", steps[1].(map[string]any)["state"])
	assert.Equal(t, "skipped", steps[2].(map[string]any)["state"], "the install steps do not exist yet and say so")
	_, err = pe.e.h.store.Get(context.Background(), "ssh-box-example-com")
	assert.Error(t, err, "a run that installed nothing registered a server")
}

func TestProvisionRefusesAChangedHostKeyAndNeverOffersIt(t *testing.T) {
	pe := newProvEnv(t, "changed", "Linux x86_64", true)
	_, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@box.example.com"})
	plan := v["plan"].(string)
	code, v := pe.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	require.Equal(t, 200, code)
	assert.Equal(t, "failed", v["phase"])
	assert.Nil(t, v["host_keys"])
	assert.Contains(t, v["error"], "has changed")
	code, _ = pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "accept_keys": true})
	assert.Equal(t, 409, code)
	_, err := os.Stat(pe.known)
	assert.True(t, os.IsNotExist(err))
}

func TestProvisionDetectStopsOnAnUnsupportedSystemOrNoTmux(t *testing.T) {
	for name, c := range map[string]struct {
		uname string
		tmux  bool
		want  string
	}{
		"macos":  {"Darwin arm64", true, "not supported"},
		"notmux": {"Linux x86_64", false, "tmux is not installed"},
	} {
		t.Run(name, func(t *testing.T) {
			pe := newProvEnv(t, "known", c.uname, c.tmux)
			_, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@box.example.com"})
			plan := v["plan"].(string)
			_, v = pe.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
			require.Equal(t, "connected", v["phase"], "%v", v)
			code, _ := pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true})
			require.Equal(t, 202, code)
			failed := pe.waitPhase(t, plan, "failed")
			assert.Contains(t, failed["error"], c.want)
		})
	}
}

func TestProvisionLimitsPlansAndCancels(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	var first string
	for i := 0; i < provisionMaxPlans; i++ {
		code, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@host" + strings.Repeat("a", i+1) + ".example.com"})
		require.Equal(t, 201, code)
		if i == 0 {
			first = v["plan"].(string)
		}
	}
	code, _ := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@one-more.example.com"})
	assert.Equal(t, http.StatusTooManyRequests, code)
	code, _ = pe.do("DELETE", "/api/servers/provision/"+first, nil)
	assert.Equal(t, 200, code)
	code, _ = pe.do("GET", "/api/servers/provision/"+first, nil)
	assert.Equal(t, 404, code)
	code, _ = pe.do("POST", "/api/servers/provision/nope/connect", nil)
	assert.Equal(t, 404, code)
}

func TestProvisionAliasMustBeInTheOwnersSSHConfig(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	require.NoError(t, os.WriteFile(filepath.Join(pe.dir, "config"), []byte("Host build-box\n  HostName 10.0.0.2\n"), 0o600))
	code, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"alias": "build-box"})
	require.Equal(t, 201, code, "%v", v)
	assert.Equal(t, "ssh-build-box", v["server_id"])
	assert.Equal(t, "build-box (from your SSH config)", v["target"])
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	require.NoError(t, err)
	return b
}
