package tracking

import (
	"os"
	"path/filepath"
	"testing"
)

// While the send gate says no, nothing is sent, the one-time events included, and a one-time event is still sent once it says yes.
func TestNothingIsSentWhileTheSendGateSaysNo(t *testing.T) {
	rec, _ := newTestTracking(t)
	allowed := false
	SetSendGate(func() bool { return allowed })
	t.Cleanup(func() { SetSendGate(nil) })

	TrackEvent(EventAppOpened, nil)
	TrackOnce(EventFirstAgentLaunched, nil)
	waitForAsync()
	if got := rec.names(); len(got) != 0 {
		t.Fatalf("sent while the gate said no: %v", got)
	}

	allowed = true
	TrackOnce(EventFirstAgentLaunched, nil)
	waitForAsync()
	if got := rec.count(EventFirstAgentLaunched); got != 1 {
		t.Fatalf("the one-time event should go once the gate says yes, got %d (%v)", got, rec.names())
	}
}

// An install id that is not on disk yet is not remembered as empty: once it is written, events go out under it.
func TestAnInstallIDWrittenLaterIsUsed(t *testing.T) {
	rec, dir := newTestTracking(t)
	idFile := filepath.Join(dir, ".install_id")
	if err := os.Remove(idFile); err != nil {
		t.Fatal(err)
	}
	installIDMu.Lock()
	cachedInstallID = ""
	installIDMu.Unlock()

	TrackEvent(EventAppOpened, nil)
	waitForAsync()
	if got := rec.names(); len(got) != 0 {
		t.Fatalf("sent with no install id: %v", got)
	}

	if err := os.WriteFile(idFile, []byte("written-later"), 0o600); err != nil {
		t.Fatal(err)
	}
	TrackEvent(EventAppOpened, nil)
	waitForAsync()
	all := rec.all()
	if len(all) != 1 || all[0].DistinctID != "written-later" {
		t.Fatalf("want one event under the id written later, got %+v", all)
	}
}
