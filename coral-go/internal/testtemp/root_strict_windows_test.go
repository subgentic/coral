package testtemp

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// A root outside the profile (#6656): the folder holding the test's temp is a plain local fixed drive path; the root is made by the test with the access list it needs (or by hand, to be refused).
func rootBase(t *testing.T) string {
	t.Helper()
	base := filepath.Join(t.TempDir(), "mine")
	if err := os.Mkdir(base, 0o700); err != nil {
		t.Fatal(err)
	}
	return base
}

// makeWith makes dir with the given access list (SDDL) at creation.
func makeWith(t *testing.T, dir, sddl string) {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := windows.UTF16PtrFromString(dir)
	sa := &windows.SecurityAttributes{Length: uint32(24), SecurityDescriptor: sd}
	if err := windows.CreateDirectory(p, sa); err != nil {
		t.Fatal(err)
	}
}

func me(t *testing.T) *windows.SID {
	t.Helper()
	sid, err := currentUser()
	if err != nil {
		t.Fatal(err)
	}
	return sid
}

func TestOutsideRootIsAcceptedWhenItIsMadeOwnerOnlyAndProtected(t *testing.T) {
	root := filepath.Join(rootBase(t), rootName)
	if reason := checkOutsideRoot(root); reason != "" {
		t.Fatalf("a missing root under a real parent: %q", reason)
	}
	if reason := checkRootFolder(root, me(t)); reason != "" {
		t.Errorf("the root it made: %q", reason)
	}
	if reason := checkOutsideRoot(root); reason != "" { // the second caller opens what the first made
		t.Errorf("an existing good root: %q", reason)
	}
	dir, err := makePrivateDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if !privateName.MatchString(filepath.Base(dir)) || !ownerOnlyAcl(dir) || !ownedByMe(dir, nil) {
		t.Errorf("the private folder %q is not a ct-N folder owned by me with an owner-only list", filepath.Base(dir))
	}
}

// A root whose path holds an 8.3 short name (GitHub's Windows runners set TEMP to C:\Users\RUNNER~1\...) is not refused as a link: a short name is the same folder. On a drive
// with short names turned off there is no short form to give, and the test says so.
func TestOutsideRootUnderAShortNameIsAccepted(t *testing.T) {
	base := rootBase(t)
	in, err := windows.UTF16PtrFromString(base)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetShortPathName(in, &buf[0], uint32(len(buf)))
	short := windows.UTF16ToString(buf[:n])
	if err != nil || n == 0 || strings.EqualFold(short, base) {
		t.Skipf("this drive gives %q no 8.3 short form (short names off), so there is nothing to check here", base)
	}
	root := filepath.Join(short, rootName)
	if reason := checkOutsideRoot(root); reason != "" {
		t.Fatalf("a root under the short path %q: %q", short, reason)
	}
	// the long form is what the system resolves the test's own folder to: t.TempDir is itself under a short name on GitHub's runner (RUNNER~1 for runneradmin), so base is not it
	real, err := filepath.EvalSymlinks(base)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := longPath(root), filepath.Join(real, rootName); !strings.EqualFold(got, want) {
		t.Errorf("longPath(%q) = %q, want the long form the system gives, %q", root, got, want)
	}
}

func TestOutsideRootWithAnAuthenticatedUsersEntryIsRefused(t *testing.T) {
	root := filepath.Join(rootBase(t), rootName)
	makeWith(t, root, "D:P(A;OICI;GA;;;"+me(t).String()+")(A;OICI;GA;;;AU)")
	if reason := checkOutsideRoot(root); !strings.Contains(reason, "grants others") {
		t.Errorf("Authenticated Users: %q", reason)
	}
}

func TestOutsideRootWithAnInheritedListIsRefused(t *testing.T) {
	root := filepath.Join(rootBase(t), rootName)
	if err := os.Mkdir(root, 0o700); err != nil { // a plain folder inherits its list from the folder above (a created-with-explicit list is protected by Windows itself)
		t.Fatal(err)
	}
	if reason := checkOutsideRoot(root); !strings.Contains(reason, "not protected") {
		t.Errorf("an unprotected list: %q", reason)
	}
}

