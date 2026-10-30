package license

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	terms "github.com/subgentic/coral/pkg/license"
)

func TestHubOwnerAcceptanceIsVersionBoundAndRecordsWhoAndWhen(t *testing.T) {
	marker := markerAt(t)
	old := eulaNow
	eulaNow = func() time.Time { return time.Date(2026, 10, 30, 22, 0, 0, 0, time.UTC) }
	defer func() { eulaNow = old }()

	TakeAcceptanceSource() // the slot is process-wide: an earlier test may have filled it
	if IsEULAAccepted() {
		t.Fatal("accepted before anything was recorded")
	}
	if err := RecordHubOwnerAcceptance(EULAVersion, terms.EULADigest(), "hub-owner@build-host"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"accepted\n", "version=" + EULAVersion + "\n", "sha256=" + terms.EULADigest() + "\n", "source=hub-owner\n", "accepted_by=hub-owner@build-host\n", "accepted_at=2026-10-30T22:00:00Z\n"} {
		if !strings.Contains(string(b), want) {
			t.Errorf("marker lacks %q:\n%s", want, b)
		}
	}
	if !IsEULAAccepted() || !EULAAcceptedLocally() {
		t.Error("the recorded acceptance does not count")
	}
	if src, ok := AcceptedSource(); ok {
		t.Errorf("the funnel has no word for it, but AcceptedSource gave %q", src)
	}
	if src, ok := TakeAcceptanceSource(); ok {
		t.Errorf("a funnel event would be sent for source %q", src)
	}
}

func TestHubOwnerAcceptanceRefusesOtherTermsAndOddLabels(t *testing.T) {
	marker := markerAt(t)
	for name, c := range map[string]struct{ version, digest, by string }{
		"another version":    {"1999-01-01", terms.EULADigest(), "hub-owner"},
		"another text":       {EULAVersion, strings.Repeat("0", 64), "hub-owner"},
		"empty":              {"", "", "hub-owner"},
		"no label":           {EULAVersion, terms.EULADigest(), ""},
		"label with space":   {EULAVersion, terms.EULADigest(), "the owner"},
		"label with newline": {EULAVersion, terms.EULADigest(), "x\nsource=dialog"},
		"label too long":     {EULAVersion, terms.EULADigest(), strings.Repeat("a", 65)},
	} {
		err := RecordHubOwnerAcceptance(c.version, c.digest, c.by)
		if err == nil {
			t.Errorf("%s: accepted", name)
		}
		if name == "another version" || name == "another text" || name == "empty" {
			if !errors.Is(err, ErrTermsMismatch) {
				t.Errorf("%s: %v", name, err)
			}
		}
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("a refused acceptance wrote the marker")
	}
	if IsEULAAccepted() {
		t.Error("accepted after refusals")
	}
}
