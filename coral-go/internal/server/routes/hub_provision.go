package routes

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/sshprov"
	"github.com/subgentic/coral/internal/store"
)

// Setting a Coral server up on another computer over SSH, from the self-hosted hub (#11370). The routes are hub mode only and the Operator's (agent tokens are refused by the identity census).
//
// The flow is three presses, each a separate request, and the hub holds everything between them (nothing the browser sends is trusted for what is run or trusted):
//
//	POST /api/servers/provision/plan            the owner names a target; the answer is the host and the step plan to confirm. Nothing connects yet.
//	POST /api/servers/provision/{plan}/connect  the owner confirms the host and steps. The hub connects (strict host keys); a host never seen is scanned and its fingerprints are returned.
//	POST /api/servers/provision/{plan}/run      the owner presses Set up (this is the acceptance of the terms, which the dialog shows) and confirms the fingerprints shown: the hub trusts the keys
//	                                            IT scanned (held here under the plan, never a key from the browser) and runs the steps.
//	GET  /api/servers/provision/{plan}          the steps and where each is.   DELETE ...  cancels.
//
// Every line a person sees is one of this file's fixed sentences: ssh's own text, a path or a key never reaches the page.

const (
	provisionMaxPlans = 4
	provisionTTL      = 15 * time.Minute
)

// Phases of a plan.
const (
	phasePlanned    = "planned"    // shown, not confirmed
	phaseKeys       = "needs_keys" // connected; the host keys shown await the owner
	phaseConnected  = "connected"  // every host key known: ready for the run
	phaseConnecting = "connecting" // a connect is in progress (one at a time per plan)
	phaseTrusting   = "trusting"   // the confirmed keys are being written
	phaseRunning    = "running"
	phaseDone       = "done"
	phaseFailed     = "failed"
)

// Step states.
const (
	stepPending = "pending"
	stepRunning = "running"
	stepOK      = "ok"
	stepFailed  = "failed"
	stepSkipped = "skipped"
)

