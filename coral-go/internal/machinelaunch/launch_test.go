package machinelaunch

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	launchTestToken      = "TOKEN-SECRET-dop_v1_0123"
	launchTestCredential = "chb_CREDENTIAL0123456789"
)

type stubProvider struct {
	calls      []string
	validate   error
	priceErr   error
	createErr  error
	waitErr    error
	deleteErr  error
	waitBlocks bool
	spec       Spec
	listed     []Instance
	listErr    error
}

func (s *stubProvider) Name() string { return "stubcloud" }
func (s *stubProvider) Validate(context.Context) error {
	s.calls = append(s.calls, "validate")
	return s.validate
}
func (s *stubProvider) Price(context.Context, string, string) (Price, error) {
	s.calls = append(s.calls, "price")
	return Price{HourlyUSD: 0.0357, MonthlyUSD: 24}, s.priceErr
}
func (s *stubProvider) Create(_ context.Context, spec Spec) (Instance, error) {
	s.calls = append(s.calls, "create")
	s.spec = spec
	if s.createErr != nil {
		return Instance{}, s.createErr
	}
	return Instance{ID: "42", Name: spec.Name, Status: StatusPending}, nil
}
func (s *stubProvider) WaitRunning(ctx context.Context, id string) (Instance, error) {
	s.calls = append(s.calls, "wait")
	if s.waitBlocks {
		<-ctx.Done()
		return Instance{}, ctx.Err()
	}
	if s.waitErr != nil {
		return Instance{}, s.waitErr
	}
	return Instance{ID: id, Name: s.spec.Name, Status: StatusRunning, IPv4: "203.0.113.7"}, nil
}
func (s *stubProvider) Delete(_ context.Context, id string) error {
	s.calls = append(s.calls, "delete:"+id)
	return s.deleteErr
}

type stubHub struct {
	labels []string
	err    error
	onMint func() // called when the credential is minted
}

func (h *stubHub) Mint(_ context.Context, label string) (string, error) {
	h.labels = append(h.labels, label)
	if h.onMint != nil {
		h.onMint()
	}
	return launchTestCredential, h.err
}

// stubSSH is an in-process SSH server standing in for the machine: it presents the host key it is given, accepts one login key, records every command and what came on its standard input, and answers the status
// command the way the machine's Coral does.
type stubSSH struct {
	ln         net.Listener
	addr       string
	mu         sync.Mutex
	commands   []string
	stdins     []string
	handshakes int
	authed     int // logins the server accepted: a key it knew
	mintAuthed int // authed at the moment the credential was minted (-1: never minted)
	status     string
}

func startStubSSH(t *testing.T, host ssh.Signer, login ssh.PublicKey) *stubSSH {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &stubSSH{ln: ln, addr: ln.Addr().String(), mintAuthed: -1, status: "Coral Hub: https://app.coralhub.dev\nState:     connected\nServer:    coral-1\nAccess:    launch\n"}
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		if login != nil && bytes.Equal(key.Marshal(), login.Marshal()) {
			s.mu.Lock()
			s.authed++
			s.mu.Unlock()
			return nil, nil
		}
		return nil, errors.New("unknown key")
	}}
	cfg.AddHostKey(host)
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(c, cfg)
		}
	}()
	return s
}

func (s *stubSSH) serve(c net.Conn, cfg *ssh.ServerConfig) {
	defer c.Close()
	sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
	s.mu.Lock()
	if err == nil {
		s.handshakes++
	}
	s.mu.Unlock()
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.UnknownChannelType, "no")
			continue
		}
		ch, creqs, err := nc.Accept()
		if err != nil {
			return
		}
		go func() {
			defer ch.Close()
			for r := range creqs {
				if r.Type != "exec" {
					_ = r.Reply(false, nil)
					continue
				}
				var cmd struct{ Command string }
				_ = ssh.Unmarshal(r.Payload, &cmd)
				_ = r.Reply(true, nil)
				in, _ := io.ReadAll(ch)
				s.mu.Lock()
				s.commands = append(s.commands, cmd.Command)
				s.stdins = append(s.stdins, string(in))
				out := ""
				if cmd.Command == statusCommand {
					out = s.status
				}
				s.mu.Unlock()
				_, _ = io.WriteString(ch, out)
				_, _ = ch.SendRequest("exit-status", false, binary.BigEndian.AppendUint32(nil, 0))
				return
			}
		}()
	}
	_ = sc.Close()
}

