package skills

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io/fs"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type zf struct {
	name string
	body string
	mode fs.FileMode
}

func makeZip(t *testing.T, files ...zf) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, f := range files {
		h := &zip.FileHeader{Name: f.name, Method: zip.Deflate}
		if f.mode != 0 {
			h.SetMode(f.mode)
		}
		fw, err := w.CreateHeader(h)
		require.NoError(t, err)
		_, err = fw.Write([]byte(f.body))
		require.NoError(t, err)
	}
	require.NoError(t, w.Close())
	return buf.Bytes()
}

const goodMD = "---\nname: release-notes\ndescription: Writes release notes from merged PRs. Use when asked for a changelog.\nlicense: MIT\nmetadata:\n  tags: \"release, changelog\"\n  author: Operator\n---\n# Release notes\n1. List the PRs.\n"

func TestParseReadsAGoodSkillAtTheTopOrInItsFolder(t *testing.T) {
	for name, files := range map[string][]zf{
		"top":    {{name: "SKILL.md", body: goodMD}, {name: "references/pg.md", body: "text"}},
		"folder": {{name: "release-notes/SKILL.md", body: goodMD}, {name: "release-notes/references/pg.md", body: "text"}},
	} {
		sk, err := Parse(makeZip(t, files...))
		require.NoError(t, err, name)
		assert.Equal(t, "release-notes", sk.Name)
		assert.Equal(t, "MIT", sk.License)
		assert.Equal(t, []string{"release", "changelog"}, sk.Tags())
		assert.Equal(t, "# Release notes\n1. List the PRs.\n", sk.Body)
		require.Len(t, sk.Files, 2)
		assert.Equal(t, "SKILL.md", sk.Files[0].Path, "files are listed by path, each below the skill's folder")
		assert.Equal(t, KindInstructions, sk.Files[0].Kind)
		assert.Equal(t, "references/pg.md", sk.Files[1].Path)
		assert.Equal(t, KindText, sk.Files[1].Kind)
		assert.Len(t, sk.Files[0].SHA256, 64)
	}
}

func TestParseTellsScriptsAndFilesThatCannotBeShownAsText(t *testing.T) {
	sk, err := Parse(makeZip(t,
		zf{name: "SKILL.md", body: goodMD},
		zf{name: "scripts/check.py", body: "print(1)"},
		zf{name: "tools/run", body: "#!/bin/sh\necho hi\n"},
		zf{name: "tools/exec.txt", body: "plain but executable", mode: 0o755},
		zf{name: "lint.sh", body: "echo"},
		zf{name: "assets/logo.png", body: "\x89PNG\r\n\x1a\n\x00\x00binary"},
		zf{name: "notes.md", body: "just notes"},
	))
	require.NoError(t, err)
	kinds := map[string]Kind{}
	for _, f := range sk.Files {
		kinds[f.Path] = f.Kind
	}
	assert.Equal(t, KindScript, kinds["scripts/check.py"])
	assert.Equal(t, KindScript, kinds["tools/run"], "a shebang makes it a script wherever it is")
	assert.Equal(t, KindScript, kinds["tools/exec.txt"], "an executable file is a script")
	assert.Equal(t, KindScript, kinds["lint.sh"])
	assert.Equal(t, KindNotReviewable, kinds["assets/logo.png"])
	assert.Equal(t, KindText, kinds["notes.md"])
	assert.Equal(t, 4, sk.Scripts())
	assert.Equal(t, 1, sk.NotReviewable())
}

