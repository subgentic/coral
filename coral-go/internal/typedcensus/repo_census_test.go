package typedcensus

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// coralOrigin matches what types text into an agent's terminal as Coral (not as a person): Coral's own input origin and the gate's
// immediate delivery.
var coralOrigin = regexp.MustCompile(`terminalinput\.Coral\b|\bDeliverNow\(`)

// coralOriginFiles are the only product files (paths from coral-go/) that may use coralOrigin, each with why it is safe. A file that
// types as Coral and is not here fails TestOnlyListedFilesTypeAsCoral: its text must come from a typed builder in a package census
// (TestTypedNoticeCensus) and its calls be listed there (TestEveryTypedSenderIsInTheCensus) before it is added (the coral-go-team's
// Security on #210).
var coralOriginFiles = map[string]string{
	"internal/background/agent_exited.go":            "deliverAutomatedIfWanted: the background senders' one gate; its callers are in background's census",
	"internal/ptymanager/automated_input_deliver.go": "the automated-input gate itself (DeliverAutomated, DeliverNow)",
	"internal/server/routes/agent_exited.go":         "deliverAutomated: the routes senders' one gate; its callers are in routes' census",
	"internal/server/routes/agent_ui_request.go":     "the UI panel request: the person's own request, typed as their own send is",
	"internal/server/routes/sessions_input.go":       "POST /send and /keys from a caller that is not a person: the caller's own input, through the gate",
	"internal/server/routes/sessions_waiting.go":     "Send now: board.NudgeText, in routes' census",
}

// Every product Go file (internal/, cmd/, pkg/; not tests) that types as Coral is in coralOriginFiles, and every listed file still
// does: a new sender anywhere in the module fails here, not only in the packages that have a census of their own.
func TestOnlyListedFilesTypeAsCoral(t *testing.T) {
	root := filepath.Join("..", "..") // coral-go/
	var found []string
	for _, top := range []string{"internal", "cmd", "pkg"} {
		err := filepath.WalkDir(filepath.Join(root, top), func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
				return nil
			}
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			for _, line := range strings.Split(string(b), "\n") {
				if code := strings.TrimSpace(line); !strings.HasPrefix(code, "//") && coralOrigin.MatchString(code) {
					rel, _ := filepath.Rel(root, p)
					found = append(found, filepath.ToSlash(rel))
					break
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	sort.Strings(found)
	seen := map[string]bool{}
	for _, f := range found {
		seen[f] = true
		if _, ok := coralOriginFiles[f]; !ok {
			t.Errorf("%s types into an agent's terminal as Coral (terminalinput.Coral or DeliverNow) and is not in coralOriginFiles: give it a typed builder in its package's census, list its calls there, then list the file here with why", f)
		}
	}
	for f, why := range coralOriginFiles {
		if !seen[f] {
			t.Errorf("%s is listed (%s) but no longer types as Coral: take it off the list", f, why)
		}
	}
}
