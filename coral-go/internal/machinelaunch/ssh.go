package machinelaunch

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// The launcher's side of the bootstrap (#10917, coral-hub Security's ruling): after the droplet runs, the launcher connects over SSH with the droplet's host key PINNED in advance (ssh.FixedHostKey: never
// trust-on-first-use, never a callback that accepts any key), and only then mints the Hub's one-time credential and writes it, on standard input, to a tmpfs file only Coral reads. The credential is never in the user-data, an
// argument, a log line or anything this package prints. A host key that does not match ends the launch for good (the machine is deleted, nothing was sent, no retry); only a droplet that is not answering YET is waited for.

// BootKeys are the keys one launch makes for itself, in memory, never written to a file or any host-key store a later connection could trust, and never reused: a client key pair for the login, and the
// host key pair the droplet is told to present (the pin).
type BootKeys struct {
	client       ssh.Signer
	ClientPublic string // the client's public half, an authorized_keys line
	hostPriv     ed25519.PrivateKey
	HostPublic   ssh.PublicKey // the pin: what the droplet's host key must be
}

// NewBootKeys makes a launch's two ed25519 key pairs with crypto/rand.
func NewBootKeys() (*BootKeys, error) {
	_, cpriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("could not make the launch's login key: %w", err)
	}
	csigner, err := ssh.NewSignerFromKey(cpriv)
	if err != nil {
		return nil, err
	}
	hpub, hpriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("could not make the launch's host key: %w", err)
	}
	hostPub, err := ssh.NewPublicKey(hpub)
	if err != nil {
		return nil, err
	}
	return &BootKeys{
		client:       csigner,
		ClientPublic: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(csigner.PublicKey()))),
		hostPriv:     hpriv,
		HostPublic:   hostPub,
	}, nil
}

// Destroy overwrites the private halves. A launch calls it when it is done with them.
func (k *BootKeys) Destroy() {
	if k == nil {
		return
	}
	clear(k.hostPriv)
	k.client = nil
}

// Minter-side callbacks and the answers of a bootstrap.
type (
	// BootRequest is what a bootstrap is asked to do.
	BootRequest struct {
		Instance Instance
		Keys     *BootKeys
		// Mint makes the Hub's one-time credential. It is called ONLY after the pinned handshake succeeded.
		Mint func(ctx context.Context) (string, error)
		Out  io.Writer
	}
	// BootResult is how the droplet's own Coral answered once it had the credential.
	BootResult struct {
		State string // "connected" or "connecting": the droplet enrolled
		Label string // the machine's label at the Hub, as the droplet's Coral reports it ("" when it did not say)
	}
	// Bootstrapper delivers the credential to a running machine.
	Bootstrapper interface {
		Bootstrap(ctx context.Context, req BootRequest) (BootResult, error)
	}
)

// Errors a bootstrap answers with, to be told apart with errors.Is.
var (
	// ErrHostKeyMismatch is a droplet that presented a host key other than the pin. Nothing was sent to it, and it is never retried.
	ErrHostKeyMismatch = errors.New("the machine's SSH host key is not the one this launch pinned: nothing was sent to it")
	// ErrSSHUnreachable is a droplet whose SSH did not answer within the window.
	ErrSSHUnreachable = errors.New("could not reach the machine over SSH")
)

// Where the credential goes on the machine, and the commands the launcher runs there. None of them holds a secret: the credential travels on standard input.
const (
	credentialDir  = "/run/coral/bootstrap.d"
	deliverCommand = "umask 077 && cat > " + credentialDir + "/credential.tmp && mv " + credentialDir + "/credential.tmp " + credentialDir + "/credential"
	statusCommand  = "/usr/local/bin/coral cloud status"
	doneCommand    = "touch " + credentialDir + "/done"
)

// SSHBootstrap is the real Bootstrapper: crypto/ssh, the pin, the credential on stdin, the droplet's own Coral asked whether it enrolled, then the done file that tells the machine to close SSH.
type SSHBootstrap struct {
	// Addr is where SSH answers for an instance; nil is its public address, port 22.
	Addr func(Instance) string
	// Window is how long to wait for SSH to answer (0: 5 minutes); Every is the pause between tries (0: 3 seconds); EnrollWait is how long to wait for the droplet's Coral to enroll (0: 2 minutes).
	Window, Every, EnrollWait time.Duration
}

var stateLine = regexp.MustCompile(`(?m)^State:\s+(\S+)`)
var labelLine = regexp.MustCompile(`(?m)^Server:\s+(.+)$`)

func (s *SSHBootstrap) addr(in Instance) string {
	if s.Addr != nil {
		return s.Addr(in)
	}
	return net.JoinHostPort(in.IPv4, "22")
}

