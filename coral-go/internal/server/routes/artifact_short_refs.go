package routes

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/subgentic/coral/internal/cloud"
)

// Short artifact refs (#9841): agents wrote a link as coral://artifacts/b801aafb…f5f, which nothing can open. The server that stores a board text expands a short ref to the full 64-hex link when
// exactly one artifact the sender may read matches, and refuses the text, with the way to fix it, when none or several do: every client is covered, not only coral-board.
//
// Only a ref after the coral://artifacts/ scheme is read: 8 to 63 hex digits, then optionally an ellipsis (… or ...) and the hex digits the id ends with. A full link, a bare hex run and shorter
// hex are left alone.
var shortArtifactRefRe = regexp.MustCompile(`coral://artifacts/([0-9a-f]+)(?:(?:…|\.\.\.)([0-9a-f]+))?`)

const (
	shortRefMinPrefix  = 8
	maxShortRefsInText = 20 // more than a message could mean; the text is refused, not scanned without end
	shortRefListed     = 5  // the full ids an ambiguous ref names
)

// shortRefProblem is why a text with a short ref is refused: the code and the words, which say how to fix it.
type shortRefProblem struct {
	code, message string
}

// expandShortArtifactRefs returns text with every short ref replaced by its full link, or the problem that refuses the text.
func (h *BoardHandler) expandShortArtifactRefs(r *http.Request, text string) (string, *shortRefProblem) {
	if !strings.Contains(text, "coral://artifacts/") {
		return text, nil
	}
	type found struct {
		start, end     int
		prefix, suffix string
	}
	var refs []found
	for _, m := range shortArtifactRefRe.FindAllStringSubmatchIndex(text, -1) {
		prefix := text[m[2]:m[3]]
		suffix := ""
		if m[4] >= 0 {
			suffix = text[m[4]:m[5]]
		}
		if len(prefix) < shortRefMinPrefix || len(prefix) >= 64 {
			continue // too short to mean an artifact, or a full link
		}
		refs = append(refs, found{start: m[0], end: m[1], prefix: prefix, suffix: suffix})
	}
	if len(refs) == 0 {
		return text, nil
	}
	if len(refs) > maxShortRefsInText {
		return text, &shortRefProblem{"artifact_ref_too_many", fmt.Sprintf("this text has %d shortened artifact links (coral://artifacts/b801aafb…f5f), more than the %d allowed: post the full 64-character links", len(refs), maxShortRefsInText)}
	}
	resolved := map[string]string{}
	var out strings.Builder
	last := 0
	for _, f := range refs {
		key := f.prefix + "…" + f.suffix
		full, ok := resolved[key]
		if !ok {
			shown := "coral://artifacts/" + f.prefix
			if f.suffix != "" {
				shown += "…" + f.suffix
			}
			ids := h.shortRefCandidates(r, f.prefix, f.suffix)
			switch len(ids) {
			case 0:
				return text, &shortRefProblem{"artifact_ref_unknown", shown + " is a shortened artifact link and matches no artifact you can read: post the full 64-character link (coral-agent artifact list shows the artifacts you can read)"}
			case 1:
				full = "coral://artifacts/" + ids[0]
			default:
				listed := ids
				if len(listed) > shortRefListed {
					listed = listed[:shortRefListed]
				}
				more := ""
				if len(ids) > len(listed) {
					more = fmt.Sprintf(" (and %d more)", len(ids)-len(listed))
				}
				return text, &shortRefProblem{"artifact_ref_ambiguous", fmt.Sprintf("%s is a shortened artifact link and matches %d artifacts you can read: %s%s. Add more characters of the id, or post the full 64-character link", shown, len(ids), strings.Join(listed, ", "), more)}
			}
			resolved[key] = full
		}
		out.WriteString(text[last:f.start])
		out.WriteString(full)
		last = f.end
	}
	out.WriteString(text[last:])
	return out.String(), nil
}

// shortRefCandidates are the stored artifacts whose id starts with prefix and ends with suffix and that the sender of r may read (artifactReadable, the one read check: the machine owner, the
// dashboard and the signed command line see all; an agent sees what its team's owner owns; through Coral Hub only the owner sees any). Sorted, so a refusal names them the same way twice.
func (h *BoardHandler) shortRefCandidates(r *http.Request, prefix, suffix string) []string {
	return shortRefCandidates(r, h.coralDir, prefix, suffix)
}

func shortRefCandidates(r *http.Request, coralDir, prefix, suffix string) []string {
	if coralDir == "" {
		return nil
	}
	files, err := os.ReadDir(filepath.Join(coralDir, "artifacts", "objects"))
	if err != nil {
		return nil
	}
	var ids []string
	for _, f := range files {
		name := f.Name()
		if !objectNameRe.MatchString(name) || !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) {
			continue
		}
		if cloud.Tunneled(r) {
			if !hubOwnerRequest(r).owner {
				return nil // a Hub member who is not the owner reads no artifact here, so none is theirs to name
			}
		} else if !artifactReadable(r, coralDir, name) {
			continue
		}
		ids = append(ids, name)
	}
	sort.Strings(ids)
	return ids
}

// refuseShortArtifactRefs expands the short refs of *text in place; on a problem it writes the refusal (400, nothing stored) and returns true.
func (h *BoardHandler) refuseShortArtifactRefs(w http.ResponseWriter, r *http.Request, text *string) bool {
	out, problem := h.expandShortArtifactRefs(r, *text)
	if problem == nil {
		*text = out
		return false
	}
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": problem.message, "message": problem.message, "code": problem.code, "not_sent": true})
	return true
}

// resolveArtifactRefs: GET /api/artifacts/resolve?link=b801aafb…f5f (link repeatable, at most 20) tells the dashboard which artifact a short ref in an old message means (#9841): for each ref
// {"ref", "id", "matches"}, id only when exactly one artifact the caller may read matches. The Operator's (the dashboard), and through Coral Hub the owner's, like the artifact reads.
func (h *SessionsHandler) resolveArtifactRefs(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) {
		if refuseNonOwner(w, r) {
			return
		}
	} else if refuseNonOperator(w, r, "resolve an artifact link") {
		return
	}
	refs := r.URL.Query()["link"]
	if len(refs) == 0 || len(refs) > maxShortRefsInText {
		errBadRequest(w, fmt.Sprintf("link is required, at most %d times", maxShortRefsInText))
		return
	}
	type answer struct {
		Ref     string  `json:"ref"`
		ID      *string `json:"id"`
		Matches int     `json:"matches"`
	}
	out := make([]answer, 0, len(refs))
	for _, ref := range refs {
		m := shortArtifactRefRe.FindStringSubmatch("coral://artifacts/" + strings.TrimPrefix(ref, "coral://artifacts/"))
		if m == nil || m[0] != "coral://artifacts/"+strings.TrimPrefix(ref, "coral://artifacts/") || len(m[1]) < shortRefMinPrefix || len(m[1]) >= 64 {
			errBadRequest(w, "link is 8 to 63 hex digits of an artifact id, optionally … and the end of it")
			return
		}
		ids := shortRefCandidates(r, h.cfg.CoralDir(), m[1], m[2])
		a := answer{Ref: ref, Matches: len(ids)}
		if len(ids) == 1 {
			a.ID = &ids[0]
		}
		out = append(out, a)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"refs": out})
}
