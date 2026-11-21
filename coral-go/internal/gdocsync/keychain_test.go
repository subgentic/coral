package gdocsync

import (
	"os"
	"os/exec"
	"testing"
)

func TestKeychainRoundTrip(t *testing.T) {
	if os.Getenv("GDOC_KEYCHAIN_TEST") != "1" {
		t.Skip("opt-in: set GDOC_KEYCHAIN_TEST=1 (it writes and deletes a real keychain item)")
	}
	if _, err := exec.LookPath("security"); err != nil {
		t.Skip("no macOS keychain")
	}
	acct := "selftest-" + t.Name()
	t.Cleanup(func() { exec.Command("security", "delete-generic-password", "-a", acct, "-s", keychainService).Run() })
	want := Creds{ClientID: "id", ClientSecret: "sec\"ret'x", RefreshToken: "rt"}
	if err := StoreCreds(acct, want); err != nil {
		t.Skip("keychain not writable here: ", err)
	}
	got, err := LoadCreds(acct)
	if err != nil || got != want {
		t.Fatalf("got %v %v", got, err)
	}
	if _, err := LoadCreds("no-such-" + acct); err == nil {
		t.Fatal("a missing sign-in must be an error")
	}
}
