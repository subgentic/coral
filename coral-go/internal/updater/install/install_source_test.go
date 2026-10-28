package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func (r *brewRig) marker(version string, src map[string]string) {
	r.t.Helper()
	dir := filepath.Join(r.prefix, "Caskroom", "coral", version)
	require.NoError(r.t, os.MkdirAll(dir, 0o755))
	b, err := json.Marshal(src)
	require.NoError(r.t, err)
	require.NoError(r.t, os.WriteFile(filepath.Join(dir, InstallSourceFile), b, 0o644))
}

func (r *brewRig) running(version string) Options { o := r.options; o.Version = version; return o }

// #10561 (OPERATOR): a DMG-installed Coral.app was refused by the updater as Homebrew: the cask's installed metadata of an older version stays in the Caskroom after the person replaced the app with
// the DMG's, and "a bundle of this name, in an appdir" cannot tell the two. A record counts only for the version that is running.
func TestAStaleCaskRecordOfAnotherVersionDoesNotMakeADMGCopyHomebrew(t *testing.T) {
	r := newBrewRig(t)
	r.metadata("1.4.100", "coral.json", `{"artifacts":[{"app":["Coral.app"]}]}`) // the cask's record from the install that was replaced
	r.link("1.4.100")                                                            // and its link to the app path, which is now the DMG's copy
	assert.Empty(t, MacManaged(r.app, r.running("2.0.3")), "the running version is not the cask's: a DMG copy")
	assert.Equal(t, MacHomebrew, MacManaged(r.app, r.running("1.4.100")), "the record of the running version still counts")
	assert.Equal(t, MacHomebrew, MacManaged(r.app, r.options), "no running version known: every record counts, as before")

	r = newBrewRig(t)
	r.metadata("1.4.100", "coral.json", `{"artifacts":[{"app":["Coral.app"]}]}`)
	assert.Empty(t, MacManaged(r.app, r.running("2.0.3")), "the metadata alone, of another version")
	assert.Equal(t, MacHomebrew, MacManaged(r.app, r.running("1.4.100")))
}

// #10561: the cask's postflight writes an install-source marker outside the signed bundle; MacManaged reads it. It names this very app, for the running version, and nothing else counts from it.
func TestTheCasksInstallSourceMarkerMeansHomebrewForTheRunningVersionOnly(t *testing.T) {
	r := newBrewRig(t)
	r.marker("2.0.3", map[string]string{"source": "homebrew-cask", "app": r.app, "version": "2.0.3"})
	assert.Equal(t, MacHomebrew, MacManaged(r.app, r.running("2.0.3")), "the marker of this version for this app")
	assert.Empty(t, MacManaged(r.app, r.running("2.0.4")), "a newer version came another way over the cask's app: not the cask's")
	assert.Equal(t, MacHomebrew, MacManaged(r.app, r.options), "no running version known: the marker counts")

	for name, src := range map[string]map[string]string{
		"another app":                        {"source": "homebrew-cask", "app": filepath.Join(r.root, "Elsewhere", "Coral.app"), "version": "2.0.3"},
		"not the cask's source":              {"source": "dmg", "app": r.app, "version": "2.0.3"},
		"a version that is not the folder's": {"source": "homebrew-cask", "app": r.app, "version": "2.0.2"},
		"no version":                         {"source": "homebrew-cask", "app": r.app},
	} {
		o := newBrewRig(t)
		if name == "another app" {
			require.NoError(t, os.MkdirAll(filepath.Join(o.root, "Elsewhere", "Coral.app"), 0o755))
		}
		src2 := map[string]string{}
		for k, v := range src {
			if v == r.app {
				v = o.app // the rig's own app
			}
			src2[k] = v
		}
		if name == "another app" {
			src2["app"] = filepath.Join(o.root, "Elsewhere", "Coral.app")
		}
		o.marker("2.0.3", src2)
		assert.Empty(t, MacManaged(o.app, o.running("2.0.3")), name)
	}

	// a marker that is not a small regular JSON file is not read
	o := newBrewRig(t)
	dir := filepath.Join(o.prefix, "Caskroom", "coral", "2.0.3")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, InstallSourceFile), []byte("not json"), 0o644))
	assert.Empty(t, MacManaged(o.app, o.running("2.0.3")), "junk")
}

// #10561: the cask in the repository writes the marker this package reads: its file name, source word and fields are the ones MacManaged expects (the tap's own copy of the cask must carry the same postflight).
func TestTheCaskInTheRepositoryWritesTheMarkerMacManagedReads(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "Casks", "coral.rb"))
	if err != nil {
		t.Skip("the cask is not in this checkout")
	}
	cask := string(b)
	assert.Contains(t, cask, "postflight do")
	assert.Contains(t, cask, `staged_path/"`+InstallSourceFile+`"`, "the marker goes next to the version's staged files")
	for _, want := range []string{`"source" => "homebrew-cask"`, `"app" => "#{appdir}/Coral.app"`, `"version" => version.to_s`} {
		assert.Contains(t, cask, want)
	}
}
