package heavy

import (
	"archive/tar"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13750, Security's MUST 2 on the receiving side: the wrapper extracts with its own checks. It rejects names that leave the folder, devices, hard links and links out, clears setuid and ownership, and stops at its caps.

type ent struct {
	name, body, link string
	typ              byte
	mode             int64
}

func mkTar(t *testing.T, es ...ent) io.Reader {
	t.Helper()
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	for _, e := range es {
		h := &tar.Header{Name: e.name, Mode: e.mode, Typeflag: e.typ, Linkname: e.link, Size: int64(len(e.body)), Uid: 0, Gid: 0}
		if e.typ == 0 {
			h.Typeflag = tar.TypeReg
		}
		if h.Typeflag != tar.TypeReg {
			h.Size = 0
		}
		require.NoError(t, tw.WriteHeader(h))
		if h.Typeflag == tar.TypeReg {
			_, err := tw.Write([]byte(e.body))
			require.NoError(t, err)
		}
	}
	require.NoError(t, tw.Close())
	return &b
}

func TestExtractWritesFilesAndFoldersAndClearsSpecialBits(t *testing.T) {
	dir := t.TempDir()
	n, err := Extract(dir, mkTar(t,
		ent{name: "a/b/c.txt", body: "hello", mode: 0o4755}, // setuid asked for
		ent{name: "run.sh", body: "#!/bin/sh\n", mode: 0o755},
		ent{name: "d/", typ: tar.TypeDir, mode: 0o777},
	), Limits{Files: 100, Bytes: 1 << 20})
	require.NoError(t, err)
	assert.Equal(t, 2, n.Files)
	got, err := os.ReadFile(filepath.Join(dir, "a/b/c.txt"))
	require.NoError(t, err)
	assert.Equal(t, "hello", string(got))
	fi, _ := os.Stat(filepath.Join(dir, "a/b/c.txt"))
	assert.Zero(t, fi.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky), "no setuid, setgid or sticky bit")
	assert.Equal(t, os.FileMode(0o700), fi.Mode().Perm(), "the owner-execute bit was on in the archive: 0700")
	fx, _ := os.Stat(filepath.Join(dir, "run.sh"))
	assert.Equal(t, os.FileMode(0o700), fx.Mode().Perm())
	require.NoError(t, os.WriteFile(filepath.Join(dir, "x"), nil, 0o600))
	_, err = Extract(t.TempDir(), mkTar(t, ent{name: "plain.txt", body: "p", mode: 0o666}), Limits{Files: 10, Bytes: 100})
	require.NoError(t, err)
	d2 := t.TempDir()
	_, err = Extract(d2, mkTar(t, ent{name: "plain.txt", body: "p", mode: 0o666}, ent{name: "dir/", typ: tar.TypeDir, mode: 0o777}), Limits{Files: 10, Bytes: 100})
	require.NoError(t, err)
	fp, _ := os.Stat(filepath.Join(d2, "plain.txt"))
	assert.Equal(t, os.FileMode(0o600), fp.Mode().Perm(), "no owner-execute: 0600, whatever the group and world bits were")
	fd, _ := os.Stat(filepath.Join(d2, "dir"))
	assert.Equal(t, os.FileMode(0o700), fd.Mode().Perm(), "folders are 0700")
}

func TestExtractRefusesNamesThatLeaveTheFolderAndEverythingNotAFileOrFolder(t *testing.T) {
	for name, e := range map[string]ent{
		"dotdot":        {name: "../escape", body: "x", mode: 0o644},
		"dotdot inside": {name: "a/../../escape", body: "x", mode: 0o644},
		"absolute":      {name: "/etc/passwd", body: "x", mode: 0o644},
		"empty":         {name: "", body: "x", mode: 0o644},
		"hard link":     {name: "h", typ: tar.TypeLink, link: "a", mode: 0o644},
		"device":        {name: "dev", typ: tar.TypeChar, mode: 0o644},
		"fifo":          {name: "fifo", typ: tar.TypeFifo, mode: 0o644},
		"git":           {name: ".git/config", body: "x", mode: 0o644},
		"git deep":      {name: "a/.git/hooks/pre-commit", body: "x", mode: 0o755},
		"backslash":     {name: "a\\b", body: "x", mode: 0o644},
		"socket-ish":    {name: "s", typ: tar.TypeBlock, mode: 0o644},
	} {
		dir := t.TempDir()
		_, err := Extract(dir, mkTar(t, e), Limits{Files: 100, Bytes: 1 << 20})
		assert.ErrorIs(t, err, ErrUnsafe, name)
		entries, _ := os.ReadDir(filepath.Dir(dir))
		for _, en := range entries {
			assert.NotEqual(t, "escape", en.Name(), name)
		}
	}
}

