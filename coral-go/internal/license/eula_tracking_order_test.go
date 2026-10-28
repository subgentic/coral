package license

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	terms "github.com/subgentic/coral/pkg/license"
)

// #10004 (Security's MUST, round 1): the terms are accepted BEFORE the server has read the saved analytics choice (the terminal dialog and the legacy migration run ahead of startup.Start), so the license
// package only remembers how they were accepted, in one bounded slot, and startup.Start says so once the choice is applied. Nothing here may send anything.
func TestAcceptanceIsKeptForTheFunnelAndNeverSentFromHere(t *testing.T) {
	markerAt(t)
	TakeAcceptanceSource() // a clean slot
	_, ok := TakeAcceptanceSource()
	assert.False(t, ok, "nothing accepted in this run")

	require(t, WriteEULAMarker())
	src, ok := TakeAcceptanceSource()
	assert.True(t, ok)
	assert.Equal(t, "dialog", src)
	_, ok = TakeAcceptanceSource()
	assert.False(t, ok, "taken once")

	require(t, RecordHubTermsAcceptance(terms.EULAVersion))
	src, _ = TakeAcceptanceSource()
	assert.Equal(t, "hub", src)

	// The first source of the run is kept: a later one does not replace it.
	require(t, WriteEULAMarker())
	require(t, RecordHubTermsAcceptance(terms.EULAVersion))
	src, _ = TakeAcceptanceSource()
	assert.Equal(t, "dialog", src)

	// A Hub that confirmed another version records nothing, so there is nothing to announce.
	assert.Error(t, RecordHubTermsAcceptance("1999-01-01"))
	_, ok = TakeAcceptanceSource()
	assert.False(t, ok)

}

// The legacy marker the Windows installer writes is migrated to this version's at the next launch: that is an acceptance too, remembered the same way.
func TestAMigratedLegacyMarkerIsKeptAsLegacy(t *testing.T) {
	marker := markerAt(t)
	TakeAcceptanceSource()
	writeMarker(t, marker, "accepted\n")
	MigrateLegacyEULAMarker()
	src, ok := TakeAcceptanceSource()
	assert.True(t, ok)
	assert.Equal(t, "legacy", src)
}

// The license package must not import the tracking package, and eula_accepted is sent from one place only: startup.Start, after the saved analytics choice is applied.
func TestEULAAcceptedIsSentOnlyFromStartup(t *testing.T) {
	src, err := os.ReadFile("eula.go")
	if err != nil {
		t.Fatal(err)
	}
	assert.NotContains(t, string(src), "internal/tracking", "license only remembers; it never talks to analytics")

	var sites []string
	root := filepath.Join("..", "..")
	if err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if n := d.Name(); n == "node_modules" || n == ".git" || n == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") || strings.Contains(p, filepath.Join("internal", "tracking")+string(filepath.Separator)) {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if strings.Contains(string(b), "TrackEULAAccepted(") {
			sites = append(sites, filepath.ToSlash(p))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	assert.Equal(t, []string{"../../internal/startup/startup.go"}, sites, "one call site, where the saved analytics choice is known")
}

// #10106: the server the Coral app starts is a child process: the terms were accepted in the app's own dialog, so this process has only the marker. It says how.
func TestAcceptedSourceReadsTheMarkerAnotherProcessWrote(t *testing.T) {
	marker := markerAt(t)
	_, ok := AcceptedSource()
	assert.False(t, ok, "no marker: not accepted")
	for _, source := range []string{"dialog", "legacy", "hub"} {
		writeMarker(t, marker, "accepted\nversion="+terms.EULAVersion+"\nsha256="+terms.EULADigest()+"\nsource="+source+"\n")
		got, ok := AcceptedSource()
		assert.True(t, ok, source)
		assert.Equal(t, source, got)
	}
	writeMarker(t, marker, "accepted\n") // the Windows installer's bare marker
	got, ok := AcceptedSource()
	assert.True(t, ok)
	assert.Equal(t, "legacy", got)
	writeMarker(t, marker, "accepted\nversion=1999-01-01\nsha256=abc\nsource=dialog\n")
	_, ok = AcceptedSource()
	assert.False(t, ok, "another terms version is not an acceptance of these")
	writeMarker(t, marker, "accepted\nversion="+terms.EULAVersion+"\nsha256="+terms.EULADigest()+"\nsource=a-name-nobody-chose\n")
	_, ok = AcceptedSource()
	assert.False(t, ok, "a source the funnel has no word for sends nothing")
}