func (s *stubSSH) seen() (commands, stdins []string, handshakes int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.commands...), append([]string(nil), s.stdins...), s.handshakes
}

func hostSigner(t *testing.T, k *BootKeys) ssh.Signer {
	t.Helper()
	sg, err := ssh.NewSignerFromKey(k.hostPriv)
	if err != nil {
		t.Fatal(err)
	}
	return sg
}

func setup(p *stubProvider, h *stubHub) (Options, Deps, *bytes.Buffer) {
	o, d, out, _ := setupWith(nil, p, h)
	return o, d, out
}

// setupWith is setup with the stub machine returned. t may be nil: then the machine is never closed (the short tests that never reach SSH).
func setupWith(t *testing.T, p *stubProvider, h *stubHub) (Options, Deps, *bytes.Buffer, *stubSSH) {
	out := &bytes.Buffer{}
	keys, err := NewBootKeys()
	if err != nil {
		panic(err)
	}
	hostSg, _ := ssh.NewSignerFromKey(keys.hostPriv)
	var srv *stubSSH
	if t != nil {
		srv = startStubSSH(t, hostSg, keys.client.PublicKey())
	} else {
		ln, _ := net.Listen("tcp", "127.0.0.1:0")
		srv = &stubSSH{ln: ln, addr: ln.Addr().String(), mintAuthed: -1, status: "State:     connected\nServer:    coral-1\n"} // answers like a machine that enrolled: the tests that use it never reach SSH
		cfg := &ssh.ServerConfig{NoClientAuth: true}
		cfg.AddHostKey(hostSg)
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				go srv.serve(c, cfg)
			}
		}()
	}
	h.onMint = func() { srv.mu.Lock(); srv.mintAuthed = srv.authed; srv.mu.Unlock() }
	d := Deps{Provider: p, Hub: h, Out: out,
		Keys: func() (*BootKeys, error) { return keys, nil },
		UserData: func(k *BootKeys) (string, error) {
			spec := UserDataSpec{AllowSSHFrom: "203.0.113.9", CoralVersion: "2.0.3"}
			if err := k.FillUserData(&spec); err != nil {
				return "", err
			}
			return BuildUserData(spec)
		},
		Bootstrap: &SSHBootstrap{Addr: func(Instance) string { return srv.addr }, Window: 2 * time.Second, Every: 10 * time.Millisecond, EnrollWait: 2 * time.Second},
		Confirm:   func(string) (bool, error) { return true, nil }}
	return Options{Name: "coral-1", Region: "nyc3", Size: "s-2vcpu-4gb", HubURL: "https://app.coralhub.dev", SSHFrom: "203.0.113.9"}, d, out, srv
}

