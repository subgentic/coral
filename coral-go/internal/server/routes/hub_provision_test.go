package routes

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/license"
	"github.com/subgentic/coral/internal/sshprov"
	"github.com/subgentic/coral/internal/store"
	terms "github.com/subgentic/coral/pkg/license"
)

const (
	provInstance = "0123456789abcdef0123456789abcdef"
	provKey      = "PROVISION-REMOTE-KEY-0123456789abcdef"
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
	pr.install = func(_ context.Context, p *provisionPlan, _ sshprov.Arch) error { // no network in a route test: the installer has its own tests
		p.setStep("install", stepOK, "Installed.")
		return nil
	}
	pr.startRemote = func(context.Context, *provisionPlan) (string, string, error) { return provInstance, provKey, nil }
	pr.checkHealth = func(context.Context, *store.RemoteServer, string) RemoteHealth {
		return RemoteHealth{Status: store.RemoteStatusOnline, Version: "9.9.9"}
	}
	r := chi.NewRouter()
	r.Post("/api/servers/provision/plan", pr.Plan)
	r.Post("/api/servers/provision/{plan}/connect", pr.Connect)
	r.Post("/api/servers/provision/{plan}/run", pr.Run)
	r.Get("/api/servers/provision/options", pr.Options)
	r.Get("/api/servers/provision/{plan}", pr.Status)
	r.Delete("/api/servers/provision/{plan}", pr.Cancel)
	return &provEnv{e: e, p: pr, dir: dir, router: r, known: known, sshLog: log, keyBlob: b64}
}

// do sends the request as the dashboard's person (the identity layer's classification of a signed-in browser).
func (pe *provEnv) do(method, path string, body any) (int, map[string]any) {
	return pe.send(true, method, path, body)
}

func (pe *provEnv) send(person bool, method, path string, body any) (int, map[string]any) {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	if person {
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	}
	w := httptest.NewRecorder()
	pe.router.ServeHTTP(w, req)
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
	code, _ = pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()})
	assert.Equal(t, 400, code)
	_, err = os.Stat(pe.known)
	assert.True(t, os.IsNotExist(err))

	// a key sent by the browser is not read at all: the one trusted is the scanned one
	code, v = pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest(), "accept_keys": true, "host_keys": []map[string]string{{"host": "evil", "type": "ssh-ed25519", "blob": "AAAA"}}})
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
	assert.Equal(t, "ok", steps[2].(map[string]any)["state"])
	assert.Equal(t, "ok", steps[3].(map[string]any)["state"])
	assert.Equal(t, "ok", steps[4].(map[string]any)["state"])
	srv, err := pe.e.h.store.Get(context.Background(), "ssh-box-example-com")
	require.NoError(t, err)
	assert.Equal(t, "ssh", srv.Transport)
	assert.Equal(t, "rich@box.example.com:22", srv.SSHTarget)
	assert.Equal(t, 8420, srv.RemotePort)
	assert.Equal(t, provInstance, srv.InstanceID)
	assert.Equal(t, "online", srv.Status)
	key, err := pe.e.h.store.DecryptedKey(context.Background(), "ssh-box-example-com")
	require.NoError(t, err)
	assert.Equal(t, provKey, key)
	raw, _ := json.Marshal(done)
	assert.NotContains(t, string(raw), provKey, "the remote's key is in the plan's answer")
	assert.NotContains(t, string(raw), provInstance)
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
	code, _ = pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest(), "accept_keys": true})
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
			code, _ := pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()})
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

// A script with the hub's API key is automation, not the person who accepts the terms or pins a host key.
func TestProvisionConnectAndRunAreAPersonsNotAScripts(t *testing.T) {
	pe := newProvEnv(t, "unknown", "Linux x86_64", true)
	_, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@box.example.com"})
	plan := v["plan"].(string)
	code, v := pe.send(false, "POST", "/api/servers/provision/"+plan+"/connect", nil)
	assert.Equal(t, 403, code, "%v", v)
	assert.Equal(t, "operator_only", v["code"])
	_, st := pe.do("GET", "/api/servers/provision/"+plan, nil)
	assert.Equal(t, "planned", st["phase"], "a refused connect changed the plan")
	if b, err := os.ReadFile(pe.sshLog); err == nil && len(b) > 0 {
		t.Errorf("a script's connect started ssh: %s", b)
	}
	_, _ = pe.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	code, _ = pe.send(false, "POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest(), "accept_keys": true})
	assert.Equal(t, 403, code)
	_, err := os.Stat(pe.known)
	assert.True(t, os.IsNotExist(err), "a script pinned a host key")
}

// Two Set up requests at once start one run, and the keys are written once.
func TestProvisionTwoRunsAtOnceStartOne(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	_, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@box.example.com"})
	plan := v["plan"].(string)
	_, v = pe.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	require.Equal(t, "connected", v["phase"], "%v", v)
	var mu sync.Mutex
	codes := map[int]int{}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, _ := pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()})
			mu.Lock()
			codes[code]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	assert.Equal(t, 1, codes[202], "%v", codes)
	assert.Equal(t, 7, codes[409], "%v", codes)
}

