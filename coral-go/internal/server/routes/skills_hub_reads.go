package routes

import (
	"github.com/subgentic/coral/internal/cloud"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/skills"
)

// The Skills page through Coral Hub (#19627, coral-hub's Operator yes; the audit of #19626, section 4): GET /api/skills and GET /api/skills/{id} are the computer OWNER's alone, and a reply that came through the
// tunnel (the owner's too) is BUILT from an allow-list, field by field: a field added to the page's reply later is not on the Hub until it is named here. What crosses: a skill's name, version, description (cut,
// redacted), status, flags, file count and dates; its file list {path, size, kind, sha256}; and the text of its SKILL.md alone, redacted and cut at hubSkillMDMax. What stays on the computer: the text of every other file
// (scripts, references), the scanner's warnings and hosts (they quote script text and addresses), the digest, who published it, which team's agents use it. A request made on this computer keeps every field.

const (
	hubSkillMDMax       = 64 * 1024 // the SKILL.md text a Hub page is sent, in bytes
	hubSkillDescMax     = 300       // a description is text an agent wrote: cut for the list
	hubSkillRedactFails = "skill_md_withheld"
)

// cutBytes cuts s to at most n bytes without splitting a character, and says whether it cut.
func cutBytes(s string, n int) (string, bool) {
	if len(s) <= n {
		return s, false
	}
	s = s[:n]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s, true
}

// hubSkillRow is one skill row as the Hub gets it. The description is redacted first and cut after, so a cut can never leave the start of a secret behind.
func hubSkillRow(v skillRowView) map[string]any {
	desc, ok := redactComment(v.Description)
	if !ok {
		desc = "" // the redactor is unavailable: no free text goes out
	}
	if r := []rune(desc); len(r) > hubSkillDescMax {
		desc = string(r[:hubSkillDescMax])
	}
	name, ok := redactComment(v.Name)
	if !ok {
		name = "" // the redactor is unavailable: no free text goes out
	}
	return map[string]any{
		"id": v.ID, "name": name, "version": v.Version, "description": desc, "status": v.Status,
		"has_scripts": v.HasScripts, "not_reviewable": v.NotReviewable, "file_count": v.FileCount, "created_at": v.CreatedAt, "decided_at": v.DecidedAt,
	}
}

func hubSkillList(rows []skillRowView) map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, v := range rows {
		out = append(out, hubSkillRow(v))
	}
	return map[string]any{"skills": out}
}

// hubSkillPage is one skill's page as the Hub gets it: the row, the file list and the SKILL.md text. A removed skill has its row alone (sk is nil).
func hubSkillPage(v skillRowView, sk *skills.Skill) map[string]any {
	out := map[string]any{"skill": hubSkillRow(v)}
	if sk == nil {
		return out
	}
	files := make([]map[string]any, 0, len(sk.Files))
	mdPath := ""
	for _, f := range sk.Files {
		files = append(files, map[string]any{"path": f.Path, "size": f.Size, "kind": f.Kind, "sha256": f.SHA256})
		if mdPath == "" && f.Kind == skills.KindInstructions {
			mdPath = f.Path
		}
	}
	out["files"] = files
	text, ok := redactComment(strings.ToValidUTF8(string(sk.Content[mdPath]), "�"))
	if !ok {
		out[hubSkillRedactFails] = true // the redactor is unavailable: the text is not sent
		return out
	}
	text, cut := cutBytes(text, hubSkillMDMax) // cut after redacting: the end of a cut can never be the start of a secret
	out["skill_md"], out["skill_md_truncated"] = text, cut
	return out
}

// refuseSkillReadUnlessOwner is the first line of both reads: through the Hub only the owner (the table's one rule, as for the skills menu); on this computer nothing here applies.
func refuseSkillReadUnlessOwner(w http.ResponseWriter, r *http.Request) bool {
	return cloud.Tunneled(r) && refuseNonOwner(w, r)
}