func TestExtractKeepsLinksInsideTheFolderAndRefusesThoseThatLeaveIt(t *testing.T) {
	dir := t.TempDir()
	_, err := Extract(dir, mkTar(t,
		ent{name: "real.txt", body: "data", mode: 0o644},
		ent{name: "inside", typ: tar.TypeSymlink, link: "real.txt", mode: 0o777},
		ent{name: "sub/up", typ: tar.TypeSymlink, link: "../real.txt", mode: 0o777},
	), Limits{Files: 100, Bytes: 1 << 20})
	require.NoError(t, err)
	got, err := os.ReadFile(filepath.Join(dir, "inside"))
	require.NoError(t, err)
	assert.Equal(t, "data", string(got))
	for name, link := range map[string]string{"out": "../../etc/passwd", "abs": "/etc/passwd", "deep": "a/../../../x"} {
		d := t.TempDir()
		_, err := Extract(d, mkTar(t, ent{name: name, typ: tar.TypeSymlink, link: link, mode: 0o777}), Limits{Files: 100, Bytes: 1 << 20})
		assert.ErrorIs(t, err, ErrUnsafe, name)
	}
}

func TestExtractNeverWritesThroughALinkAndRefusesNamesThatCollideByCase(t *testing.T) {
	// an archive can hold a link "a" and then a file "a/x": links are only made after every file, so "a/x" is a plain folder entry and the link then finds its name taken
	dir := t.TempDir()
	_, err := Extract(dir, mkTar(t,
		ent{name: "lnk", typ: tar.TypeSymlink, link: "real", mode: 0o777},
		ent{name: "real/", typ: tar.TypeDir, mode: 0o755},
		ent{name: "lnk/f.txt", body: "x", mode: 0o644},
	), Limits{Files: 100, Bytes: 1 << 20})
	assert.ErrorIs(t, err, ErrUnsafe, "a link and a folder of the same name: refused")
	entries, _ := os.ReadDir(filepath.Dir(dir))
	for _, e := range entries {
		assert.NotEqual(t, "f.txt", e.Name())
	}
	// a macOS volume is case-insensitive: "a" and "A" are one name
	_, err = Extract(t.TempDir(), mkTar(t, ent{name: "a", body: "1", mode: 0o644}, ent{name: "A", body: "2", mode: 0o644}), Limits{Files: 100, Bytes: 1 << 20})
	assert.ErrorIs(t, err, ErrUnsafe, "names that differ only by case collide")
	_, err = Extract(t.TempDir(), mkTar(t, ent{name: "d/x", body: "1", mode: 0o644}, ent{name: "D/y", body: "2", mode: 0o644}), Limits{Files: 100, Bytes: 1 << 20})
	assert.ErrorIs(t, err, ErrUnsafe, "and so do their folders")
}

func TestExtractStopsAtItsCaps(t *testing.T) {
	_, err := Extract(t.TempDir(), mkTar(t, ent{name: "a", body: "1", mode: 0o644}, ent{name: "b", body: "2", mode: 0o644}, ent{name: "c", body: "3", mode: 0o644}), Limits{Files: 2, Bytes: 1 << 20})
	assert.ErrorIs(t, err, ErrTooBig, "more files than the cap")
	_, err = Extract(t.TempDir(), mkTar(t, ent{name: "a", body: "0123456789", mode: 0o644}), Limits{Files: 100, Bytes: 5})
	assert.ErrorIs(t, err, ErrTooBig, "more bytes than the cap")
}

func TestCleanNameRefusesWhatAnArchiveWriterCannotEvenEncode(t *testing.T) {
	for _, bad := range []string{"a\x00b", "", "/abs", "a/../b", "./a", "a//b", "a\\b", ".git", "x/.GIT/y", "..", "a/./b"} {
		_, err := cleanName(bad)
		assert.ErrorIs(t, err, ErrUnsafe, "%q", bad)
	}
	n, err := cleanName("dir/sub/file.txt")
	require.NoError(t, err)
	assert.Equal(t, "dir/sub/file.txt", n)
	require.Error(t, linkTarget("a", "/etc"))
	require.Error(t, linkTarget("a/b", "../../x"))
	require.NoError(t, linkTarget("a/b", "../c"))
}

func TestExtractCountsEveryEntryAgainstTheFileCapNotOnlyRegularFiles(t *testing.T) {
	var es []ent
	for i := 0; i < 20; i++ {
		es = append(es, ent{name: "d" + string(rune('a'+i)) + "/", typ: tar.TypeDir, mode: 0o755})
	}
	_, err := Extract(t.TempDir(), mkTar(t, es...), Limits{Files: 10, Bytes: 1 << 20})
	assert.ErrorIs(t, err, ErrTooBig, "twenty empty folders are twenty entries")
	var links []ent
	for i := 0; i < 20; i++ {
		links = append(links, ent{name: "l" + string(rune('a'+i)), typ: tar.TypeSymlink, link: "target", mode: 0o777})
	}
	_, err = Extract(t.TempDir(), mkTar(t, links...), Limits{Files: 10, Bytes: 1 << 20})
	assert.ErrorIs(t, err, ErrTooBig, "and so are twenty links")
	_, err = Extract(t.TempDir(), mkTar(t, es[:5]...), Limits{Files: 10, Bytes: 1 << 20})
	assert.NoError(t, err, "under the cap is fine")
}