func TestKnownSystemKeepsOnlyWhatWeSupport(t *testing.T) {
	assert.Equal(t, "Linux x86_64", knownSystem("Linux x86_64\n"))
	assert.Equal(t, "Linux aarch64", knownSystem("Linux aarch64"))
	for _, s := range []string{"", "Darwin arm64", "Linux x86_64; rm -rf ~", "Linux x86_64\nwelcome to box", "\x1b[31mLinux x86_64", "Linux armv7l"} {
		assert.Equal(t, "", knownSystem(s), "%q", s)
	}
}

func TestProvisionInstallFailureIsAFixedSentence(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	pe.p.install = func(context.Context, *provisionPlan, sshprov.Arch) error {
		return &sshprov.ErrInstall{Step: "install", Msg: "The release could not be verified, so nothing was installed."}
	}
	_, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@box.example.com"})
	plan := v["plan"].(string)
	pe.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	code, _ := pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()})
	require.Equal(t, 202, code)
	failed := pe.waitPhase(t, plan, "failed")
	assert.Equal(t, "The release could not be verified, so nothing was installed.", failed["error"])
	steps := failed["steps"].([]any)
	assert.Equal(t, "failed", steps[2].(map[string]any)["state"])

	// an error that is not the installer's own words is not shown
	pe2 := newProvEnv(t, "known", "Linux x86_64", true)
	pe2.p.install = func(context.Context, *provisionPlan, sshprov.Arch) error {
		return errors.New("scp: /home/rich/.ssh/id_rsa: permission denied")
	}
	_, v = pe2.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@box.example.com"})
	plan = v["plan"].(string)
	pe2.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	pe2.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()})
	failed = pe2.waitPhase(t, plan, "failed")
	assert.Equal(t, "Could not install Coral on that computer.", failed["error"])
	b, _ := json.Marshal(failed)
	assert.NotContains(t, string(b), "id_rsa")
}

func runToEnd(t *testing.T, pe *provEnv, want string) map[string]any {
	t.Helper()
	_, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@box.example.com"})
	plan := v["plan"].(string)
	_, v = pe.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	require.Equal(t, "connected", v["phase"], "%v", v)
	code, _ := pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()})
	require.Equal(t, 202, code)
	return pe.waitPhase(t, plan, want)
}

func TestProvisionTellsTheHubWhenItRegistersAServer(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	var mu sync.Mutex
	var heard []string
	pe.p.SetStatusListener(func(id, status string) { mu.Lock(); heard = append(heard, id+":"+status); mu.Unlock() })
	runToEnd(t, pe, "done")
	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, []string{"ssh-box-example-com:online"}, heard)
}

func TestProvisionRegistersNothingWhenTheHubCannotReachTheNewServer(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	pe.p.checkHealth = func(context.Context, *store.RemoteServer, string) RemoteHealth {
		return RemoteHealth{Status: store.RemoteStatusUnreachable, Err: "ssh: connect to host box.example.com port 22: Connection refused"}
	}
	failed := runToEnd(t, pe, "failed")
	assert.Equal(t, "Coral started, but this hub could not reach it over SSH.", failed["error"])
	_, err := pe.e.h.store.Get(context.Background(), "ssh-box-example-com")
	assert.Error(t, err)
	b, _ := json.Marshal(failed)
	assert.NotContains(t, string(b), "Connection refused")
}

func TestProvisionNeverTakesAnotherServersPlaceOrKey(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	_, err := pe.e.h.store.AddSSH(context.Background(), "old-name", "Old", "u@other.example.com:22", 8420, provInstance, "the-old-servers-key-0123456789")
	require.NoError(t, err)
	failed := runToEnd(t, pe, "failed")
	assert.Equal(t, "That computer is already registered under another name.", failed["error"])
	key, _ := pe.e.h.store.DecryptedKey(context.Background(), "old-name")
	assert.Equal(t, "the-old-servers-key-0123456789", key, "the existing server's key was replaced")
	_, err = pe.e.h.store.Get(context.Background(), "ssh-box-example-com")
	assert.Error(t, err)
}

