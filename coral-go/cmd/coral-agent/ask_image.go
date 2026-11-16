package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// askImageMax is the size cap of the picture on a question card (#18768): a screenshot of a page, not a photo library.
const askImageMax = 2 << 20

var askImageArtifactRE = regexp.MustCompile(`^coral://artifacts/([0-9a-f]{64})$`)

// askImageFile checks the picture for a question card before anything is sent: a file in the agent's working folder (never a URL, never a path out of it, never a link to somewhere else),
// PNG, JPEG or SVG by its bytes as well as its name, at most askImageMax. It returns the file's real path.
func askImageFile(arg string) (string, error) {
	if strings.TrimSpace(arg) == "" {
		return "", fmt.Errorf("--image needs a picture file in your working folder")
	}
	if strings.Contains(arg, "://") {
		return "", fmt.Errorf("--image takes a file in your working folder, not a link")
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	root, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return "", err
	}
	path := arg
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("--image %q: no such file", arg)
	}
	if rel, err := filepath.Rel(root, real); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("--image %q is outside your working folder", arg)
	}
	info, err := os.Stat(real)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("--image %q is not a plain file", arg)
	}
	if info.Size() > askImageMax {
		return "", fmt.Errorf("--image %q is %d KB: a picture on a card is at most %d KB", arg, info.Size()>>10, askImageMax>>10)
	}
	f, err := os.Open(real)
	if err != nil {
		return "", err
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	head = head[:n]
	switch ext := strings.ToLower(filepath.Ext(real)); {
	case ext == ".png" && bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n")):
	case (ext == ".jpg" || ext == ".jpeg") && bytes.HasPrefix(head, []byte("\xff\xd8\xff")):
	case ext == ".svg" && bytes.Contains(bytes.ToLower(head), []byte("<svg")):
	default:
		return "", fmt.Errorf("--image %q is not a PNG, JPEG or SVG picture", arg)
	}
	return real, nil
}

// uploadAskImage stores the checked picture as an artifact of this agent (the same upload, with the same server-side checks, as coral-agent artifact upload) and returns its 64-hex id with the picture's extension (png, jpg, jpeg or svg).
func uploadAskImage(file string) (string, error) {
	var out bytes.Buffer
	if err := uploadArtifactFull(serverURL, file, filepath.Base(file), "", resolveSessionID(), "", "none", []string{"internal"}, "", "", "", false, &out, io.Discard); err != nil {
		return "", err
	}
	var reply struct {
		URI string `json:"uri"`
	}
	_ = json.Unmarshal(out.Bytes(), &reply)
	m := askImageArtifactRE.FindStringSubmatch(reply.URI)
	if m == nil {
		return "", fmt.Errorf("Coral stored the picture but gave no artifact id")
	}
	return m[1] + strings.ToLower(filepath.Ext(file)), nil // the id and the kind of picture: the card needs the kind to show an SVG safely
}
