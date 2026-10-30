package verify

import (
	"fmt"
	"github.com/subgentic/coral/internal/semverorder"
	"regexp"
	"strconv"
	"strings"
)

// versionRe is a release version: three numbers, no suffix (a promoted release is never a prerelease). The same pattern the hub validates.
var versionRe = regexp.MustCompile(`^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$`)

// ParseVersion reads "1.4.123" (a leading v is not accepted: callers strip a tag's).
func ParseVersion(s string) ([3]int, error) {
	var out [3]int
	if !versionRe.MatchString(s) {
		return out, fmt.Errorf("version %q is not X.Y.Z", s)
	}
	for i, p := range strings.Split(s, ".") {
		n, _ := strconv.Atoi(p)
		out[i] = n
	}
	return out, nil
}

// NotNewer reports whether staged is NOT newer than installed: older or equal, in the one order everything that asks "is this newer?" uses (semverorder: a "v", a prerelease; a release is newer
// than its own prerelease). A version that does not parse (build metadata "+x" included: Coral's versions have none) says nothing (false), so nothing is dropped on a guess.
func NotNewer(staged, installed string) bool { return semverorder.NotNewer(staged, installed) }

// ParseInstalled says whether s is the version of a Coral build that is installed: a release (1.4.123) or a prerelease of one (2.0.5-rc1), the versions Coral's own builds carry, in
// the order semverorder gives them (a release is above its own prerelease). No leading v, no build metadata. A STAGED version is never a prerelease (ParseVersion).
func ParseInstalled(s string) bool {
	if strings.HasPrefix(s, "v") {
		return false
	}
	_, ok := semverorder.Parse(s)
	return ok
}

// CompareToInstalled is -1, 0 or 1 for a staged release against the installed version: the staged one must be a release (X.Y.Z), the installed one may be a prerelease of it
// (so a 0.0.1-rc1 install is offered 0.0.1, which is above it, and is not offered 0.0.1-rc1's own older releases). Either not parsing is an error.
func CompareToInstalled(staged, installed string) (int, error) {
	if _, err := ParseVersion(staged); err != nil {
		return 0, err
	}
	if !ParseInstalled(installed) {
		return 0, fmt.Errorf("installed version %q is not a Coral version", installed)
	}
	a, _ := semverorder.Parse(staged)
	b, _ := semverorder.Parse(installed)
	return semverorder.Compare(a, b), nil
}

// CompareVersions is -1, 0 or 1; both must parse.
func CompareVersions(a, b string) (int, error) {
	x, err := ParseVersion(a)
	if err != nil {
		return 0, err
	}
	y, err := ParseVersion(b)
	if err != nil {
		return 0, err
	}
	for i := range x {
		switch {
		case x[i] < y[i]:
			return -1, nil
		case x[i] > y[i]:
			return 1, nil
		}
	}
	return 0, nil
}
