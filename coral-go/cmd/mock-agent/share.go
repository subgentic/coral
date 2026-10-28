package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// shareNameRe is what a tester may name the file: a plain file name, no folder.
var shareNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._ -]{0,62}$`)

// coralAgentTool is the coral-agent the stand-in uploads through, like a real agent's tool call, so the request carries the session's token from the inherited environment:
// MOCK_AGENT_CORAL_AGENT, else a coral-agent next to this executable ("" when there is none).
func coralAgentTool() string {
	if p := os.Getenv("MOCK_AGENT_CORAL_AGENT"); p != "" {
		return p
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	name := "coral-agent"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	p := filepath.Join(filepath.Dir(exe), name)
	if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() {
		return p
	}
	return ""
}

// shareContent is a small generated file for the name: a PNG (a colour gradient) for a .png name, else a few lines of text. The media type goes with it.
func shareContent(name string) ([]byte, string) {
	if strings.EqualFold(filepath.Ext(name), ".png") {
		img := image.NewRGBA(image.Rect(0, 0, 96, 64))
		for y := 0; y < 64; y++ {
			for x := 0; x < 96; x++ {
				img.Set(x, y, color.RGBA{R: uint8(x * 255 / 95), G: uint8(y * 255 / 63), B: 160, A: 255})
			}
		}
		var buf bytes.Buffer
		_ = png.Encode(&buf, img)
		return buf.Bytes(), "image/png"
	}
	return []byte(fmt.Sprintf("Shared by mock-agent for testing artifacts.\nName: %s\nAt: %s\n", name, time.Now().UTC().Format(time.RFC3339))), "text/plain"
}

// shareFile makes the stand-in upload a small generated file as an artifact, as a real agent's `coral-agent artifact upload` does (#10739, MOCK_SHARE_FILE <name>), and says what happened in a line.
func shareFile(name string) string {
	if name == "" {
		name = "mock-share.txt"
	}
	if !shareNameRe.MatchString(name) || strings.Contains(name, "..") {
		return "[mock-agent] MOCK_SHARE_FILE takes a plain file name, like report.txt or picture.png"
	}
	tool := coralAgentTool()
	if tool == "" {
		return "[mock-agent] no coral-agent to upload with (put one next to mock-agent or set MOCK_AGENT_CORAL_AGENT)"
	}
	dir, err := os.MkdirTemp("", "mock-share-")
	if err != nil {
		return "[mock-agent] share failed: " + err.Error()
	}
	defer os.RemoveAll(dir)
	data, mediaType := shareContent(name)
	file := filepath.Join(dir, name)
	if err := os.WriteFile(file, data, 0o600); err != nil {
		return "[mock-agent] share failed: " + err.Error()
	}
	out, err := exec.Command(tool, "artifact", "upload", file, "--name", name, "--media-type", mediaType).CombinedOutput()
	if err != nil {
		return fmt.Sprintf("[mock-agent] share failed: %v %s", err, strings.TrimSpace(string(out)))
	}
	return "[mock-agent] shared " + name
}
