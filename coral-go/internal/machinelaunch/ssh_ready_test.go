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
}

// QA Reviewer 2's SHOULDs on #13776.

// The probe is the one literal command, read-only, on the one folder: a change to either is a decision, not a drift.
func TestTheProbeIsTheLiteralReadOnlyTestOfTheCredentialFolder(t *testing.T) {
	if credentialDir != "/run/coral/bootstrap.d" {
		t.Fatalf("the credential folder is %q", credentialDir)
	}
	if readyCommand != "test -d /run/coral/bootstrap.d" {
		t.Fatalf("the probe is %q", readyCommand)
	}
	for _, bad := range []string{"mkdir", "install", "chmod", "chown", ">", "touch", "mv", "cat"} {
		if strings.Contains(readyCommand, bad) {
			t.Fatalf("the probe %q contains %q: it must read and create nothing", readyCommand, bad)
		}
	}
}

// What a failing command says may hold escape sequences, NULs, carriage returns and other control bytes: none reaches the error (it is printed to a terminal), line breaks become spaces, and text stays readable.
func TestStderrNoteDropsControlCharactersAndKeepsTheWords(t *testing.T) {
	got := stderrNote("cat: \x1b[31mwrite error\x1b[0m\r\nNo space\x00 left\ton device\x07\x7f\n", launchTestCredential)
	for _, r := range got {
		if r < 0x20 || r == 0x7f {
			t.Fatalf("a control character %q is in %q", r, got)
		}
	}
	if !strings.Contains(got, "No space left on device") || !strings.Contains(got, "write error") {
		t.Fatalf("the words were lost: %q", got)
	}
	if stderrNote("  \n\t ", "x") != "" {
		t.Fatal("whitespace only is not a note")
	}
	if got := stderrNote("tok chb_ABC-def_123 end", ""); strings.Contains(got, "chb_ABC") {
		t.Fatalf("a credential-shaped word was kept: %q", got)
	}
}

// A machine that answers a failed delivery with a megabyte of standard error cannot grow the launcher's memory: only the first stderrMaxBytes are kept, the session still ends with the exit status, and the error stays short.
func TestAFloodOfStderrIsCappedAndTheFailureStillComesBack(t *testing.T) {
	m := &slowMachine{}
	p, h := &stubProvider{}, &stubHub{}
	o, d, _, srv := setupWith(t, p, h)
	flood := "first words " + strings.Repeat("Z", 1<<20)
	srv.handle = func(cmd, stdin string) (string, string, uint32) {
		if cmd == deliverCommand {
			return "", flood, 1
		}
		return m.handle(cmd, stdin)
	}
	d.Bootstrap.(*SSHBootstrap).ReadyWait = time.Second
	_, err := Launch(context.Background(), o, d)
	if err == nil || !strings.Contains(err.Error(), "first words") || len(err.Error()) > 1500 {
		t.Fatalf("err (%d bytes): %v", len(fmt.Sprint(err)), err)
	}
	if stderrMaxBytes != 4<<10 {
		t.Fatalf("the stderr cap is %d", stderrMaxBytes)
	}
	c := newStderrCap() // the buffer the delivery collects into
	for i := 0; i < 300; i++ {
		c.Write([]byte(strings.Repeat("y", 10_000)))
	}
	if len(c.String()) != stderrMaxBytes {
		t.Fatalf("kept %d bytes, want %d", len(c.String()), stderrMaxBytes)
	}
}
