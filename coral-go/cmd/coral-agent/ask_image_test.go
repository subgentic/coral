package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const askImageHex = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12"

// coral-agent ask --image shows one small picture from the agent's working folder in the card (#18768): an allowed one is uploaded and its id sent with the question; a path outside the folder, a link,
// the wrong type (by name or by bytes) or too many bytes is refused before anything is uploaded or asked.
func TestAskImageTakesOnlyASmallPictureFromTheWorkingFolder(t *testing.T) {
	var uploads, asks []string
	var ask map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if strings.HasPrefix(r.URL.Path, "/api/agent/artifacts") {
			uploads = append(uploads, r.Header.Get("X-Artifact-Name"))
			w.Write([]byte(`{"uri":"coral://artifacts/` + askImageHex + `"}`))
			return
		}
		asks = append(asks, string(b))
		ask = nil
		_ = json.Unmarshal(b, &ask)
		w.Write([]byte(`{"id":1}`))
	}))
	defer srv.Close()
	old := serverURL
	serverURL = srv.URL
	defer func() { serverURL = old }()

	t.Setenv("CORAL_SESSION_NAME", "claude-00000000-0000-4000-8000-000000000000") // the upload is the agent's own
	work := t.TempDir()
	outside := t.TempDir()
	wd, _ := os.Getwd()
	require.NoError(t, os.Chdir(work))
	defer os.Chdir(wd)
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	write := func(dir, name string, b []byte) string {
		p := filepath.Join(dir, name)
		require.NoError(t, os.WriteFile(p, b, 0o600))
		return p
	}
	write(work, "settings.png", png)
	write(work, "shot.jpeg", append([]byte("\xff\xd8\xff\xe0"), make([]byte, 64)...))
	write(work, "map.svg", []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>`))
	write(work, "fake.png", []byte("this is not a png"))
	write(work, "notes.txt", []byte("hello"))
	write(work, "big.png", append(png, make([]byte, askImageMax)...))
	write(outside, "secret.png", png)
	require.NoError(t, os.Symlink(filepath.Join(outside, "secret.png"), filepath.Join(work, "link.png")))

	var out bytes.Buffer
	for _, ok := range []struct{ file, ext string }{{"settings.png", ".png"}, {"shot.jpeg", ".jpeg"}, {"map.svg", ".svg"}} {
		require.NoError(t, cmdAsk([]string{"Open Settings.", "--image", ok.file, "--option", "Done"}, &out), ok.file)
		assert.Equal(t, askImageHex+ok.ext, ask["image"], ok.file+": the id and the kind of picture ride with the question")
	}
	assert.Equal(t, []string{"settings.png", "shot.jpeg", "map.svg"}, uploads)
	require.NoError(t, cmdAsk([]string{"Plain.", "--option", "Done"}, &out))
	assert.Equal(t, "", ask["image"], "no picture, none sent")

	before := len(uploads) + len(asks)
	for file, why := range map[string]string{
		filepath.Join(outside, "secret.png"):           "an absolute path outside the folder",
		"../" + filepath.Base(outside) + "/secret.png": "a dot-dot path out of the folder",
		"link.png":                     "a link to a file outside the folder",
		"https://example.com/shot.png": "a link",
		"missing.png":                  "a file that is not there",
		"notes.txt":                    "the wrong type",
		"fake.png":                     "a name that says png over bytes that are not",
		"big.png":                      "too many bytes",
		work:                           "a folder",
		"":                             "no file",
	} {
		err := cmdAsk([]string{"Look.", "--image", file}, &out)
		assert.Error(t, err, why)
	}
	assert.Error(t, cmdAsk([]string{"Look.", "--image", "settings.png", "--image", "shot.jpeg"}, &out), "one picture per question")
	assert.Equal(t, before, len(uploads)+len(asks), "a refused picture uploads nothing and asks nothing")
	assert.Contains(t, askUsageText, "--image FILE")
}
