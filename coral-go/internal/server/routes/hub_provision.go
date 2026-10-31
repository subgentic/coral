package routes

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/license"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/sshprov"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/hubowner"
	terms "github.com/subgentic/coral/pkg/license"
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
	Kind     string // "" or "setup": a new server; "upgrade", "stop", "remove": one already registered (#11370)
	Delete   bool   // remove: also delete the data (the key, the history, the instance id)
	phase    string
	steps    []provisionStep
	keys     []sshprov.HostKey // held here: what is trusted is THIS, never a key from a request
	system   string
	created  time.Time
	cancel   context.CancelFunc
	failure  string
}

const (
	kindSetup   = "setup"
	kindUpgrade = "upgrade"
	kindStop    = "stop"
	kindRemove  = "remove"
)

func (p *provisionPlan) kind() string {
	if p.Kind == "" {
		return kindSetup
	}
	return p.Kind
}

func (p *provisionPlan) view() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	keys := make([]provisionKey, 0, len(p.keys))
	for _, k := range p.keys {
		keys = append(keys, provisionKey{Host: k.Host, Type: k.Type, Fingerprint: k.Fingerprint})
	}
	steps := append([]provisionStep(nil), p.steps...)
	v := map[string]any{"plan": p.ID, "target": p.Target.String(), "server_id": p.ServerID, "label": p.Label, "mode": p.Mode, "kind": p.kind(), "phase": p.phase, "steps": steps}
	if p.Kind == kindRemove {
		v["delete_data"] = p.Delete
	}
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
	install func(ctx context.Context, p *provisionPlan, arch sshprov.Arch) error
	// startRemote starts the installed Coral in tmux and reads the remote's instance id and API key; checkHealth asks the new server, through its SSH stream, whether it answers. Variables for tests.
	startRemote func(ctx context.Context, p *provisionPlan) (instanceID, key string, err error)
	checkHealth func(ctx context.Context, rs *store.RemoteServer, key string) RemoteHealth
	// installOwner puts the secret this hub signs the computer's owner stamps with on the computer (#11378), by the far Coral's own command, the secret on stdin; a variable for tests.
	installOwner func(ctx context.Context, p *provisionPlan, secret string) error
	version      string                  // the release this hub runs and the only one it installs (config.Version; a test sets its own)
	onRemoved    func(id string)         // a remove took the server out of the registry
	notify       func(id, status string) // tells the hub's remote workers a server was added (the same hook the registry's edits use)
	startedAt    time.Time
}

// SetStatusListener sets who hears that a server was registered (the hub's remote workers, as for the registry's own edits).
func (pr *Provisioner) SetStatusListener(f func(id, status string)) { pr.notify = f }

// NewProvisioner is the setup routes' handler. The paths are the hub user's own (never a path from a request).
func NewProvisioner(s *store.RemoteServerStore) *Provisioner {
	pr := &Provisioner{store: s, configs: sshprov.DefaultConfigPath, known: sshprov.DefaultKnownHostsPath, plans: map[string]*provisionPlan{}, startedAt: time.Now()}
	pr.version = config.Version
	pr.runSteps = pr.runPlan
	pr.install = pr.realInstall
	pr.startRemote = pr.realStartRemote
	pr.checkHealth = pr.realCheckHealth
	pr.installOwner = func(ctx context.Context, p *provisionPlan, secret string) error {
		return pr.runner.InstallOwnerSecret(ctx, p.Target, pr.version, p.ServerID, secret)
	}
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
	// ServerID and Action manage a server that is already registered and was set up over SSH: "upgrade", "stop" or "remove" (DeleteData with remove). The target is the registry's, never the request's.
	ServerID   string `json:"server_id"`
	Action     string `json:"action"`
	DeleteData bool   `json:"delete_data"`
}