func TestProvisionStartFailureIsAFixedSentenceAndHidesTheCause(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	pe.p.startRemote = func(context.Context, *provisionPlan) (string, string, error) {
		return "", "", errors.New("tmux: /home/rich/.ssh/secret: no server running " + provKey)
	}
	failed := runToEnd(t, pe, "failed")
	assert.Equal(t, "Could not start Coral on that computer.", failed["error"])
	b, _ := json.Marshal(failed)
	assert.NotContains(t, string(b), provKey)
	assert.NotContains(t, string(b), "secret")
	steps := failed["steps"].([]any)
	assert.Equal(t, "failed", steps[3].(map[string]any)["state"])
	assert.Equal(t, "pending", steps[4].(map[string]any)["state"])
}

func TestTermsPayloadAndLabelMatchWhatTheFarSideAccepts(t *testing.T) {
	label := setupAcceptanceLabel()
	assert.Regexp(t, `^[A-Za-z0-9._@-]{1,64}$`, label)
	assert.True(t, strings.HasPrefix(label, "hub-owner@"))
	var p map[string]string
	require.NoError(t, json.Unmarshal(termsPayload(label), &p))
	assert.Equal(t, license.EULAVersion, p["version"])
	assert.Equal(t, terms.EULADigest(), p["sha256"])
	assert.Equal(t, label, p["by"])
	assert.Len(t, p, 3, "no other field: the far side refuses one")
}

func TestProvisionRunWantsTheDigestOfTheTermsThatWereShown(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	_, v := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@box.example.com"})
	plan := v["plan"].(string)
	pe.do("POST", "/api/servers/provision/"+plan+"/connect", nil)
	for name, body := range map[string]map[string]any{
		"none":       {"accept_terms": true},
		"wrong":      {"accept_terms": true, "terms_sha256": strings.Repeat("0", 64)},
		"upper case": {"accept_terms": true, "terms_sha256": strings.ToUpper(terms.EULADigest())},
	} {
		code, _ := pe.do("POST", "/api/servers/provision/"+plan+"/run", body)
		assert.Equal(t, 409, code, name)
	}
	_, st := pe.do("GET", "/api/servers/provision/"+plan, nil)
	assert.Equal(t, "connected", st["phase"], "a refused run changed the plan")
	if b, err := os.ReadFile(pe.sshLog); err == nil && strings.Contains(string(b), "package.tar.gz") {
		t.Error("a run with the wrong digest started work")
	}
	code, _ := pe.do("POST", "/api/servers/provision/"+plan+"/run", map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()})
	assert.Equal(t, 202, code)
}

func TestProvisionOptionsListHostsAndTheTermsTheDigestCovers(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	require.NoError(t, os.WriteFile(filepath.Join(pe.dir, "config"), []byte("Host build-box *.wild !no\nHost -oProxyCommand=x\nHost second\n"), 0o600))
	code, v := pe.do("GET", "/api/servers/provision/options", nil)
	require.Equal(t, 200, code)
	assert.Equal(t, []any{"build-box", "second"}, v["hosts"])
	tm := v["terms"].(map[string]any)
	assert.Equal(t, license.EULAVersion, tm["version"])
	assert.Equal(t, terms.EULADigest(), tm["sha256"])
	sum := sha256.Sum256([]byte(tm["text"].(string)))
	assert.Equal(t, terms.EULADigest(), hex.EncodeToString(sum[:]), "the text shown is the text the digest covers")
	assert.Equal(t, setupAcceptanceLabel(), v["acceptance_label"])
	// an empty config is an empty list, not null
	require.NoError(t, os.Remove(filepath.Join(pe.dir, "config")))
	_, v = pe.do("GET", "/api/servers/provision/options", nil)
	assert.Equal(t, []any{}, v["hosts"])
}

// The 429 for too many setups at once is a per-action limit: marked, so the dashboard does not pause every poller for it (#3434).
func TestProvisionTooManyPlansIsAMarkedActionLimit(t *testing.T) {
	pe := newProvEnv(t, "known", "Linux x86_64", true)
	for i := 0; i < provisionMaxPlans; i++ {
		code, _ := pe.do("POST", "/api/servers/provision/plan", map[string]any{"target": "rich@host" + strings.Repeat("b", i+1) + ".example.com"})
		require.Equal(t, 201, code)
	}
	req := httptest.NewRequest("POST", "/api/servers/provision/plan", strings.NewReader(`{"target":"rich@one-more.example.com"}`))
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	w := httptest.NewRecorder()
	pe.router.ServeHTTP(w, req)
	require.Equal(t, http.StatusTooManyRequests, w.Code)
	assert.Equal(t, "action", w.Header().Get(httputil.ActionLimitHeader), "an unmarked 429 pauses every poller on the page")
	assert.Contains(t, w.Body.String(), "setup_in_progress")
}