func TestLaunchHappyPathOrderLabelAndOutput(t *testing.T) {
	p, h := &stubProvider{}, &stubHub{}
	o, d, out, srv := setupWith(t, p, h)
	res, err := Launch(context.Background(), o, d)
	if err != nil || res.Instance.IPv4 != "203.0.113.7" || res.Enrollment.State != "connected" || res.Enrollment.Label != "coral-1" {
		t.Fatalf("%v %+v", err, res)
	}
	if got := strings.Join(p.calls, ","); got != "validate,price,create,wait" {
		t.Fatalf("calls: %s", got)
	}
	if len(h.labels) != 1 || h.labels[0] != "coral-1" {
		t.Fatalf("the credential's label is the machine's name: %v", h.labels)
	}
	if len(p.spec.Tags) != 2 || p.spec.Tags[0] != Tag {
		t.Fatalf("spec: %+v", p.spec)
	}
	// the user-data holds no credential, and the credential reached the machine on standard input only
	if strings.Contains(p.spec.UserData, launchTestCredential) || strings.Contains(p.spec.UserData, "chb_") {
		t.Fatalf("the user-data holds a credential:\n%s", p.spec.UserData)
	}
	cmds, stdins, _ := srv.seen()
	var delivered []string
	for i, c := range cmds {
		if strings.Contains(c, launchTestCredential) || strings.Contains(c, "chb_") {
			t.Fatalf("the credential is on a command line: %q", c)
		}
		if c == deliverCommand {
			delivered = append(delivered, stdins[i])
		}
	}
	if len(delivered) != 1 || delivered[0] != launchTestCredential {
		t.Fatalf("the credential goes once, on standard input, to the tmpfs file: %q (commands %q)", delivered, cmds)
	}
	if !strings.Contains(deliverCommand, "/run/coral/bootstrap.d/credential") || !strings.Contains(deliverCommand, "umask 077") {
		t.Fatalf("the file: %s", deliverCommand)
	}
	if cmds[len(cmds)-1] != doneCommand {
		t.Fatalf("the machine is told it may close SSH once enrolled: %q", cmds)
	}
	srv.mu.Lock()
	minted := srv.mintAuthed
	srv.mu.Unlock()
	if minted < 1 {
		t.Fatalf("the credential was minted before the pinned login (logins at the mint: %d)", minted)
	}
	for _, secret := range []string{launchTestToken, launchTestCredential} {
		if strings.Contains(out.String(), secret) {
			t.Fatalf("the output holds a secret: %s", out.String())
		}
	}
	if !strings.Contains(out.String(), "press Keep") || !strings.Contains(out.String(), "https://app.coralhub.dev") {
		t.Fatalf("the approve instruction is missing: %s", out.String())
	}
}

// The pin: a machine presenting another host key gets nothing: no credential is minted, nothing is sent, the machine is deleted, and the launch does not try again.
func TestLaunchHostKeyMismatchSendsNothingDeletesAndDoesNotRetry(t *testing.T) {
	p, h := &stubProvider{}, &stubHub{}
	o, d, out, _ := setupWith(t, p, h)
	other, err := NewBootKeys() // a machine whose host key is not the pinned one, that knows the login key
	if err != nil {
		t.Fatal(err)
	}
	impostor := startStubSSH(t, hostSigner(t, other), nil)
	impostor.mu.Lock()
	impostor.mu.Unlock()
	d.Bootstrap = &SSHBootstrap{Addr: func(Instance) string { return impostor.addr }, Window: 2 * time.Second, Every: 10 * time.Millisecond}
	_, err = Launch(context.Background(), o, d)
	if err == nil || !errors.Is(err, ErrHostKeyMismatch) || !strings.Contains(err.Error(), "was deleted") || !strings.Contains(err.Error(), "not retried") {
		t.Fatalf("a mismatch ends the launch and deletes the machine: %v", err)
	}
	if len(h.labels) != 0 {
		t.Fatalf("no credential is minted for a machine that failed the pin: %v", h.labels)
	}
	cmds, stdins, shakes := impostor.seen()
	if len(cmds) != 0 || len(stdins) != 0 || shakes != 0 {
		t.Fatalf("nothing was sent to it (commands %q, handshakes %d)", cmds, shakes)
	}
	if !strings.Contains(strings.Join(p.calls, ","), "delete:42") {
		t.Fatalf("the machine is deleted: %v", p.calls)
	}
	if strings.Contains(out.String(), launchTestCredential) {
		t.Fatalf("the output holds the credential")
	}
}

