// Package install is the one classifier of what kind of install this Coral is, used by "coral-update status", "check" and "apply" alike (#5280 step 3 B, Codex Test's survey): an install a
// package manager owns is never updated by Coral. Homebrew's cask moves Coral.app to its appdir and leaves a link to it in the Caskroom, and records the cask as installed metadata; either is
// enough here. It reads folders and a few small files and writes nothing, and it has no dependency on the verifier.
package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// MacHomebrew is the word for a Homebrew-managed install (the apply's ResultUnsupported reason, the status's install kind).
const MacHomebrew = "homebrew"

// Options say where to look. The zero value looks nowhere.
type Options struct {
	// Prefixes are the Homebrew prefixes (each has a Caskroom folder).
	Prefixes []string
	// Appdirs are the folders Homebrew puts a cask's app in (/Applications, ~/Applications).
	Appdirs []string
	// Version is the running Coral's version. Homebrew's records of an install name the cask version they were made for, and a copy of Coral that arrived another way later (the DMG over a cask's
	// app) sits under a stale record of an older version: a record counts only when its version is this one. Empty: not known, and every record counts, as before (#10561).
	Version string
}

// MacOptions are the places a Finder-launched Coral looks: the default prefixes whatever the environment says (a Finder-launched process has none of the shell's variables), the one in
// HOMEBREW_PREFIX when it is set, and the two appdirs. A custom prefix a Finder-launched Coral cannot be told about is not seen.
func MacOptions(home, homebrewPrefix string) Options {
	o := Options{Prefixes: []string{"/opt/homebrew", "/usr/local"}, Appdirs: []string{"/Applications"}}
	if homebrewPrefix != "" && filepath.IsAbs(homebrewPrefix) {
		o.Prefixes = append(o.Prefixes, filepath.Clean(homebrewPrefix))
	}
	if home != "" && filepath.IsAbs(home) {
		o.Appdirs = append(o.Appdirs, filepath.Join(home, "Applications"))
	}
	return o
}

// caskNames are the files Homebrew records an installed cask in: the current JSON, the internal JSON and the legacy Ruby caskfile. A missing install receipt is normal and means nothing.
var caskNames = []string{"coral.json", "coral.internal.json", "coral.rb"}

const maxCaskBytes = 256 << 10

// InstallSourceFile is the marker the cask's postflight writes next to the version's staged files (Caskroom/coral/<version>/install-source.json), outside the signed bundle: what installed this
// copy, where it put it and which version (#10561). A DMG copy has none.
const InstallSourceFile = "install-source.json"

// installSource is the marker's content.
type installSource struct {
	Source  string `json:"source"`
	App     string `json:"app"`
	Version string `json:"version"`
}

// MacManaged returns MacHomebrew when the app at app is one Homebrew installed, "" when it is not (or cannot be told). Three kinds of evidence, any enough, each only for the running version (o.Version,
// when it is known: a DMG copy put over a cask's app later is not the cask's, and the cask's records of its older version stay behind it, #10561):
//   - the install-source marker the cask's postflight writes (Caskroom/coral/<version>/install-source.json): source "homebrew-cask", the app path it put there (this very app) and its version;
//   - a Caskroom/coral/<version>/<name>.app link that resolves to this very app (what Homebrew leaves after it moves the app to its appdir);
//   - the cask recorded as installed metadata (Caskroom/coral/.metadata/<version>/<time>/Casks/coral.{json,internal.json,rb}) naming this app's bundle, for an app that sits in an appdir:
//     the metadata says Homebrew installed a bundle of this name, the appdir says this is where it puts it. A Caskroom folder or a receipt alone proves nothing and is not used.
func MacManaged(app string, o Options) string {
	real, err := filepath.EvalSymlinks(app)
	if err != nil {
		return ""
	}
	name := filepath.Base(real)
	inAppdir := false
	for _, d := range o.Appdirs {
		if dr, err := filepath.EvalSymlinks(d); err == nil && filepath.Dir(real) == dr {
			inAppdir = true
		}
	}
	current := func(version string) bool { return o.Version == "" || version == o.Version }
	for _, prefix := range o.Prefixes {
		markers, _ := filepath.Glob(filepath.Join(prefix, "Caskroom", "coral", "*", InstallSourceFile))
		for _, m := range markers {
			if markerNamesApp(m, real, o.Version) {
				return MacHomebrew
			}
		}
		links, _ := filepath.Glob(filepath.Join(prefix, "Caskroom", "coral", "*", name))
		for _, l := range links {
			if !current(filepath.Base(filepath.Dir(l))) {
				continue
			}
			if target, err := filepath.EvalSymlinks(l); err == nil && target == real {
				return MacHomebrew
			}
		}
		if !inAppdir {
			continue
		}
		for _, cask := range caskNames {
			files, _ := filepath.Glob(filepath.Join(prefix, "Caskroom", "coral", ".metadata", "*", "*", "Casks", cask))
			for _, f := range files {
				if !current(filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(f))))) { // .metadata/<version>/<time>/Casks/<file>
					continue
				}
				if namesApp(f, name) {
					return MacHomebrew
				}
			}
		}
	}
	return ""
}

// markerNamesApp reports whether the cask's install-source marker says Homebrew put this very app there, for the running version: a small regular file, source "homebrew-cask", its version the folder's
// and (when known) the running one, its app path resolving to real.
func markerNamesApp(file, real, running string) bool {
	fi, err := os.Lstat(file)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > maxCaskBytes {
		return false
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return false
	}
	var src installSource
	if json.Unmarshal(b, &src) != nil || src.Source != "homebrew-cask" || src.Version == "" || src.Version != filepath.Base(filepath.Dir(file)) {
		return false
	}
	if running != "" && src.Version != running {
		return false
	}
	target, err := filepath.EvalSymlinks(src.App)
	return err == nil && target == real
}

// namesApp reports whether the cask file names the bundle: its text holds the quoted bundle name, as the JSON's app artifact and the Ruby's app stanza do.
func namesApp(file, name string) bool {
	fi, err := os.Lstat(file)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > maxCaskBytes {
		return false
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return false
	}
	return strings.Contains(string(b), `"`+name+`"`)
}