type provisionStep struct {
	Name   string `json:"name"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

type provisionKey struct {
	Host        string `json:"host"`
	Type        string `json:"type"`
	Fingerprint string `json:"fingerprint"`
}

type provisionPlan struct {
	mu       sync.Mutex
	ID       string
	Target   sshprov.Target
	ServerID string
	Label    string
	Mode     string
	phase    string
	steps    []provisionStep
	keys     []sshprov.HostKey // held here: what is trusted is THIS, never a key from a request
	system   string
	created  time.Time
	cancel   context.CancelFunc
	failure  string
}

func (p *provisionPlan) view() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	keys := make([]provisionKey, 0, len(p.keys))
	for _, k := range p.keys {
		keys = append(keys, provisionKey{Host: k.Host, Type: k.Type, Fingerprint: k.Fingerprint})
	}
	steps := append([]provisionStep(nil), p.steps...)
	v := map[string]any{"plan": p.ID, "target": p.Target.String(), "server_id": p.ServerID, "label": p.Label, "mode": p.Mode, "phase": p.phase, "steps": steps}
	if len(keys) > 0 && p.phase == phaseKeys {
		v["host_keys"] = keys
	}
	if p.system != "" {
		v["system"] = p.system
	}
	if p.failure != "" {
		v["error"] = p.failure
	}
	return v
}

func (p *provisionPlan) setStep(name, state, detail string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range p.steps {
		if p.steps[i].Name == name {
			p.steps[i].State, p.steps[i].Detail = state, detail
		}
	}
}

// Provisioner holds the plans and what they need from the hub.
type Provisioner struct {
	store    *store.RemoteServerStore
	runner   sshprov.Runner
	configs  func() string // the hub user's SSH config path
	known    func() string // the known_hosts file ssh reads
	mu       sync.Mutex
	plans    map[string]*provisionPlan
	runSteps func(ctx context.Context, p *provisionPlan) // the steps after the keys are trusted
	// install puts the hub's own release on the far computer (sshprov.Installer); a variable so a test does not reach the network.
	install   func(ctx context.Context, p *provisionPlan, arch sshprov.Arch) error
	startedAt time.Time
}

// NewProvisioner is the setup routes' handler. The paths are the hub user's own (never a path from a request).
func NewProvisioner(s *store.RemoteServerStore) *Provisioner {
	pr := &Provisioner{store: s, configs: sshprov.DefaultConfigPath, known: sshprov.DefaultKnownHostsPath, plans: map[string]*provisionPlan{}, startedAt: time.Now()}
	pr.runSteps = pr.detectSteps
	pr.install = pr.realInstall
	return pr
}

var serverIDChars = regexp.MustCompile(`[^a-z0-9-]+`)

// serverIDFor derives the id a new server gets from its host: ssh-<host>, lower case, trimmed to the id rules.
func serverIDFor(t sshprov.Target) string {
	name := t.Alias
	if name == "" {
		name = t.Host
	}
	id := "ssh-" + strings.Trim(serverIDChars.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(id) > 32 {
		id = strings.TrimRight(id[:32], "-")
	}
	return id
}

func (pr *Provisioner) plan(id string) *provisionPlan {
	pr.mu.Lock()
	defer pr.mu.Unlock()
	pr.expireLocked()
	return pr.plans[id]
}

func (pr *Provisioner) expireLocked() {
	for id, p := range pr.plans {
		if time.Since(p.created) > provisionTTL {
			if p.cancel != nil {
				p.cancel()
			}
			delete(pr.plans, id)
		}
	}
}

type planRequest struct {
	Target string `json:"target"` // user@host[:port]
	Alias  string `json:"alias"`  // a Host name of the owner's SSH config
	Mode   string `json:"mode"`   // "tmux" (the only one so far)
	Label  string `json:"label"`
}

// Plan handles POST /api/servers/provision/plan: validate, name the server, and return the host and the steps to confirm. Nothing connects.
func (pr *Provisioner) Plan(w http.ResponseWriter, r *http.Request) {
	var req planRequest
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := decodeJSON(r, &req); err != nil {
		errBadRequest(w, "invalid request body")
		return
	}
	if (req.Target == "") == (req.Alias == "") {
		errBadRequest(w, "give a target (user@host) or a name from your SSH config")
		return
	}
	var t sshprov.Target
	var err error
	if req.Alias != "" {
		names, _ := sshprov.ConfigHosts(pr.configs())
		found := false
		for _, n := range names {
			found = found || n == req.Alias
		}
		if !found {
			errBadRequest(w, "that name is not in your SSH config")
			return
		}
		t, err = sshprov.FromAlias(req.Alias)
	} else {
		t, err = sshprov.ParseTarget(req.Target)
	}
	if err != nil {
		errBadRequest(w, "that is not a valid SSH target")
		return
	}
	if req.Mode != "" && req.Mode != "tmux" {
		errBadRequest(w, "only tmux is available so far")
		return
	}
	id := serverIDFor(t)
	if store.ValidateRemoteID(id) != nil {
		errBadRequest(w, "that host cannot be turned into a server name")
		return
	}
	if _, err := pr.store.Get(r.Context(), id); err == nil {
		errConflict(w, "a server with that name is already registered")
		return
	} else if !errors.Is(err, store.ErrRemoteNotFound) {
		remoteErr(w, err)
		return
	}
	label := strings.TrimSpace(req.Label)
	if label == "" {
		label = id
	}
	if len(label) > 64 || strings.ContainsAny(label, "\x00\r\n") {
		errBadRequest(w, "the label is too long or has a control character")
		return
	}
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		errInternalServer(w, "internal error")
		return
	}
	p := &provisionPlan{ID: hex.EncodeToString(raw[:]), Target: t, ServerID: id, Label: label, Mode: "tmux", phase: phasePlanned, created: time.Now(), steps: planSteps()}
	pr.mu.Lock()
	pr.expireLocked()
	if len(pr.plans) >= provisionMaxPlans {
		pr.mu.Unlock()
		writeError(w, http.StatusTooManyRequests, "", "finish or cancel a setup in progress first")
		return
	}
	pr.plans[p.ID] = p
	pr.mu.Unlock()
	writeJSON(w, http.StatusCreated, p.view())
}

func planSteps() []provisionStep {
	return []provisionStep{
		{Name: "connect", Title: "Connect over SSH and check the host key", State: stepPending},
		{Name: "detect", Title: "Check the system and tmux", State: stepPending},
		{Name: "install", Title: "Download, verify and install Coral", State: stepPending},
		{Name: "start", Title: "Start Coral in tmux, listening on loopback only", State: stepPending},
		{Name: "register", Title: "Connect it to this hub", State: stepPending},
	}
}

// Connect handles POST /api/servers/provision/{plan}/connect: the owner confirmed the host and the steps. The hub connects with strict host-key checking. A host it has never seen is scanned and
// its fingerprints returned for the owner to confirm; a host whose key has CHANGED is refused and never offered for trust.
func (pr *Provisioner) Connect(w http.ResponseWriter, r *http.Request) {
	if !humanInputCaller(r) { // a script with the hub's API key is not the person who confirms a host
		provisionPersonOnly(w)
		return
	}
	p := pr.plan(chi.URLParam(r, "plan"))
	if p == nil {
		errNotFound(w, "no such setup")
		return
	}
	_, ok := p.moveFrom(phasePlanned, phaseKeys, phaseConnecting)
	if !ok {
		errConflict(w, "this setup is already past that step, or a connect is in progress")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	p.setStep("connect", stepRunning, "")
	res, err := pr.runner.Run(ctx, p.Target, sshprov.CmdUname)
	switch {
	case err == nil:
		p.mu.Lock()
		p.phase, p.keys, p.system = phaseConnected, nil, knownSystem(res.Stdout)
		p.mu.Unlock()
		p.setStep("connect", stepOK, "Connected; the host key is already known.")
	case errors.Is(err, sshprov.ErrHostKeyChanged):
		pr.fail(p, "connect", "The host key has changed since you last connected. This may be a different computer. Check it, then fix known_hosts yourself.")
	case errors.Is(err, sshprov.ErrHostKey):
		keys, kerr := pr.scan(ctx, p.Target)
		if kerr != nil {
			slog.Info("[provision] host key scan failed", "plan", p.ID, "error", kerr.Error())
			pr.fail(p, "connect", "Could not read the host's key.")
			break
		}
		p.mu.Lock()
		p.phase, p.keys = phaseKeys, keys
		p.mu.Unlock()
		p.setStep("connect", stepPending, "Confirm the host key below.")
	default:
		slog.Info("[provision] connect failed", "plan", p.ID, "error", err.Error())
		pr.fail(p, "connect", "Could not connect.")
	}
	writeJSON(w, http.StatusOK, p.view())
}

// scan reads the keys to show: one host for a typed target, every host of the path for an alias.
func (pr *Provisioner) scan(ctx context.Context, t sshprov.Target) ([]sshprov.HostKey, error) {
	if t.Alias != "" {
		return pr.runner.ScanAlias(ctx, t)
	}
	k, err := pr.runner.Scan(ctx, t.Host, t.Port)
	if err != nil {
		return nil, err
	}
	return []sshprov.HostKey{k}, nil
}

func (pr *Provisioner) fail(p *provisionPlan, step, sentence string) {
	p.setStep(step, stepFailed, sentence)
	p.mu.Lock()
	p.phase, p.failure = phaseFailed, sentence
	p.mu.Unlock()
}

type runRequest struct {
	AcceptKeys  bool `json:"accept_keys"`  // the fingerprints shown are the ones the owner means to trust
	AcceptTerms bool `json:"accept_terms"` // Set up: the terms the dialog shows are accepted
}

// Run handles POST /api/servers/provision/{plan}/run. Pressing Set up is the acceptance of the terms the dialog shows (accept_terms must be true); keys held under the plan are trusted only when the
// owner accepted them (accept_keys), and it is THOSE keys, scanned by the hub, that are written.
func (pr *Provisioner) Run(w http.ResponseWriter, r *http.Request) {
	if !humanInputCaller(r) { // Set up is the person's acceptance of the terms and of the host keys: never a script's
		provisionPersonOnly(w)
		return
	}
	p := pr.plan(chi.URLParam(r, "plan"))
	if p == nil {
		errNotFound(w, "no such setup")
		return
	}
	var req runRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if err := decodeJSON(r, &req); err != nil || !req.AcceptTerms {
		errBadRequest(w, "Set up needs the terms accepted")
		return
	}
	// One critical section decides what happens: two requests cannot both start a run, or both trust the keys.
	p.mu.Lock()
	var keys []sshprov.HostKey
	switch {
	case p.phase == phaseConnected:
		p.phase = phaseRunning
	case p.phase == phaseKeys && req.AcceptKeys:
		keys = append(keys, p.keys...)
		p.phase = phaseTrusting
	case p.phase == phaseKeys:
		p.mu.Unlock()
		errBadRequest(w, "confirm the host key first")
		return
	default:
		p.mu.Unlock()
		errConflict(w, "this setup is not ready to run, or is already running")
		return
	}
	p.mu.Unlock()
	if len(keys) > 0 {
		for _, k := range keys {
			if err := sshprov.Trust(pr.known(), k); err != nil {
				slog.Info("[provision] could not trust a host key", "plan", p.ID, "error", err.Error())
				pr.fail(p, "connect", "Could not save the host key.")
				writeJSON(w, http.StatusOK, p.view())
				return
			}
		}
		p.mu.Lock()
		p.keys, p.phase = nil, phaseRunning
		p.mu.Unlock()
		p.setStep("connect", stepOK, "Host key saved.")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	p.mu.Lock()
	p.cancel = cancel
	p.mu.Unlock()
	go func() {
		defer cancel()
		pr.runSteps(ctx, p)
	}()
	writeJSON(w, http.StatusAccepted, p.view())
}

func provisionPersonOnly(w http.ResponseWriter) {
	writeError(w, http.StatusForbidden, "operator_only", "only a person at the dashboard can set a server up")
}

var linuxSystemRe = regexp.MustCompile(`^Linux (x86_64|aarch64)$`)

// knownSystem is the remote's system text only when it is one we support, else empty: nothing else the far computer printed is kept or shown.
func knownSystem(s string) string {
	s = strings.TrimSpace(s)
	if linuxSystemRe.MatchString(s) {
		return s
	}
	return ""
}

// moveFrom sets the phase to next when it is one of from, in one critical section, and says what it was.
func (p *provisionPlan) moveFrom(from1, from2, next string) (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.phase != from1 && p.phase != from2 {
		return "", false
	}
	prev := p.phase
	p.phase = next
	return prev, true
}

// detectSteps is the first real step of the run: the system and tmux. The install steps follow in later commits; until they exist the run says so and stops, and registers nothing.
func (pr *Provisioner) detectSteps(ctx context.Context, p *provisionPlan) {
	p.setStep("detect", stepRunning, "")
	res, err := pr.runner.Run(ctx, p.Target, sshprov.CmdUname)
	if err != nil {
		pr.fail(p, "detect", "Could not connect.")
		return
	}
	sys := strings.TrimSpace(res.Stdout)
	if sys != "Linux x86_64" && sys != "Linux aarch64" {
		pr.fail(p, "detect", "This computer is not supported yet (Linux x86_64 or arm64 only).")
		return
	}
	tm, err := pr.runner.Run(ctx, p.Target, sshprov.CmdHasTmux)
	if err != nil {
		pr.fail(p, "detect", "Could not connect.")
		return
	}
	if tm.ExitCode != 0 {
		pr.fail(p, "detect", "tmux is not installed on that computer.")
		return
	}
	p.mu.Lock()
	p.system = knownSystem(sys)
	p.mu.Unlock()
	p.setStep("detect", stepOK, sys+", tmux found.")
	arch, _ := sshprov.ArchOf(sys)
	if err := pr.install(ctx, p, arch); err != nil {
		var ie *sshprov.ErrInstall
		msg := "Could not install Coral on that computer."
		if errors.As(err, &ie) {
			msg = ie.Msg // a fixed sentence of the installer's, never text from the far side or the network
		}
		slog.Info("[provision] install failed", "plan", p.ID, "step", "install")
		pr.fail(p, "install", msg)
		return
	}
	for _, s := range []string{"start", "register"} {
		p.setStep(s, stepSkipped, "Not available yet.")
	}
	p.mu.Lock()
	p.phase = phaseDone
	p.mu.Unlock()
}

// Status handles GET /api/servers/provision/{plan}.
func (pr *Provisioner) Status(w http.ResponseWriter, r *http.Request) {
	p := pr.plan(chi.URLParam(r, "plan"))
	if p == nil {
		errNotFound(w, "no such setup")
		return
	}
	writeJSON(w, http.StatusOK, p.view())
}

// Cancel handles DELETE /api/servers/provision/{plan}.
func (pr *Provisioner) Cancel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "plan")
	pr.mu.Lock()
	p := pr.plans[id]
	delete(pr.plans, id)
	pr.mu.Unlock()
	if p == nil {
		errNotFound(w, "no such setup")
		return
	}
	p.mu.Lock()
	if p.cancel != nil {
		p.cancel()
	}
	p.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]string{"status": "cancelled"})
}

// realInstall installs the hub's own release: the version is the one this hub runs (never a request's), the verifier is coral-update next to this executable, and each step is a fixed sentence.
func (pr *Provisioner) realInstall(ctx context.Context, p *provisionPlan, arch sshprov.Arch) error {
	in := sshprov.Installer{
		Runner:   pr.runner,
		Version:  config.Version,
		Helper:   sshprov.HelperPath(),
		Progress: func(_, state, detail string) { p.setStep("install", state, detail) },
	}
	_, err := in.Install(ctx, p.Target, arch)
	return err
}