// SSH that never answers is waited for until the window closes, then the machine is deleted and no credential was minted.
func TestLaunchSSHNeverAnsweringDeletesTheMachineWithoutMinting(t *testing.T) {
	p, h := &stubProvider{}, &stubHub{}
	o, d, _, _ := setupWith(t, p, h)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().String()
	ln.Close() // nothing listens there
	d.Bootstrap = &SSHBootstrap{Addr: func(Instance) string { return dead }, Window: 150 * time.Millisecond, Every: 20 * time.Millisecond}
	_, err := Launch(context.Background(), o, d)
	if err == nil || !errors.Is(err, ErrSSHUnreachable) || len(h.labels) != 0 || !strings.Contains(strings.Join(p.calls, ","), "delete:42") {
		t.Fatalf("err %v, mints %v, calls %v", err, h.labels, p.calls)
	}
}

// A login the machine refuses (it does not have the launch's key) is waited out like a machine not ready, then ends the launch; the credential is never minted.
func TestLaunchRefusedLoginNeverMints(t *testing.T) {
	p, h := &stubProvider{}, &stubHub{}
	o, d, _, _ := setupWith(t, p, h)
	other, _ := NewBootKeys()
	keys := d.Keys
	d.Keys = func() (*BootKeys, error) {
		k, _ := keys()
		k.client = other.client
		k.ClientPublic = other.ClientPublic
		return k, nil
	} // a login key the machine was not given
	d.Bootstrap = &SSHBootstrap{Addr: d.Bootstrap.(*SSHBootstrap).Addr, Window: 150 * time.Millisecond, Every: 20 * time.Millisecond}
	_, err := Launch(context.Background(), o, d)
	if err == nil || len(h.labels) != 0 || !strings.Contains(strings.Join(p.calls, ","), "delete:42") {
		t.Fatalf("err %v, mints %v, calls %v", err, h.labels, p.calls)
	}
}

// A machine whose Coral never says it enrolled: the credential was delivered, the machine is deleted, and the person is told.
func TestLaunchEnrollmentNotConfirmedDeletesTheMachine(t *testing.T) {
	p, h := &stubProvider{}, &stubHub{}
	o, d, _, srv := setupWith(t, p, h)
	srv.mu.Lock()
	srv.status = "Coral Hub: https://app.coralhub.dev\nState:     retrying\n"
	srv.mu.Unlock()
	d.Bootstrap = &SSHBootstrap{Addr: d.Bootstrap.(*SSHBootstrap).Addr, Window: time.Second, Every: 10 * time.Millisecond, EnrollWait: 80 * time.Millisecond}
	_, err := Launch(context.Background(), o, d)
	if err == nil || !strings.Contains(err.Error(), "did not report that it enrolled") || !strings.Contains(strings.Join(p.calls, ","), "delete:42") {
		t.Fatalf("err %v, calls %v", err, p.calls)
	}
}

// A mint that fails after the handshake ends the launch and deletes the machine.
func TestLaunchMintFailureAfterTheHandshakeDeletesTheMachine(t *testing.T) {
	p, h := &stubProvider{}, &stubHub{err: &HubError{Status: 401}}
	o, d, _, srv := setupWith(t, p, h)
	_, err := Launch(context.Background(), o, d)
	cmds, _, _ := srv.seen()
	if err == nil || len(cmds) != 0 || !strings.Contains(strings.Join(p.calls, ","), "delete:42") {
		t.Fatalf("err %v, commands %q, calls %v", err, cmds, p.calls)
	}
}

func TestLaunchDeclinedOrUnaskableCreatesAndMintsNothing(t *testing.T) {
	for name, tweak := range map[string]func(*Deps){
		"declined":  func(d *Deps) { d.Confirm = func(string) (bool, error) { return false, nil } },
		"no prompt": func(d *Deps) { d.Confirm = nil },
	} {
		p, h := &stubProvider{}, &stubHub{}
		o, d, _ := setup(p, h)
		tweak(&d)
		_, err := Launch(context.Background(), o, d)
		if err == nil || len(h.labels) != 0 || strings.Contains(strings.Join(p.calls, ","), "create") {
			t.Errorf("%s: err %v, mints %v, calls %v", name, err, h.labels, p.calls)
		}
	}
	p, h := &stubProvider{}, &stubHub{}
	o, d, out := setup(p, h)
	o.Yes, d.Confirm = true, nil
	if _, err := Launch(context.Background(), o, d); err != nil || !strings.Contains(out.String(), "about $0.0357 an hour") {
		t.Errorf("--yes goes on without asking and still says the price: %v %s", err, out.String())
	}
}

