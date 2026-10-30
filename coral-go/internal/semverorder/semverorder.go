// Package semverorder orders Coral's release versions: three numbers and an optional prerelease (v1.4.167, 2.0.3-rc1). One order for everything that asks "is this newer?": the
// release-feed check (updatecheck) and the updater's staged-release check (updater/verify), which may not import each other.
package semverorder

import (
	"regexp"
	"strconv"
	"strings"
)

// TagShape is a release tag: v, three numbers, an optional prerelease of letters, digits and dots. Build metadata ("+x") is not a version Coral uses.
var TagShape = regexp.MustCompile(`^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.]{1,40}))?$`)

// Version is a parsed version: the core numbers and the prerelease identifiers (none for a release).
type Version struct {
	Core [3]int
	Pre  []string
}

// Parse reads a version, with or without a "v"; ok is false for anything that is not one ("dev", "", build metadata).
func Parse(s string) (Version, bool) {
	m := TagShape.FindStringSubmatch(s)
	if m == nil {
		return Version{}, false
	}
	var v Version
	for i := 0; i < 3; i++ {
		v.Core[i], _ = strconv.Atoi(m[i+1])
	}
	if m[4] != "" {
		v.Pre = strings.Split(m[4], ".")
	}
	return v, true
}

// Compare orders versions as semver: the core numbers, then a release above any prerelease of the same core, then prerelease identifiers (numbers below words, numbers by value).
func Compare(a, b Version) int {
	for i := range a.Core {
		if a.Core[i] != b.Core[i] {
			return cmpInt(a.Core[i], b.Core[i])
		}
	}
	switch {
	case len(a.Pre) == 0 && len(b.Pre) == 0:
		return 0
	case len(a.Pre) == 0:
		return 1
	case len(b.Pre) == 0:
		return -1
	}
	for i := 0; i < len(a.Pre) && i < len(b.Pre); i++ {
		x, y := a.Pre[i], b.Pre[i]
		xn, xerr := strconv.Atoi(x)
		yn, yerr := strconv.Atoi(y)
		switch {
		case xerr == nil && yerr == nil:
			if xn != yn {
				return cmpInt(xn, yn)
			}
		case xerr == nil:
			return -1
		case yerr == nil:
			return 1
		case x != y:
			return strings.Compare(x, y)
		}
	}
	return cmpInt(len(a.Pre), len(b.Pre))
}

// Newer reports whether latest is strictly newer than current; a version that doesn't parse is never newer, and nothing is newer than it.
func Newer(latest, current string) bool {
	l, ok1 := Parse(latest)
	c, ok2 := Parse(current)
	return ok1 && ok2 && Compare(l, c) > 0
}

// NotNewer reports whether candidate is a version that is NOT newer than current: older or equal, both parsing. A version that doesn't parse says nothing (false), so nothing is dropped
// on a guess.
func NotNewer(candidate, current string) bool {
	l, ok1 := Parse(candidate)
	c, ok2 := Parse(current)
	return ok1 && ok2 && Compare(l, c) <= 0
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
