//go:build webview && darwin

package main

import "testing"

func TestGUITestsNeedTheExplicitOptIn(t *testing.T) {
	env := func(v string) func(string) string {
		return func(k string) string {
			if k == guiTestsEnv {
				return v
			}
			return ""
		}
	}
	for _, off := range []string{"", "0", "true", "yes", " 1"} {
		if guiTestsAllowed(env(off)) {
			t.Errorf("%q must not allow window-opening tests", off)
		}
	}
	if !guiTestsAllowed(env("1")) {
		t.Error("1 allows them")
	}
}