func TestLaunchDeletesWhatItCreatedWhenTheWaitFailsOrTimesOut(t *testing.T) {
	p, h := &stubProvider{waitErr: errors.New("droplet entered a final state")}, &stubHub{}
	o, d, out := setup(p, h)
	_, err := Launch(context.Background(), o, d)
	if err == nil || strings.Join(p.calls, ",") != "validate,price,create,wait,delete:42" || !strings.Contains(err.Error(), "was deleted") || !strings.Contains(out.String(), "was deleted") {
		t.Fatalf("a failed wait: %v, calls %v", err, p.calls)
	}
	p2 := &stubProvider{waitBlocks: true}
	o, d, _ = setup(p2, &stubHub{})
	o.Wait = 30 * time.Millisecond
	_, err = Launch(context.Background(), o, d)
	if err == nil || !strings.Contains(err.Error(), "not running within") || !strings.Contains(strings.Join(p2.calls, ","), "delete:42") {
		t.Fatalf("a timeout: %v, calls %v", err, p2.calls)
	}
}

func TestLaunchCancelledByTheCallerStillCleansUpOnItsOwnDeadline(t *testing.T) {
	p := &stubProvider{waitBlocks: true}
	o, d, _ := setup(p, &stubHub{})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	_, err := Launch(ctx, o, d)
	if err == nil || !strings.Contains(strings.Join(p.calls, ","), "delete:42") {
		t.Fatalf("a cancelled launch must delete what it made: %v, calls %v", err, p.calls)
	}
}

func TestLaunchSaysWhenTheCleanupFailsAndIgnoresAnAlreadyGoneInstance(t *testing.T) {
	p := &stubProvider{waitErr: errors.New("x"), deleteErr: errors.New("HTTP 500")}
	o, d, out := setup(p, &stubHub{})
	_, err := Launch(context.Background(), o, d)
	if err == nil || !strings.Contains(err.Error(), "could NOT be deleted (id 42)") || !strings.Contains(out.String(), "costs money") {
		t.Fatalf("%v / %s", err, out.String())
	}
	p = &stubProvider{waitErr: errors.New("x"), deleteErr: &APIError{Provider: "stubcloud", Op: "delete", Status: 404}}
	o, d, _ = setup(p, &stubHub{})
	if _, err := Launch(context.Background(), o, d); err == nil || !strings.Contains(err.Error(), "was deleted") {
		t.Fatalf("an instance already gone counts as deleted: %v", err)
	}
}

func TestLaunchEarlyFailuresCreateNothing(t *testing.T) {
	cases := map[string]struct {
		p    *stubProvider
		h    *stubHub
		o    func(*Options)
		want string
	}{
		"refused token":  {p: &stubProvider{validate: &APIError{Provider: "stubcloud", Status: 401}}, h: &stubHub{}, want: "did not accept the token"},
		"size not there": {p: &stubProvider{priceErr: &APIError{Provider: "stubcloud", Status: 404}}, h: &stubHub{}, want: "does not offer size"},
		"bad name":       {p: &stubProvider{}, h: &stubHub{}, o: func(o *Options) { o.Name = "Bad Name" }, want: "machine name"},
		"no region":      {p: &stubProvider{}, h: &stubHub{}, o: func(o *Options) { o.Region = "" }, want: "region and a size"},
	}
	for name, c := range cases {
		o, d, _ := setup(c.p, c.h)
		if c.o != nil {
			c.o(&o)
		}
		_, err := Launch(context.Background(), o, d)
		if err == nil || !strings.Contains(err.Error(), c.want) || strings.Contains(strings.Join(c.p.calls, ","), "create") {
			t.Errorf("%s: %v, calls %v", name, err, c.p.calls)
		}
		if strings.Contains(err.Error(), launchTestToken) || strings.Contains(err.Error(), launchTestCredential) {
			t.Errorf("%s: the error holds a secret", name)
		}
	}
	p := &stubProvider{createErr: errors.New("quota")}
	o, d, _ := setup(p, &stubHub{})
	if _, err := Launch(context.Background(), o, d); err == nil || strings.Contains(strings.Join(p.calls, ","), "delete") {
		t.Errorf("a failed create has nothing to delete: %v %v", err, p.calls)
	}
}

