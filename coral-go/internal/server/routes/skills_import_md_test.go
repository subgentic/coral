package routes

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// A lone SKILL.md is a whole skill (#12678): the Operator's import wraps it as a one-file zip, and every check of a zip applies to it.

func mdBody(t *testing.T, md string) string {
	b, err := json.Marshal(map[string]any{"skill_md_base64": base64.StdEncoding.EncodeToString([]byte(md))})
	require.NoError(t, err)
	return string(b)
}

func TestALoneSkillMDImportsAsAWholeSkillLikeAZip(t *testing.T) {
	e := newSkillsEnv(t)
	code, out := e.call("POST", "/api/skills", mdBody(t, skillMD), "operator")
	require.Equal(t, 200, code, out)
	assert.Equal(t, "release-notes", out["name"])

	code, out = e.call("GET", "/api/skills", "", "operator")
	require.Equal(t, 200, code)
	list := out["skills"].([]any)
	require.Len(t, list, 1)
	row := list[0].(map[string]any)
	assert.Equal(t, "release-notes", row["name"])
	assert.Equal(t, "approved", row["status"], "the Operator's own import is approved at once, as a zip is")
	assert.EqualValues(t, 1, row["file_count"])
	code, out = e.call("GET", "/api/skills/"+row["id"].(string), "", "operator")
	require.Equal(t, 200, code)
	assert.Contains(t, out["contents"].(map[string]any), "SKILL.md")

	// The same text as a zip is the same skill: the same bytes, so the same digest.
	e2 := newSkillsEnv(t)
	code, out2 := e2.call("POST", "/api/skills", zipBody(t, map[string]string{"SKILL.md": skillMD}, false), "operator")
	require.Equal(t, 200, code, out2)
	w, err := zipOfSkillMD([]byte(skillMD))
	require.NoError(t, err)
	assert.Equal(t, zipOf(t, map[string]string{"SKILL.md": skillMD})[:4], w[:4], "a zip")
	assert.Equal(t, out["skill"].(map[string]any)["digest"], row["digest"])
}

func TestAMarkdownFileThatIsNotASkillIsRefusedWithTheReasonAndKeepsNothing(t *testing.T) {
	e := newSkillsEnv(t)
	for name, md := range map[string]string{
		"no front matter":     "# Just notes\nNo front matter here.\n",
		"no description":      "---\nname: only-name\n---\nBody\n",
		"no name":             "---\ndescription: Only a description.\n---\nBody\n",
		"a hidden character":  "---\nname: tricky\ndescription: Looks fine‮.\n---\nBody\n",
		"a key inside":        "---\nname: leaky\ndescription: Holds a key.\n---\nAKIAIOSFODNN7EXAMPLE and ghp_abcdefghijklmnopqrstuvwxyz0123456789 are in here.\n",
		"over the size limit": "---\nname: huge\ndescription: Too big.\n---\n" + strings.Repeat("x", 6<<20),
	} {
		code, out := e.call("POST", "/api/skills", mdBody(t, md), "operator")
		assert.GreaterOrEqual(t, code, 400, name)
		assert.NotEmpty(t, out["error"], name+": a plain reason")
	}
	list, err := e.ss.ListSkills(t.Context(), "")
	require.NoError(t, err)
	assert.Empty(t, list, "a refused file leaves no skill")
	for name, body := range map[string]string{"empty": `{"skill_md_base64":""}`, "bad base64": `{"skill_md_base64":"!!!"}`, "both": `{"zip_base64":"AAAA","skill_md_base64":"AAAA"}`} {
		code, _ := e.call("POST", "/api/skills", body, "operator")
		assert.Equal(t, 400, code, name)
	}
}

func TestAZipStillImportsAndAnAgentStillPublishesOnlyAZip(t *testing.T) {
	e := newSkillsEnv(t)
	code, out := e.call("POST", "/api/skills", zipBody(t, map[string]string{"SKILL.md": skillMD, "references/a.md": "notes"}, false), "operator")
	require.Equal(t, 200, code, out)
	assert.Equal(t, "release-notes", out["name"])

	// An agent's publish takes a zip only: a lone SKILL.md is the Operator's import.
	e2 := newSkillsEnv(t)
	code, _ = e2.call("POST", "/api/agent/skills", mdBody(t, skillMD), "agent")
	assert.Equal(t, 400, code)
	list, _ := e2.ss.ListSkills(t.Context(), "")
	assert.Empty(t, list)
	_ = store.PublisherOperator
}

// The same text is always the same skill (Security's INFO 4): the wrapper is stored, not compressed, so no compressor's output (another Go version's deflate) can change the bytes or the digest.
func TestTheWrappedSkillMDIsStoredNotCompressedSoItsDigestIsStable(t *testing.T) {
	a, err := zipOfSkillMD([]byte(skillMD))
	require.NoError(t, err)
	b, err := zipOfSkillMD([]byte(skillMD))
	require.NoError(t, err)
	assert.Equal(t, a, b, "the same text, the same bytes")
	zr, err := zip.NewReader(bytes.NewReader(a), int64(len(a)))
	require.NoError(t, err)
	require.Len(t, zr.File, 1)
	assert.Equal(t, "SKILL.md", zr.File[0].Name)
	assert.Equal(t, zip.Store, zr.File[0].Method, "stored")

	e1, e2 := newSkillsEnv(t), newSkillsEnv(t)
	_, o1 := e1.call("POST", "/api/skills", mdBody(t, skillMD), "operator")
	_, o2 := e2.call("POST", "/api/skills", mdBody(t, skillMD), "operator")
	r1, _ := e1.ss.ListSkills(t.Context(), "")
	r2, _ := e2.ss.ListSkills(t.Context(), "")
	require.Len(t, r1, 1)
	require.Len(t, r2, 1)
	assert.Equal(t, r1[0].Digest, r2[0].Digest, "two imports of one text, one digest: %v %v", o1, o2)
}
