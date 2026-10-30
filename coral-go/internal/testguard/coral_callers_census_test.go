package testguard

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Census: every package whose tests can name a Coral's address links testguard. The guard only exists in a test binary that links it (its init refuses the live Coral's ports,
// drops the agent shell's tmux), so a package that can call a Coral and does not link it is a test that can reach the live server unguarded. "Can name a Coral's address" is read from
// the source: a non-test file that mentions CORAL_URL, CORAL_PORT, DefaultPort or a lookup of the recorded server (LocalServerURL, RecordedServer, VerifiedServer); a package's test
// binary "can" if it links such a package, or is one. internal/config links testguard itself, so every package that imports config does; the census holds the rest.
// An accident guard: a raw net.Dial or a custom http.Transport still bypasses the guard, and a package that builds its address from nothing named above is not seen.
var corAddressMentions = regexp.MustCompile(`CORAL_URL|CORAL_PORT|DefaultPort|LocalServerURL|RecordedServer|VerifiedServer`)

const guardPackage = "github.com/subgentic/coral/internal/testguard"

func TestEveryTestPackageThatCanNameACoralAddressLinksTestguard(t *testing.T) {
	if testing.Short() {
		t.Skip("runs go list over every package")
	}
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) string {
		cmd := exec.Command("go", args...)
		cmd.Dir = root
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("go %s: %v", strings.Join(args, " "), err)
		}
		return strings.ReplaceAll(string(out), "\r", "")
	}
	namers := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(run("list", "-f", "{{.ImportPath}}|{{.Dir}}|{{join .GoFiles \" \"}}", "./...")), "\n") {
		parts := strings.SplitN(line, "|", 3)
		if len(parts) != 3 {
			continue
		}
		for _, f := range strings.Fields(parts[2]) {
			if b, err := os.ReadFile(filepath.Join(parts[1], f)); err == nil && corAddressMentions.Match(b) {
				namers[parts[0]] = true
				break
			}
		}
	}
	if len(namers) < 10 {
		t.Fatalf("the census found only %d packages that name a Coral address: it is looking at nothing", len(namers))
	}
	checked, linked := 0, 0
	for _, line := range strings.Split(strings.TrimSpace(run("list", "-test", "-f", "{{if .ForTest}}{{.ForTest}}|{{join .Deps \" \"}}{{end}}", "./...")), "\n") {
		pkg, deps, ok := strings.Cut(line, "|")
		if !ok {
			continue
		}
		d := map[string]bool{pkg: true}
		for _, p := range strings.Fields(deps) {
			d[p] = true
		}
		can := false
		for p := range namers {
			if d[p] {
				can = true
				break
			}
		}
		if !can {
			continue
		}
		checked++
		if d[guardPackage] {
			linked++
			continue
		}
		t.Errorf("%s: its tests can name a Coral's address and do not link testguard: add a test file with `import _ %q` (testguard_link_test.go)", strings.TrimPrefix(pkg, "github.com/subgentic/coral/"), guardPackage)
	}
	if checked < 20 || linked < 15 {
		t.Fatalf("the census checked %d packages (%d linked): it is looking at the wrong thing", checked, linked)
	}
}
