package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/updater/push"
	"github.com/subgentic/coral/internal/updater/verify"
)

func pushStream(t *testing.T, version, asset string) []byte {
	pkg := []byte("package")
	sum := sha256.Sum256(pkg)
	rec, _ := json.Marshal(verify.Record{Version: version, Asset: asset, PackageSHA256: hex.EncodeToString(sum[:])})
	data := map[string][]byte{"promote.json": []byte("m"), "promote.json.sigstore.json": []byte("mb"), "SHA256SUMS.txt": []byte("s"), "SHA256SUMS.txt.sigstore.json": []byte("sb"), "record.json": rec, asset: pkg}
	var files []push.File
	for _, n := range push.Names(asset) {
		b := data[n]
		files = append(files, push.File{Name: n, Size: int64(len(b)), Open: func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(b)), nil }})
	}
	var out bytes.Buffer
	if err := push.Write(&out, asset, files); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func receiveEnv(t *testing.T) (dataDir string, getenv func(string) string) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("receive serves Linux and macOS")
	}
	old := config.Version
	config.Version = "1.2.2"
	t.Cleanup(func() { config.Version = old })
	dataDir = t.TempDir()
	t.Setenv("CORAL_DATA_DIR", dataDir)
	return dataDir, func(k string) string { return os.Getenv(k) }
}

func TestReceiveProbe(t *testing.T) {
	var out bytes.Buffer
	if code := runReceive([]string{"--probe"}, strings.NewReader(""), &out, func(string) string { return "" }); code != 0 || strings.TrimSpace(out.String()) != `{"receive":1}` {
		t.Fatalf("%d %q", code, out.String())
	}
}

func TestReceiveStagesWhatItIsSent(t *testing.T) {
	dataDir, getenv := receiveEnv(t)
	asset := assetName(runtime.GOOS, runtime.GOARCH, false)("1.2.3")
	var out bytes.Buffer
	if code := runReceive([]string{"--version", "1.2.3"}, bytes.NewReader(pushStream(t, "1.2.3", asset)), &out, getenv); code != 0 {
		t.Fatalf("%d %s", code, out.String())
	}
	if _, err := os.Stat(filepath.Join(dataDir, "updates", "staging", "1.2.3", asset)); err != nil {
		t.Fatal(err)
	}
	st, _ := verify.LoadState(filepath.Join(dataDir, "updates"))
	if st.Stage == nil || st.Stage.Staged != "1.2.3" {
		t.Fatalf("the updater's state does not know about it: %+v", st.Stage)
	}
}

func TestReceiveRefusesAnotherPlatformsPackageAndGarbage(t *testing.T) {
	dataDir, getenv := receiveEnv(t)
	other := "coral-linux-riscv-1.2.3.tar.gz" // not this platform's asset
	for name, b := range map[string][]byte{"other asset": pushStream(t, "1.2.3", other), "garbage": []byte("not a stream"), "empty": nil} {
		var out bytes.Buffer
		if code := runReceive([]string{"--version", "1.2.3"}, bytes.NewReader(b), &out, getenv); code == 0 {
			t.Fatalf("%s: accepted: %s", name, out.String())
		}
		if _, err := os.Stat(filepath.Join(dataDir, "updates", "staging", "1.2.3")); err == nil {
			t.Fatalf("%s: left a staged version", name)
		}
	}
}

func TestReceiveHonoursTheOffSwitchAndUsage(t *testing.T) {
	_, getenv := receiveEnv(t)
	var out bytes.Buffer
	if code := runReceive([]string{"--version", "1.2.3"}, strings.NewReader(""), &out, func(k string) string {
		if k == "CORAL_AUTO_UPDATE" {
			return "off"
		}
		return getenv(k)
	}); code == 0 || !strings.Contains(out.String(), "off") {
		t.Fatalf("%d %s", code, out.String())
	}
	for _, args := range [][]string{nil, {"--version"}, {"--version", "../1.2.3"}, {"--version", "1.2.3-rc1"}, {"--probe", "x"}} {
		if code := runReceive(args, strings.NewReader(""), io.Discard, getenv); code != 2 {
			t.Fatalf("%v: %d", args, code)
		}
	}
}
