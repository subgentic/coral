package machinelaunch

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// coral-hub's real DigitalOcean run (#13776): sshd answers while cloud-init is still running coral-machine-setup, and /run/coral/bootstrap.d is created only in the LAST runcmd block, so the first thing the launcher ran,
// `cat > /run/coral/bootstrap.d/credential.tmp`, failed with "Process exited with status 1". These tests stand a machine in for that: the folder exists only after some probes, and a delivery before it fails the way cat does.

// slowMachine answers like a machine whose setup is still running: the folder appears after `after` probes of it. A delivery before that fails the way the shell does (exit 1, the shell's own words on stderr); one after it
// is written down. It records what was written and where, so a test can say the credential went nowhere else.
type slowMachine struct {
	mu        sync.Mutex
	probes    int
	after     int // probes that find no folder
	delivered []string
	other     []string // every command that is neither the probe, the delivery nor the status/done pair
	early     int      // deliveries that arrived before the folder existed
}

func (m *slowMachine) handle(cmd, stdin string) (string, string, uint32) {
	m.mu.Lock()
	defer m.mu.Unlock()
	exists := m.probes >= m.after
	switch {
	case cmd == readyCommand:
		m.probes++
		if m.probes <= m.after {
			return "", "", 1
		}
		return "", "", 0
	case cmd == deliverCommand:
		if !exists {
			m.early++
			return "", "sh: 1: cannot create " + credentialDir + "/credential.tmp: Directory nonexistent\n", 1
		}
		m.delivered = append(m.delivered, stdin)
		return "", "", 0
	case cmd == statusCommand:
		return "State:     connected\nServer:    coral-1\n", "", 0
	case cmd == doneCommand:
		return "", "", 0
	}
	m.other = append(m.other, cmd)
	return "", "", 0
}

func bootWith(t *testing.T, m *slowMachine, ready time.Duration) (error, *stubSSH) {
	t.Helper()
	p, h := &stubProvider{}, &stubHub{}
	o, d, _, srv := setupWith(t, p, h)
	srv.handle = m.handle
	b := d.Bootstrap.(*SSHBootstrap)
	b.ReadyWait = ready
	_, err := Launch(context.Background(), o, d)
	return err, srv
}

// The race itself: the folder is not there for the first probes. The launcher waits for it, delivers once, and the credential is written once, to the one place.
func TestDeliveryWaitsForTheFolderTheMachineMakesLast(t *testing.T) {
	m := &slowMachine{after: 4}
	err, _ := bootWith(t, m, 2*time.Second)
	if err != nil {
		t.Fatalf("launch: %v", err)
	}
	if m.early != 0 {
		t.Fatalf("%d deliveries arrived before the folder existed (the launcher did not wait for it)", m.early)
	}
	if len(m.delivered) != 1 || m.delivered[0] != launchTestCredential {
		t.Fatalf("delivered %q, want the credential once", m.delivered)
	}
	if len(m.other) != 0 {
		t.Fatalf("commands outside the known set ran on the machine: %q", m.other)
	}
}

// The credential is minted only when the machine can take it: a launch that waits for the folder must not mint first and let the one-time credential age while setup runs.
func TestCredentialIsMintedAfterTheFolderExists(t *testing.T) {
	m := &slowMachine{after: 3}
	p, h := &stubProvider{}, &stubHub{}
	o, d, _, srv := setupWith(t, p, h)
	srv.handle = m.handle
	d.Bootstrap.(*SSHBootstrap).ReadyWait = 2 * time.Second
	var probesAtMint int
	h.onMint = func() { m.mu.Lock(); probesAtMint = m.probes; m.mu.Unlock() }
	if _, err := Launch(context.Background(), o, d); err != nil {
		t.Fatal(err)
	}
	if probesAtMint <= m.after {
		t.Fatalf("the credential was minted after %d probes; the folder appeared after %d", probesAtMint, m.after)
	}
}

// A folder that never appears ends the launch with a sentence that names the folder and the wait, and nothing was sent: no delivery, no credential on the machine.
func TestFolderThatNeverAppearsFailsClearlyAndSendsNothing(t *testing.T) {
	m := &slowMachine{after: 1 << 30}
	err, _ := bootWith(t, m, 150*time.Millisecond)
	if err == nil {
		t.Fatal("a machine with no folder was reported as launched")
	}
	if !errors.Is(err, ErrMachineNotReady) {
		t.Fatalf("want ErrMachineNotReady, got %v", err)
	}
	if !strings.Contains(err.Error(), credentialDir) {
		t.Fatalf("the error does not name the folder: %v", err)
	}
	if m.early != 0 || len(m.delivered) != 0 {
		t.Fatalf("something was sent to a machine that was not ready: early %d, delivered %q", m.early, m.delivered)
	}
}

// The failing command's own words are kept in the error, cut to a bound, and the credential is never in it, even when the machine echoes it.
func TestDeliveryFailureKeepsStderrBoundedAndRedacted(t *testing.T) {
	m := &slowMachine{}
	p, h := &stubProvider{}, &stubHub{}
	o, d, _, srv := setupWith(t, p, h)
	long := strings.Repeat("A", 5000)
	srv.handle = func(cmd, stdin string) (string, string, uint32) {
		if cmd == deliverCommand {
			return "", "cat: write error: No space left on device " + stdin + " " + long, 1
		}
		return m.handle(cmd, stdin)
	}
	d.Bootstrap.(*SSHBootstrap).ReadyWait = time.Second
	_, err := Launch(context.Background(), o, d)
	if err == nil {
		t.Fatal("a failed delivery was reported as launched")
	}
	msg := err.Error()
	if !strings.Contains(msg, "No space left on device") {
		t.Fatalf("the machine's own words are not in the error: %q", msg)
	}
	if strings.Contains(msg, launchTestCredential) {
		t.Fatalf("the credential is in the error: %q", msg)
	}
	if len(msg) > 2000 {
		t.Fatalf("the error is %d bytes: stderr is not bounded", len(msg))
	}
	_ = fmt.Sprint
}
