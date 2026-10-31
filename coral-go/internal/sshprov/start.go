package sshprov

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Starting the installed Coral on the far computer and reading what the hub needs to register it (#11370). The remote listens on its own loopback only (--host 127.0.0.1); the hub reaches it
// through the SSH stream target, never a port.

// RemotePort is the loopback port the remote Coral listens on.
const RemotePort = 8420

var (
	instanceIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)
	apiKeyRe     = regexp.MustCompile(`^[A-Za-z0-9._~+/=-]{16,256}$`)
)

// Stored is the target as the registry stores it (store.RemoteServer.SSHTarget): a config Host name, or user@host:port. ParseTarget and FromAlias read it back.
func (t Target) Stored() string {
	if t.Alias != "" {
		return t.Alias
	}
	h := t.Host
	if strings.Contains(h, ":") {
		h = "[" + h + "]"
	}
	return t.User + "@" + h + ":" + strconv.Itoa(t.Port)
}

// AcceptTerms passes the owner's acceptance (the JSON the caller built: version, sha256, by) to the far computer on stdin; the far Coral refuses terms that are not its own. Nothing of the payload is in
// argv, a log or an error.
func (r Runner) AcceptTerms(ctx context.Context, t Target, version string, payload []byte) error {
	res, err := r.RunInput(ctx, t, bytes.NewReader(payload), CmdAcceptTerms, version)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return errors.New("sshprov: the far computer did not accept the terms")
	}
	return nil
}

// stopWait and stopPoll bound how long a stopped Coral is given to be gone; variables for tests.
var (
	stopWait = 15 * time.Second
	stopPoll = time.Second
)

// SetStopTimingForTest shortens how long StopAndConfirm waits (other packages' tests run it against a Coral that will not stop); it returns the function that puts the old values back.
func SetStopTimingForTest(wait, poll time.Duration) (restore func()) {
	oldW, oldP := stopWait, stopPoll
	stopWait, stopPoll = wait, poll
	return func() { stopWait, stopPoll = oldW, oldP }
}

// ErrNotStopped is a Coral that is still there after a stop (a session, or something listening on its port), or one that could not be checked.
var ErrNotStopped = errors.New("sshprov: Coral did not stop, or that could not be checked")

// StopAndConfirm ends the coral-server tmux session (matched by its exact name: a far user's "coral-server-notes" is never touched) and then CONFIRMS it: no session by that name and nothing listening on
// port 8420. It returns nil only on that confirmation; a caller does not delete files or restart on anything else.
func (r Runner) StopAndConfirm(ctx context.Context, t Target) error {
	if _, err := r.Run(ctx, t, CmdStopTmux); err != nil {
		return err
	}
	deadline := time.Now().Add(stopWait)
	for {
		res, err := r.Run(ctx, t, CmdCheckStopped)
		if err != nil {
			return err
		}
		if res.ExitCode == 0 {
			return nil
		}
		if res.ExitCode == 3 || time.Now().After(deadline) {
			return ErrNotStopped
		}
		select {
		case <-ctx.Done():
			return ErrNotStopped
		case <-time.After(stopPoll):
		}
	}
}

// InstallOwnerSecret installs the secret the hub signs its owner stamps for this computer with (#11378): the far Coral's own `hub-owner-secret` command writes it (0600) under the id this hub knows the
// computer by. Both go on stdin; nothing of them is in argv, a log or an error.
func (r Runner) InstallOwnerSecret(ctx context.Context, t Target, version, remoteID, secret string) error {
	payload, err := json.Marshal(map[string]string{"remote": remoteID, "secret": secret})
	if err != nil {
		return err
	}
	res, err := r.RunInput(ctx, t, bytes.NewReader(payload), CmdInstallOwnerSecret, version)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return errors.New("sshprov: the far computer did not take the secret")
	}
	return nil
}

// StartTmux starts the installed Coral of version in a tmux session called coral-server, once: a session that exists is left as it is.
func (r Runner) StartTmux(ctx context.Context, t Target, version string) error {
	res, err := r.Run(ctx, t, CmdStartTmux, version)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return errors.New("sshprov: could not start Coral")
	}
	return nil
}

// EnsureInstanceID makes the instance id on the far computer (once; a re-run reads the same one) and returns it: 32 lower-case hex digits, nothing else.
func (r Runner) EnsureInstanceID(ctx context.Context, t Target) (string, error) {
	res, err := r.Run(ctx, t, CmdEnsureInstanceID)
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(res.Stdout)
	if res.ExitCode != 0 || !instanceIDRe.MatchString(id) {
		return "", errors.New("sshprov: the instance id is not 32 hex digits")
	}
	return id, nil
}

// keyPoll is how long ReadAPIKey waits between tries, and keyWait how long it tries in all; variables for tests.
var (
	keyPoll = 2 * time.Second
	keyWait = 90 * time.Second
)

// ReadAPIKey reads the remote's API key, waiting for a Coral that is still starting to make it. The key is returned to the caller and is in no log, argv or error here; anything that is not a key of
// the expected shape is not one.
func (r Runner) ReadAPIKey(ctx context.Context, t Target, version string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, keyWait)
	defer cancel()
	for {
		res, err := r.Run(ctx, t, CmdReadAPIKey, version)
		if err == nil && res.ExitCode == 0 {
			if key := strings.TrimSpace(res.Stdout); apiKeyRe.MatchString(key) {
				return key, nil
			}
		} else if errors.Is(err, ErrHostKey) || errors.Is(err, ErrHostKeyChanged) || errors.Is(err, ErrNotAllowed) {
			return "", err
		}
		select {
		case <-ctx.Done():
			return "", errors.New("sshprov: the remote has no API key yet")
		case <-time.After(keyPoll):
		}
	}
}