// listingProvider is a stub that can also list, as the DigitalOcean provider does.
type listingProvider struct{ *stubProvider }

func (l listingProvider) List(context.Context) ([]Instance, error) {
	l.calls = append(l.calls, "list")
	return l.listed, l.listErr
}

func TestLaunchUserDataFailureCreatesAndMintsNothing(t *testing.T) {
	p, h := &stubProvider{}, &stubHub{}
	o, d, _ := setup(p, h)
	d.UserData = func(*BootKeys) (string, error) { return "", errors.New("no builder yet") }
	if _, err := Launch(context.Background(), o, d); err == nil || len(h.labels) != 0 || strings.Contains(strings.Join(p.calls, ","), "create") {
		t.Fatalf("err %v, mints %v, calls %v", err, h.labels, p.calls)
	}
}

func TestLaunchFailedCreateDeletesOnlyTheInstanceCarryingThisLaunchsTag(t *testing.T) {
	base := &stubProvider{createErr: errors.New("connection reset")}
	p := listingProvider{base}
	base.listed = nil // filled once the launch's tag is known: the stub's Create saw the spec
	h := &stubHub{}
	o, d, out := setup(base, h)
	d.Provider = &tagEchoProvider{listingProvider: p}
	_, err := Launch(context.Background(), o, d)
	got := strings.Join(base.calls, ",")
	if err == nil || !strings.Contains(got, "delete:mine") || strings.Contains(got, "delete:same-name") || strings.Contains(got, "delete:other-launch") {
		t.Fatalf("err %v, calls %s", err, got)
	}
	if !strings.Contains(err.Error(), "deleted") || !strings.Contains(out.String(), "was deleted") {
		t.Fatalf("the person is told: %v %s", err, out.String())
	}
}

// tagEchoProvider lists, after a failed Create, a machine with this launch's tag, one with the same name but not the tag, and one from another launch.
type tagEchoProvider struct{ listingProvider }

func (t *tagEchoProvider) List(context.Context) ([]Instance, error) {
	t.stubProvider.calls = append(t.stubProvider.calls, "list")
	tag := t.stubProvider.spec.Tags[1]
	return []Instance{
		{ID: "mine", Name: "coral-1", Tags: []string{Tag, tag}},
		{ID: "same-name", Name: "coral-1", Tags: []string{Tag}},
		{ID: "other-launch", Name: "x", Tags: []string{Tag, "coral-launch-aaaaaaaaaaaa"}},
	}, nil
}

func TestLaunchFailedCreateWithAListFailureSaysWhereToLook(t *testing.T) {
	base := &stubProvider{createErr: errors.New("timeout")}
	base.listErr = errors.New("down")
	o, d, out := setup(base, &stubHub{})
	d.Provider = listingProvider{base}
	_, err := Launch(context.Background(), o, d)
	if err == nil || !strings.Contains(err.Error(), "tag coral-launch-") || !strings.Contains(out.String(), "costs money") {
		t.Fatalf("%v %s", err, out.String())
	}
	if strings.Contains(strings.Join(base.calls, ","), "delete") {
		t.Fatalf("nothing is deleted without a list: %v", base.calls)
	}
}

