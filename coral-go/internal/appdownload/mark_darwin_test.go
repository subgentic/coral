//go:build darwin

package appdownload

import (
	"encoding/base64"
	"strings"
	"testing"
)

// A file saved from the app carries the quarantine mark a browser's download does (#9894).
func TestSavedFileIsQuarantinedOnMac(t *testing.T) {
	path, err := Save(t.TempDir(), "tool.terminal", base64.StdEncoding.EncodeToString([]byte("#!/bin/sh\n")))
	if err != nil {
		t.Fatal(err)
	}
	v, ok := quarantineOf(path)
	if !ok || !strings.HasPrefix(v, "0081;") || !strings.HasSuffix(v, ";Coral;") {
		t.Fatalf("the saved file has no quarantine mark: %q %v", v, ok)
	}
}