// Plan handles POST /api/servers/provision/plan: validate, name the server, and return the host and the steps to confirm. Nothing connects.
func (pr *Provisioner) Plan(w http.ResponseWriter, r *http.Request) {
	var req planRequest
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := decodeJSON(r, &req); err != nil {
		errBadRequest(w, "invalid request body")
		return
	}
	if req.ServerID != "" {
		pr.planManage(w, r, req)
		return
	}
	if req.Action != "" || req.DeleteData {
		errBadRequest(w, "an action needs the server it is for")
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
	p := &provisionPlan{ID: newPlanID(), Target: t, ServerID: id, Label: label, Mode: "tmux", phase: phasePlanned, created: time.Now(), steps: planSteps()}
	pr.mu.Lock()
	pr.expireLocked()
	if len(pr.plans) >= provisionMaxPlans {
		pr.mu.Unlock()
		httputil.WriteActionLimit(w, 0, "setup_in_progress", "finish or cancel a setup in progress first") // a per-action limit, marked so the dashboard does not take it for an overloaded server (#3434)
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
	// TermsSHA256 is the digest of the terms text the dialog showed. The hub compares it with its own terms before it runs anything: an acceptance is of the text that was in front of the person.
	TermsSHA256 string `json:"terms_sha256"`
	// Confirm is the server's id, typed by the person, for a remove.
	Confirm string `json:"confirm"`
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
	if err := decodeJSON(r, &req); err != nil {
		errBadRequest(w, "invalid request body")
		return
	}
	// A setup and an upgrade put Coral on the computer and record the terms: they need the press and the digest of the text that was shown. Stop and remove do not touch the terms.
	if k := p.kind(); k == kindSetup || k == kindUpgrade {
		if !req.AcceptTerms {
			errBadRequest(w, "Set up needs the terms accepted")
			return
		}
		if req.TermsSHA256 != terms.EULADigest() {
			errConflict(w, "The terms changed since you read them. Reload this page and read them again.")
			return
		}
	}
	if p.kind() == kindRemove && req.Confirm != p.ServerID {
		errBadRequest(w, "Remove needs the server's name typed to confirm")
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
	safego.Go("provision run", func() {
		defer cancel()
		// A panic in a step must not leave the plan "running" until it expires (15 minutes): the plan fails with one fixed sentence, then the panic goes on to safego, which logs it and keeps the server up.
		defer func() {
			if r := recover(); r != nil {
				pr.failPanicked(p)
				panic(r)
			}
		}()
		pr.runSteps(ctx, p)
	})
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
	arch, ok := pr.detect(ctx, p)
	if !ok {
		return
	}
	pr.setupSteps(ctx, p, arch)
}

// detect checks the far computer's system and tmux; on a failure it has failed the plan and says false.
func (pr *Provisioner) detect(ctx context.Context, p *provisionPlan) (sshprov.Arch, bool) {
	p.setStep("detect", stepRunning, "")
	res, err := pr.runner.Run(ctx, p.Target, sshprov.CmdUname)
	if err != nil {
		pr.fail(p, "detect", "Could not connect.")
		return "", false
	}
	sys := strings.TrimSpace(res.Stdout)
	if sys != "Linux x86_64" && sys != "Linux aarch64" {
		pr.fail(p, "detect", "This computer is not supported yet (Linux x86_64 or arm64 only).")
		return "", false
	}
	tm, err := pr.runner.Run(ctx, p.Target, sshprov.CmdHasTmux)
	if err != nil {
		pr.fail(p, "detect", "Could not connect.")
		return "", false
	}
	if tm.ExitCode != 0 {
		pr.fail(p, "detect", "tmux is not installed on that computer.")
		return "", false
	}
	p.mu.Lock()
	p.system = knownSystem(sys)
	p.mu.Unlock()
	p.setStep("detect", stepOK, sys+", tmux found.")
	arch, _ := sshprov.ArchOf(sys)
	return arch, true
}

// setupSteps is the rest of a setup: install, start, register.
func (pr *Provisioner) setupSteps(ctx context.Context, p *provisionPlan, arch sshprov.Arch) {
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
	if err := pr.finish(ctx, p); err != nil {
		var ie *sshprov.ErrInstall
		step, msg := "start", "Could not start Coral on that computer."
		if errors.As(err, &ie) {
			step, msg = ie.Step, ie.Msg
		}
		slog.Info("[provision] failed", "plan", p.ID, "step", step)
		pr.fail(p, step, msg)
		return
	}
	p.mu.Lock()
	p.phase = phaseDone
	p.mu.Unlock()
}

// finish starts the installed Coral, reads what the hub needs and registers it. Every sentence is fixed: the key is held in a local variable, never in a log, an error, a step or the plan.
func (pr *Provisioner) finish(ctx context.Context, p *provisionPlan) error {
	p.setStep("start", stepRunning, "Starting Coral in tmux, listening on this computer's loopback only.")
	instanceID, key, err := pr.startRemote(ctx, p)
	if err != nil {
		return err
	}
	p.setStep("start", stepOK, "Coral is running in the tmux session coral-server.")

	p.setStep("register", stepRunning, "Connecting it to this hub over SSH.")
	rs := &store.RemoteServer{ID: p.ServerID, SSHTarget: p.Target.Stored(), RemotePort: sshprov.RemotePort}
	if h := pr.checkHealth(ctx, rs, key); h.Status != store.RemoteStatusOnline {
		return &sshprov.ErrInstall{Step: "register", Msg: "Coral started, but this hub could not reach it over SSH."}
	}
	if existing, err := pr.store.FindByInstance(ctx, instanceID); err != nil {
		return &sshprov.ErrInstall{Step: "register", Msg: "Could not read this hub's server list."}
	} else if existing != "" {
		if existing != p.ServerID {
			return &sshprov.ErrInstall{Step: "register", Msg: "That computer is already registered under another name."}
		}
		p.setStep("register", stepOK, "Already registered; nothing was changed.") // a re-run: the key and the row stay as they are
		return nil
	}
	// The owner stamp (#11378): a new secret for this computer, installed on it by its own command line before it is registered, so Approve and Request changes can work through this hub. A failure here does
	// not stop the registration; the page says the stamp is not set up.
	ownerSecret, serr := hubowner.NewSecret()
	ownerOK := serr == nil && pr.installOwner(ctx, p, ownerSecret) == nil
	if _, err := pr.store.AddSSH(ctx, p.ServerID, p.Label, rs.SSHTarget, rs.RemotePort, instanceID, key); err != nil {
		switch {
		case errors.Is(err, store.ErrRemoteExists):
			return &sshprov.ErrInstall{Step: "register", Msg: "A server with that name is already registered."}
		case errors.Is(err, store.ErrRemoteInstanceExists):
			return &sshprov.ErrInstall{Step: "register", Msg: "That computer is already registered under another name."}
		}
		return &sshprov.ErrInstall{Step: "register", Msg: "Could not save the server."}
	}
	if ownerOK {
		ownerOK = pr.store.SetOwnerSecret(ctx, p.ServerID, ownerSecret) == nil
	}
	_ = pr.store.SetStatus(ctx, p.ServerID, store.RemoteStatusOnline, "")
	if pr.notify != nil {
		pr.notify(p.ServerID, store.RemoteStatusOnline)
	}
	detail := "Registered. It appears in your server list."
	if !ownerOK {
		detail += " Approve and Request changes through this hub are not set up for it."
	}
	p.setStep("register", stepOK, detail)
	return nil
}

func (pr *Provisioner) realStartRemote(ctx context.Context, p *provisionPlan) (string, string, error) {
	fail := func(msg string) error { return &sshprov.ErrInstall{Step: "start", Msg: msg} }
	// Set up was pressed with the terms shown (Run checked accept_terms): the far Coral is given THAT acceptance, on stdin, bound to this release's terms. It is the only way a first start with no terminal gets past them.
	by := setupAcceptanceLabel()
	if err := pr.runner.AcceptTerms(ctx, p.Target, pr.version, termsPayload(by)); err != nil {
		return "", "", fail("Could not record your acceptance of the terms on that computer.")
	}
	slog.Info("[provision] terms accepted for a setup", "plan", p.ID, "version", license.EULAVersion, "by", by, "at", time.Now().UTC().Format(time.RFC3339))
	if err := pr.runner.StartTmux(ctx, p.Target, pr.version); err != nil {
		return "", "", fail("Could not start Coral on that computer.")
	}
	id, err := pr.runner.EnsureInstanceID(ctx, p.Target)
	if err != nil {
		return "", "", fail("Could not make this server's identity on that computer.")
	}
	key, err := pr.runner.ReadAPIKey(ctx, p.Target, pr.version)
	if err != nil {
		return "", "", fail("Coral started, but it did not make its key in time.")
	}
	return id, key, nil
}

// realCheckHealth asks the new server's /api/health through a one-off stream target, for up to 40 s (a Coral that has just made its key may not be listening yet).
func (pr *Provisioner) realCheckHealth(ctx context.Context, rs *store.RemoteServer, key string) RemoteHealth {
	t, err := newSSHTarget(rs, key)
	if err != nil {
		return RemoteHealth{Status: store.RemoteStatusUnreachable, Err: "could not connect"}
	}
	defer t.Close()
	deadline := time.Now().Add(40 * time.Second)
	for {
		h := CheckTargetHealth(ctx, t, 10*time.Second)
		if h.Status == store.RemoteStatusOnline || time.Now().After(deadline) || ctx.Err() != nil {
			return h
		}
		time.Sleep(3500 * time.Millisecond) // past the stream target's 3 s backoff after a failed dial
	}
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
		Version:  pr.version,
		Helper:   sshprov.HelperPath(),
		Progress: func(_, state, detail string) { p.setStep("install", state, detail) },
	}
	_, err := in.Install(ctx, p.Target, arch)
	return err
}

var labelUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// setupAcceptanceLabel is who the acceptance is recorded for: the hub's owner at this hub's computer, "hub-owner@<host>", in the label alphabet the far side checks.
func setupAcceptanceLabel() string {
	host, _ := os.Hostname()
	host = strings.Trim(labelUnsafe.ReplaceAllString(host, "-"), "-.")
	if host == "" {
		host = "hub"
	}
	l := "hub-owner@" + host
	if len(l) > 64 {
		l = l[:64]
	}
	return l
}

// termsPayload is the acceptance the far Coral reads on stdin: this hub's terms version and the digest of its text (the far Coral is the same release and refuses anything else), and who.
func termsPayload(by string) []byte {
	b, _ := json.Marshal(map[string]string{"version": license.EULAVersion, "sha256": terms.EULADigest(), "by": by})
	return b
}

func newPlanID() string {
	var raw [8]byte
	_, _ = rand.Read(raw[:])
	return hex.EncodeToString(raw[:])
}

// Options handles GET /api/servers/provision/options: what the setup dialog needs before a plan: the Host names of the hub user's SSH config (names only, concrete ones), the terms the person is about to
// accept (version, digest and text, so the dialog shows exactly what the digest it sends back covers), and the label the acceptance is recorded under.
func (pr *Provisioner) Options(w http.ResponseWriter, r *http.Request) {
	hosts, _ := sshprov.ConfigHosts(pr.configs())
	if hosts == nil {
		hosts = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"hosts":            hosts,
		"terms":            map[string]string{"version": license.EULAVersion, "sha256": terms.EULADigest(), "text": license.EULAText},
		"acceptance_label": setupAcceptanceLabel(),
	})
}

// failPanicked fails a plan whose run panicked: the step that was running is failed and the plan says, in one fixed sentence, that it stopped. Nothing of the panic is in the sentence.
func (pr *Provisioner) failPanicked(p *provisionPlan) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range p.steps {
		if p.steps[i].State == stepRunning || p.steps[i].State == stepPending {
			p.steps[i].State, p.steps[i].Detail = stepFailed, "Something went wrong inside this hub."
			break
		}
	}
	p.phase, p.failure = phaseFailed, "Something went wrong inside this hub, so the setup stopped. Nothing more was done."
}