func TestLaunchEveryInstanceCarriesAUniqueLaunchTag(t *testing.T) {
	tags := map[string]bool{}
	for i := 0; i < 5; i++ {
		p := &stubProvider{}
		o, d, _ := setup(p, &stubHub{})
		if _, err := Launch(context.Background(), o, d); err != nil || len(p.spec.Tags) != 2 || p.spec.Tags[0] != Tag || !strings.HasPrefix(p.spec.Tags[1], "coral-launch-") {
			t.Fatalf("%v %v", err, p.spec.Tags)
		}
		tags[p.spec.Tags[1]] = true
	}
	if len(tags) != 5 {
		t.Fatalf("tags repeat: %v", tags)
	}
}

// laggingProvider lists nothing the first time and the launch's machine the second time, as a provider whose list lags the create does.
type laggingProvider struct {
	*stubProvider
	lists int
}

func (l *laggingProvider) List(context.Context) ([]Instance, error) {
	l.lists++
	if l.lists == 1 {
		return nil, nil
	}
	return []Instance{{ID: "late", Name: "coral-1", Tags: []string{Tag, l.spec.Tags[1]}}}, nil
}

func TestLaunchTimedOutCreateLooksOnceMoreAndDeletesTheLateMachine(t *testing.T) {
	base := &stubProvider{createErr: context.DeadlineExceeded}
	l := &laggingProvider{stubProvider: base}
	o, d, _ := setup(base, &stubHub{})
	d.Provider, o.RetryListAfter = l, time.Millisecond
	_, err := Launch(context.Background(), o, d)
	if err == nil || l.lists != 2 || !strings.Contains(strings.Join(base.calls, ","), "delete:late") {
		t.Fatalf("lists %d, err %v, calls %v", l.lists, err, base.calls)
	}
}

func TestLaunchCreateFailureThatIsNotATimeoutListsOnlyOnce(t *testing.T) {
	base := &stubProvider{createErr: errors.New("422 unprocessable")}
	l := &laggingProvider{stubProvider: base}
	o, d, _ := setup(base, &stubHub{})
	d.Provider, o.RetryListAfter = l, time.Millisecond
	if _, err := Launch(context.Background(), o, d); err == nil || l.lists != 1 {
		t.Fatalf("lists %d, err %v", l.lists, err)
	}
}

func TestLaunchCancelledCreateGetsTheSecondLookToo(t *testing.T) {
	base := &stubProvider{createErr: context.Canceled}
	l := &laggingProvider{stubProvider: base}
	o, d, _ := setup(base, &stubHub{})
	d.Provider, o.RetryListAfter = l, time.Millisecond
	_, err := Launch(context.Background(), o, d)
	if err == nil || l.lists != 2 || !strings.Contains(strings.Join(base.calls, ","), "delete:late") {
		t.Fatalf("lists %d, err %v, calls %v", l.lists, err, base.calls)
	}
}

func TestLaunchTimedOutCreateThatStillFindsNothingSaysWhereToLook(t *testing.T) {
	base := &stubProvider{createErr: context.DeadlineExceeded}
	l := &emptyLister{stubProvider: base}
	o, d, out := setup(base, &stubHub{})
	d.Provider, o.RetryListAfter = l, time.Millisecond
	_, err := Launch(context.Background(), o, d)
	if err == nil || l.lists != 2 || !strings.Contains(err.Error(), "look for tag coral-launch-") || !strings.Contains(out.String(), "costs money") {
		t.Fatalf("lists %d, err %v, out %s", l.lists, err, out.String())
	}
}

// emptyLister never has the machine, on either look.
type emptyLister struct {
	*stubProvider
	lists int
}

func (l *emptyLister) List(context.Context) ([]Instance, error) { l.lists++; return nil, nil }

// No code of this package may trust a host key it did not pin: no InsecureIgnoreHostKey, no trust-on-first-use callback (coral-hub Security's condition A on #10917).
func TestNoCodeTrustsAHostKeyItDidNotPin(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("no source: %v", err)
	}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, bad := range []string{"InsecureIgnoreHostKey", "known_hosts", "StrictHostKeyChecking=no", "accept-new"} {
			if strings.Contains(string(b), bad) {
				t.Errorf("%s mentions %s", f, bad)
			}
		}
	}
}