func orDefault(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

// Bootstrap connects, mints and delivers the credential, waits for the droplet's Coral to enroll, and tells the machine it is done.
func (s *SSHBootstrap) Bootstrap(ctx context.Context, req BootRequest) (BootResult, error) {
	if req.Keys == nil || req.Keys.client == nil || req.Keys.HostPublic == nil || req.Mint == nil {
		return BootResult{}, errors.New("a bootstrap needs the launch's keys and a way to mint the credential")
	}
	client, err := s.connect(ctx, req)
	if err != nil {
		return BootResult{}, err
	}
	defer client.Close()
	fmt.Fprintf(req.Out, "Connected to the machine over SSH, its host key matches the pin.\n")

	credential, err := req.Mint(ctx) // minted only now: the handshake proved this is the machine this launch made
	if err != nil {
		return BootResult{}, err
	}
	if err := run(client, deliverCommand, strings.NewReader(credential), nil); err != nil {
		credential = ""
		return BootResult{}, fmt.Errorf("could not write the credential on the machine: %s", sshReason(err))
	}
	credential = ""

	res, err := s.waitEnrolled(ctx, client)
	if err != nil {
		return BootResult{}, err
	}
	// The machine may now close SSH. The launcher does not need it again; a failure here is not the launch's.
	_ = run(client, doneCommand, nil, nil)
	return res, nil
}

// connect dials until the pinned handshake succeeds. A host key that is not the pin ends it at once, with nothing sent; anything else is waited out until the window closes.
func (s *SSHBootstrap) connect(ctx context.Context, req BootRequest) (*ssh.Client, error) {
	mismatch := false
	pin := ssh.FixedHostKey(req.Keys.HostPublic)
	cfg := &ssh.ClientConfig{
		User:              "coral",
		Auth:              []ssh.AuthMethod{ssh.PublicKeys(req.Keys.client)},
		HostKeyAlgorithms: []string{ssh.KeyAlgoED25519},
		HostKeyCallback: func(host string, remote net.Addr, key ssh.PublicKey) error {
			if err := pin(host, remote, key); err != nil {
				mismatch = true
				return err
			}
			return nil
		},
		Timeout: 15 * time.Second,
	}
	addr := s.addr(req.Instance)
	deadline := time.Now().Add(orDefault(s.Window, 5*time.Minute))
	every := orDefault(s.Every, 3*time.Second)
	var last error
	for {
		c, err := dialContext(ctx, addr, cfg)
		if err == nil {
			return c, nil
		}
		if mismatch {
			return nil, ErrHostKeyMismatch
		}
		last = err
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if time.Now().Add(every).After(deadline) {
			return nil, fmt.Errorf("%w within the window (last answer: %s)", ErrSSHUnreachable, sshReason(last))
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(every):
		}
	}
}

// dialContext is ssh.Dial that stops when ctx does.
func dialContext(ctx context.Context, addr string, cfg *ssh.ClientConfig) (*ssh.Client, error) {
	var d net.Dialer
	d.Timeout = cfg.Timeout
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-done:
		}
	}()
	defer close(done)
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		conn.Close()
		return nil, err
	}
	return ssh.NewClient(c, chans, reqs), nil
}

// waitEnrolled asks the droplet's own Coral over the still-open session whether it enrolled, until it says so or the wait is over. The answer is its own "coral cloud status" text; it holds no credential.
func (s *SSHBootstrap) waitEnrolled(ctx context.Context, client *ssh.Client) (BootResult, error) {
	deadline := time.Now().Add(orDefault(s.EnrollWait, 2*time.Minute))
	every := orDefault(s.Every, 3*time.Second)
	var state string
	for {
		var out bytes.Buffer
		if err := run(client, statusCommand, nil, &out); err == nil {
			state = ""
			if m := stateLine.FindStringSubmatch(out.String()); m != nil {
				state = m[1]
			}
			switch state {
			case "connected", "connecting":
				res := BootResult{State: state}
				if m := labelLine.FindStringSubmatch(out.String()); m != nil {
					res.Label = strings.TrimSpace(m[1])
				}
				return res, nil
			case "revoked", "upgrade_required":
				return BootResult{}, fmt.Errorf("the machine's Coral did not enrol (its state is %s)", state)
			}
		}
		if ctx.Err() != nil {
			return BootResult{}, ctx.Err()
		}
		if time.Now().Add(every).After(deadline) {
			return BootResult{}, fmt.Errorf("the machine's Coral did not report that it enrolled within the wait (its last state: %q)", state)
		}
		select {
		case <-ctx.Done():
			return BootResult{}, ctx.Err()
		case <-time.After(every):
		}
	}
}

// run runs one command in a new session. stdin is its standard input (the only way a secret reaches the machine); stdout, when given, collects its output.
func run(client *ssh.Client, command string, stdin io.Reader, stdout io.Writer) error {
	sess, err := client.NewSession()
	if err != nil {
		return err
	}
	defer sess.Close()
	sess.Stdin = stdin
	sess.Stdout = stdout
	return sess.Run(command)
}

// sshReason is an SSH error as a short sentence that never holds what was sent.
func sshReason(err error) string {
	if err == nil {
		return ""
	}
	return strings.TrimSpace(err.Error())
}
