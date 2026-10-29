package verify

import (
	"fmt"
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

// NotNewer reports whether staged (a plain X.Y.Z, as a staged release always is) is NOT newer than installed: older or equal. The installed version may carry a "v" and a prerelease or build
// suffix (1.4.167-rc1): its release is newer than it, and an earlier core is older. A version that does not parse says nothing (false), so nothing is dropped on a guess.
func NotNewer(staged, installed string) bool {
	core := strings.TrimPrefix(installed, "v")
	pre := false
	if i := strings.IndexAny(core, "-+"); i >= 0 {
		pre = core[i] == '-'
		core = core[:i]
	}
	c, err := CompareVersions(staged, core)
	if err != nil {
		return false
	}
	return c < 0 || (c == 0 && !pre)
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
