//go:build windows

package appdownload

import (
	"encoding/base64"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9894: a file the app saves carries the download mark a browser leaves, the Zone.Identifier stream with ZoneId=3 (the Internet), so SmartScreen and Office's Protected View treat it as downloaded.
// The stream is read back the way Windows reads it (the file's name, a colon, the stream's name), and the file's own content is untouched by it.
func TestSaveWritesTheZoneIdentifierStream(t *testing.T) {
	dir := t.TempDir()
	b64 := base64.StdEncoding.EncodeToString([]byte("hello"))
	path, err := Save(dir, "tool.exe", b64)
	require.NoError(t, err)

	mark, err := os.ReadFile(path + ":Zone.Identifier")
	require.NoError(t, err, "the file has a Zone.Identifier stream")
	assert.Equal(t, "[ZoneTransfer]\r\nZoneId=3\r\n", string(mark))
	assert.True(t, strings.Contains(string(mark), "ZoneId=3"))

	got, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, "hello", string(got), "the stream does not change the file's content")
	fi, err := os.Stat(path)
	require.NoError(t, err)
	assert.Equal(t, int64(5), fi.Size(), "the stream is not counted in the file's size")
}

// A second download of the same name is saved as "name (1)" and carries its own mark; the first one's stays.
func TestEveryDownloadCarriesItsOwnMark(t *testing.T) {
	dir := t.TempDir()
	b64 := base64.StdEncoding.EncodeToString([]byte("x"))
	first, err := Save(dir, "a.txt", b64)
	require.NoError(t, err)
	second, err := Save(dir, "a.txt", b64)
	require.NoError(t, err)
	require.NotEqual(t, first, second)
	for _, p := range []string{first, second} {
		mark, err := os.ReadFile(p + ":Zone.Identifier")
		require.NoError(t, err, p)
		assert.Contains(t, string(mark), "ZoneId=3", p)
	}
}