func TestParseRefusesUnsafeArchives(t *testing.T) {
	big := strings.Repeat("a", 100)
	many := []zf{{name: "SKILL.md", body: goodMD}}
	for i := 0; i < MaxFiles; i++ {
		many = append(many, zf{name: fmt.Sprintf("references/r%03d.md", i), body: "x"})
	}
	var bomb []zf
	bomb = append(bomb, zf{name: "SKILL.md", body: goodMD})
	for i := 0; i < 25; i++ {
		bomb = append(bomb, zf{name: fmt.Sprintf("references/z%02d.txt", i), body: strings.Repeat("0", MaxFileBytes)})
	}
	for name, c := range map[string]struct {
		data []byte
		want string
	}{
		"symlink":             {makeZip(t, zf{name: "SKILL.md", body: goodMD}, zf{name: "evil", body: "/etc/passwd", mode: fs.ModeSymlink | 0o777}), "link or special"},
		"absolute":            {makeZip(t, zf{name: "SKILL.md", body: goodMD}, zf{name: "/etc/x", body: big}), "not allowed"},
		"dotdot":              {makeZip(t, zf{name: "SKILL.md", body: goodMD}, zf{name: "a/../../x", body: big}), "leaves the folder"},
		"backslash":           {makeZip(t, zf{name: "SKILL.md", body: goodMD}, zf{name: `a\b`, body: big}), "not allowed"},
		"hidden":              {makeZip(t, zf{name: "SKILL.md", body: goodMD}, zf{name: ".env", body: "K=v"}), "hidden"},
		"hidden folder":       {makeZip(t, zf{name: "SKILL.md", body: goodMD}, zf{name: ".git/config", body: "x"}), "hidden"},
		"duplicate":           {makeZip(t, zf{name: "SKILL.md", body: goodMD}, zf{name: "a.md", body: "1"}, zf{name: "a.md", body: "2"}), "same name"},
		"case collision":      {makeZip(t, zf{name: "SKILL.md", body: goodMD}, zf{name: "Notes.md", body: "1"}, zf{name: "notes.md", body: "2"}), "same name"},
		"reordering char":     {makeZip(t, zf{name: "SKILL.md", body: goodMD}, zf{name: "a\u202eb.md", body: "1"}), "not allowed"},
		"too many files":      {makeZip(t, many...), "too many files"},
		"file over its limit": {makeZip(t, zf{name: "SKILL.md", body: goodMD}, zf{name: "references/big.txt", body: strings.Repeat("0", MaxFileBytes+1)}), "over its size limit"},
		"SKILL.md too big":    {makeZip(t, zf{name: "SKILL.md", body: goodMD + strings.Repeat("x", MaxSkillMDBytes)}), "over its size limit"},
		"zip bomb":            {makeZip(t, bomb...), "together"},
		"no SKILL.md":         {makeZip(t, zf{name: "README.md", body: "hi"}), "SKILL.md"},
		"two folders":         {makeZip(t, zf{name: "a/SKILL.md", body: goodMD}, zf{name: "b/x.md", body: "1"}), "inside one folder"},
		"folder name differs": {makeZip(t, zf{name: "other/SKILL.md", body: goodMD}), "folder is named"},
		"not a zip":           {[]byte("PK nope"), "not a zip"},
		"empty":               {nil, "between 1 byte"},
	} {
		_, err := Parse(c.data)
		require.Error(t, err, name)
		assert.ErrorIs(t, err, ErrInvalid, name)
		assert.Contains(t, err.Error(), c.want, name)
	}
}

func TestParseNeverOpensANestedArchive(t *testing.T) {
	inner := makeZip(t, zf{name: "x/../../escape", body: "boom"}, zf{name: "SKILL.md", body: "no"})
	sk, err := Parse(makeZip(t, zf{name: "SKILL.md", body: goodMD}, zf{name: "assets/inner.zip", body: string(inner)}))
	require.NoError(t, err, "a nested archive is stored as bytes, whatever is inside it")
	for _, f := range sk.Files {
		if f.Path == "assets/inner.zip" {
			assert.Equal(t, KindNotReviewable, f.Kind)
		}
	}
}

func TestParseFrontMatterIsStrict(t *testing.T) {
	md := func(front string) []byte {
		return makeZip(t, zf{name: "SKILL.md", body: "---\n" + front + "\n---\nbody\n"})
	}
	long := strings.Repeat("d", MaxDescriptionLen+1)
	for name, c := range map[string]struct{ front, want string }{
		"anchor":               {"name: ok\ndescription: &a hello", "anchors or aliases"},
		"alias":                {"name: ok\nbase: &b hello\ndescription: *b", "anchors or aliases"},
		"tag":                  {"name: ok\ndescription: !!binary aGVsbG8=", "tags"},
		"too deep":             {"name: ok\ndescription: d\nmetadata:\n  a:\n    b:\n      c:\n        d:\n          e: f", "nested too deeply"},
		"duplicate key":        {"name: ok\nname: other\ndescription: d", "repeats the key"},
		"no name":              {"description: d", "no name"},
		"no description":       {"name: ok", "no description"},
		"empty description":    {"name: ok\ndescription: ''", "empty"},
		"description too long": {"name: ok\ndescription: " + long, "over 1024"},
		"bad name":             {"name: Bad_Name\ndescription: d", "lower case"},
		"double hyphen":        {"name: a--b\ndescription: d", "lower case"},
		"name too long":        {"name: " + strings.Repeat("a", 65) + "\ndescription: d", "over 64"},
		"name is a list":       {"name: [a, b]\ndescription: d", "must be text"},
		"metadata not text":    {"name: ok\ndescription: d\nmetadata:\n  a: [1, 2]", "text to text"},
		"metadata not a map":   {"name: ok\ndescription: d\nmetadata: nope", "short mapping"},
		"not a mapping":        {"- a\n- b", "not a YAML mapping"},
		"control character":    {"name: ok\ndescription: \"bad\\u202ething\"", "control character"},
		"compat too long":      {"name: ok\ndescription: d\ncompatibility: " + strings.Repeat("c", 501), "over 500"},
	} {
		_, err := Parse(md(c.front))
		require.Error(t, err, name)
		assert.Contains(t, err.Error(), c.want, name)
	}
	_, err := Parse(makeZip(t, zf{name: "SKILL.md", body: "no front matter\n"}))
	assert.ErrorContains(t, err, "must start with")
	_, err = Parse(makeZip(t, zf{name: "SKILL.md", body: "---\nname: ok\ndescription: d\n"}))
	assert.ErrorContains(t, err, "not closed")
	// Claude's and Hermes's extra keys are accepted and ignored, as the other agents do
	sk, err := Parse(md("name: ok\ndescription: d\nwhen_to_use: now\ndisable-model-invocation: true\nallowed-tools: Bash"))
	require.NoError(t, err)
	assert.Equal(t, "Bash", sk.AllowedTools)
}
