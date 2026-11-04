//go:build !windows

package sshprov

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The data folder is the person's choice at a set up (a Coral set up by hand keeps its data in .coral): the start gives it to Coral as --home, makes it, and records it in <install>/datadir so an upgrade
// ("@keep") and the key read use the same one; with none recorded the folder is the default under the install folder.
func TestStartUsesTheChosenDataFolderAndKeepsItForLaterStarts(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, InstallDir, "2.0.10", "root")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	// a Coral that prints its arguments and ends at once; its api-key and hub-owner-secret print the --home they were given
	fake := "#!/bin/sh\ncase \"$1\" in api-key|hub-owner-secret) echo \"$1 $*\"; exit 0;; esac\necho \"started $*\"\n"
	if err := os.WriteFile(filepath.Join(root, "coral"), []byte(fake), 0o700); err != nil {
		t.Fatal(err)
	}
	run := func(c Command, args ...string) string {
		text, err := remoteText(c, args...)
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("sh", "-c", text)
		cmd.Env = append(os.Environ(), "HOME="+home)
		out, _ := cmd.Output()
		return string(out)
	}
	logHas := func(want string) bool {
		for i := 0; i < 100; i++ {
			if b, _ := os.ReadFile(filepath.Join(home, InstallDir, "coral.log")); strings.Contains(string(b), want) {
				return true
			}
			time.Sleep(50 * time.Millisecond)
		}
		return false
	}
	rm := func() {
		_ = os.Remove(filepath.Join(home, InstallDir, "coral.pid"))
		_ = os.Remove(filepath.Join(home, InstallDir, "coral.log"))
	}

	run(CmdStartDaemon, "2.0.10", "pty", ".coral", "8420")
	if !logHas("--home " + filepath.Join(home, ".coral")) {
		t.Fatal("the chosen folder was not Coral's --home")
	}
	if st, err := os.Stat(filepath.Join(home, ".coral")); err != nil || !st.IsDir() {
		t.Fatal("the chosen folder was not made")
	}
	if b, _ := os.ReadFile(filepath.Join(home, InstallDir, "datadir")); string(b) != ".coral" {
		t.Fatalf("datadir records %q", b)
	}
	if got := run(CmdReadAPIKey, "2.0.10"); !strings.Contains(got, "--home "+filepath.Join(home, ".coral")) {
		t.Errorf("the key was read from %q, not the chosen folder", got)
	}
	if got := run(CmdInstallOwnerSecret, "2.0.10"); !strings.Contains(got, "--home "+filepath.Join(home, ".coral")) {
		t.Errorf("the owner secret went to %q, not the chosen folder", got)
	}
	rm()
	run(CmdStartDaemon, "2.0.10", "pty", "@keep", "8420") // an upgrade
	if !logHas("--home " + filepath.Join(home, ".coral")) {
		t.Error("an upgrade did not keep the recorded folder")
	}
	// a record that is not a plain relative path is not followed
	rm()
	_ = os.WriteFile(filepath.Join(home, InstallDir, "datadir"), []byte("/etc"), 0o600)
	run(CmdStartDaemon, "2.0.10", "pty", "@keep", "8420")
	if !logHas("--home " + filepath.Join(home, DefaultDataDir)) {
		t.Error("a datadir record of /etc was followed")
	}
	// none recorded: the default
	rm()
	_ = os.Remove(filepath.Join(home, InstallDir, "datadir"))
	run(CmdStartDaemon, "2.0.10", "pty", "@keep", "8420")
	if !logHas("--home " + filepath.Join(home, DefaultDataDir)) {
		t.Error("with no record the folder is not the default")
	}
}

func TestDataFolderNamesAreOnlyPlainRelativeFolders(t *testing.T) {
	for _, ok := range []string{".coral", ".coral-server/data", "my-coral/data", "a/b/c/d/e", "coral_1.2"} {
		if !ValidDataDir(ok) {
			t.Errorf("%q should be allowed", ok)
		}
	}
	for _, bad := range []string{"", "@keep", "..", "../x", "a/../b", "a..b", "my..coral/data", "x/y..", "a.", "x/y.", "/etc", "~/x", "a b", "a;b", "a/", "-x", ".", "./x", "a//b", "$HOME", "a\nb", "a/b/c/d/e/f", ".ssh", ".ssh/coral", ".gnupg", ".config/x"} {
		if ValidDataDir(bad) {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestDataFolderProblemsSayWhy(t *testing.T) {
	if p := DataDirProblem(".ssh"); !strings.Contains(p, "keys or settings") {
		t.Errorf("%q", p)
	}
	if p := DataDirProblem("../x"); !strings.Contains(p, "plain folder names") {
		t.Errorf("%q", p)
	}
	if DataDirProblem(".coral") != "" || DataDirProblem("my.config/x") != "" || DataDirProblem("x/.ssh") != "" {
		t.Error("only a first name of .ssh, .gnupg or .config is refused")
	}
}

// a datadir record naming a folder of keys is not followed at a start
func TestStartIgnoresARecordedKeysFolder(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, InstallDir, "2.0.10", "root")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "coral"), []byte("#!/bin/sh\necho \"started $*\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(home, InstallDir, "datadir"), []byte(".ssh/x"), 0o600)
	text, _ := remoteText(CmdStartDaemon, "2.0.10", "pty", "@keep", "8420")
	cmd := exec.Command("sh", "-c", text)
	cmd.Env = append(os.Environ(), "HOME="+home)
	_ = cmd.Run()
	for i := 0; i < 100; i++ {
		if b, _ := os.ReadFile(filepath.Join(home, InstallDir, "coral.log")); strings.Contains(string(b), "--home "+filepath.Join(home, DefaultDataDir)) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Error("a recorded .ssh folder was followed")
}

// Whatever the validator accepts, the remote read-back gives the same folder: the start, the key read and an upgrade's @keep all use one.
func TestEveryAcceptedDataFolderReadsBackAsItself(t *testing.T) {
	for _, d := range []string{".coral", "my-coral/data", "a.b", "a.b/c_d", ".coral-server/data", "x/y.z"} {
		if !ValidDataDir(d) {
			t.Fatalf("%q should be allowed", d)
		}
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Join(home, InstallDir), 0o700); err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(home, InstallDir, "datadir"), []byte(d), 0o600)
		cmd := exec.Command("sh", "-c", readDataDir+`printf %s "$d"`)
		cmd.Env = append(os.Environ(), "HOME="+home)
		out, _ := cmd.Output()
		if string(out) != d {
			t.Errorf("%q reads back as %q", d, out)
		}
	}
}

// The argument pattern itself refuses two dots, so the remote command never gets one (the validator is not the only guard).
func TestTheRemoteArgumentPatternRefusesTwoDots(t *testing.T) {
	for _, bad := range []string{"a..b", "my..coral/data", "x/y..", "a."} {
		if _, err := remoteText(CmdStartDaemon, "2.0.10", "pty", bad, "8420"); err == nil {
			t.Errorf("%q reached the remote command", bad)
		}
	}
	if _, err := remoteText(CmdStartDaemon, "2.0.10", "pty", ".coral", "8420"); err != nil {
		t.Error(err)
	}
}
