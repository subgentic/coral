//go:build webview

package main

import (
	"fmt"
	"testing"
)

// scratch (#13225, never to merge): TestDownloadInterceptScript 20 times in one run, to see on a Windows runner how often it fails.
func TestDownloadInterceptScriptRepeat20(t *testing.T) {
	for i := 0; i < 20; i++ {
		t.Run(fmt.Sprint(i), func(t *testing.T) { TestDownloadInterceptScript(t) })
	}
}