func TestOutsideRootBehindAJunctionIsRefused(t *testing.T) {
	base := rootBase(t)
	real := filepath.Join(base, "real")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	cmd := exec.Command("cmd", "/c", "mklink", "/J", link, real)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("no junction: %v %s", err, out)
	}
	if reason := checkOutsideRoot(filepath.Join(link, rootName)); !strings.Contains(reason, "not a real folder") && !strings.Contains(reason, "link or junction") {
		t.Errorf("a junction as the parent: %q", reason)
	}
}

func TestADescriptorOwnedByAnotherSidIsRefused(t *testing.T) {
	sd, err := windows.SecurityDescriptorFromString("O:SYD:P(A;OICI;GA;;;SY)")
	if err != nil {
		t.Fatal(err)
	}
	if reason := checkDescriptor(sd, me(t)); !strings.Contains(reason, "not owned") {
		t.Errorf("owned by SYSTEM: %q", reason)
	}
	sd, err = windows.SecurityDescriptorFromString("O:" + me(t).String() + "D:P(A;OICI;GA;;;" + me(t).String() + ")(A;OICI;GA;;;BA)")
	if err != nil {
		t.Fatal(err)
	}
	if reason := checkDescriptor(sd, me(t)); reason != "" {
		t.Errorf("mine, protected, me and Administrators: %q", reason)
	}
}

func TestOutsideRootAtADriveRootOrInAnotherFormIsRefused(t *testing.T) {
	vol := filepath.VolumeName(t.TempDir())
	if reason := checkOutsideRoot(vol + `\` + rootName); !strings.Contains(reason, "directly under a drive") {
		t.Errorf("directly under a drive: %q", reason)
	}
	for _, root := range []string{`\\server\share\` + rootName, `\\?\` + vol + `\x\` + rootName, `\\.\` + vol + `\x\` + rootName} {
		if _, reason := checkRoot(root); reason == "" {
			t.Errorf("%q accepted", root)
		}
	}
}

// The sweep does not follow a junction named like a private folder out of the root.
func TestSweepDoesNotFollowAJunctionOutOfTheRoot(t *testing.T) {
	base := rootBase(t)
	outside := filepath.Join(base, "outside")
	if err := os.Mkdir(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(outside, "keep.txt")
	if err := os.WriteFile(keep, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, rootName)
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("cmd", "/c", "mklink", "/J", filepath.Join(root, "ct-12345"), outside)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("no junction: %v %s", err, out)
	}
	sweepStale(root, time.Now().Add(48*time.Hour))
	if _, err := os.Stat(keep); err != nil {
		t.Errorf("the sweep reached through the junction: %v", err)
	}
}

// Only allow (0) and deny (1) entries are read; any other kind is refused, so a callback allow for Everyone cannot hide behind the SID test (Security, #6675 fix 1).
func TestAnEntryOfAnotherKindIsRefused(t *testing.T) {
	sd, err := windows.SecurityDescriptorFromString("O:" + me(t).String() + "D:P(A;OICI;GA;;;" + me(t).String() + ")(XA;OICI;GA;;;WD;(Member_of{SID(BA)}))")
	if err != nil {
		t.Skipf("no conditional entries here: %v", err)
	}
	if reason := checkDescriptor(sd, me(t)); !strings.Contains(reason, "kind") {
		t.Errorf("a callback allow for Everyone: %q", reason)
	}
}

// A root that would land in the source tree is refused before anything is made there (Security, #6675 fix 2).
func TestOutsideRootInTheSourceTreeIsRefusedAndNotMade(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(wd, rootName)
	if reason := checkOutsideRoot(root); !strings.Contains(reason, "source tree") {
		t.Errorf("in the source tree: %q", reason)
	}
	if _, err := os.Lstat(root); err == nil {
		os.Remove(root)
		t.Error("the root was made in the source tree before it was refused")
	}
}

// The folder that holds ct must be the user's own: the Windows folder is owned by TrustedInstaller.
func TestOutsideRootInAFolderAnotherAccountOwnsIsRefused(t *testing.T) {
	windir := os.Getenv("SystemRoot")
	if windir == "" {
		t.Skip("no SystemRoot")
	}
	root := filepath.Join(windir, rootName)
	if reason := checkOutsideRoot(root); reason == "" {
		os.Remove(root)
		t.Fatal("a root in the Windows folder was accepted")
	}
	if _, err := os.Lstat(root); err == nil {
		t.Error("a root was made in the Windows folder")
	}
}
