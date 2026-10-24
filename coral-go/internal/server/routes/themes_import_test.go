package routes

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
)

// #7188 (Security Windows's #7181): an import whose multipart body is cut, or malformed, is a 400 that says the upload could not be read, and stores nothing. The handler used to ignore ParseMultipartForm's
// error and rely on FormFile's second parse failing ("file required"); the status was a 400 already, but the reason was wrong and nothing in the code said a cut upload was refused. The cut right after a
// complete JSON file but before the closing boundary is the one a "whole theme" reading would wrongly accept.
func TestImportThemeRefusesACutOrMalformedUpload(t *testing.T) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", "cut.json")
	require.NoError(t, err)
	_, err = part.Write([]byte(`{"name":"cutoff","description":"d","base":"dark","variables":{}}`))
	require.NoError(t, err)
	require.NoError(t, mw.Close())
	whole := body.String()
	closing := strings.LastIndex(whole, "\r\n--"+mw.Boundary()+"--")
	require.Positive(t, closing)

	do := func(t *testing.T, contentType, payload string) (*httptest.ResponseRecorder, string) {
		cfg := &config.Config{}
		cfg.UseCoralDir(t.TempDir())
		h := NewThemesHandler(cfg)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/themes/import", strings.NewReader(payload))
		req.Header.Set("Content-Type", contentType)
		h.ImportTheme(rec, req)
		return rec, h.themesDir
	}
	stored := func(dir string) []string {
		names, _ := filepath.Glob(filepath.Join(dir, "*"))
		return names
	}

	t.Run("the whole upload is saved", func(t *testing.T) {
		rec, dir := do(t, mw.FormDataContentType(), whole)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		_, err := os.Stat(filepath.Join(dir, "cutoff.json"))
		assert.NoError(t, err)
	})
	for name, cut := range map[string]int{
		"cut before the closing boundary": closing,
		"cut inside the closing boundary": closing + 10,
		"cut inside the headers":          strings.Index(whole, "Content-Type") + 5,
		"cut inside the file":             strings.Index(whole, `"description"`),
	} {
		t.Run(name, func(t *testing.T) {
			rec, dir := do(t, mw.FormDataContentType(), whole[:cut])
			assert.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			assert.Contains(t, rec.Body.String(), "could not be read", "the reason is the upload, not a missing file")
			assert.Empty(t, stored(dir), "a cut upload stores nothing")
		})
	}
	t.Run("not a multipart body", func(t *testing.T) {
		rec, dir := do(t, "multipart/form-data; boundary=x", "this is not multipart")
		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "could not be read")
		assert.Empty(t, stored(dir))
	})
	t.Run("a boundary that is missing", func(t *testing.T) {
		rec, dir := do(t, "multipart/form-data", whole)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "could not be read")
		assert.Empty(t, stored(dir))
	})
}
