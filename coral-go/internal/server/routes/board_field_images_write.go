package routes

import (
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// The writes that carry the pictures of #20731's upload routes (goal #285). A write names them as
//
//	"images": {"<field>": ["<hex>", ...]}, "images_draft": "<the draft id the uploads were made with>"
//
// per field: a field that is present REPLACES that field's pictures, [] clears it, an omitted field is left as it is; at most 4 per field. They are the Operator's alone (operatorOnly, as the upload),
// and a picture is accepted when it was uploaded for this team, this scope and this draft in the last 24 hours (fieldImageTTL, kept in this process's memory) or is already on the record (an edit
// that keeps a picture names it again). Anything else is 400 picture_not_yours.

// fieldImageTTL is how long an uploaded picture can be named by a write: the upload's memory keeps it for as long.
const fieldImageTTL = 24 * time.Hour

const fieldImageMemoryCap = 4096

// recentFieldImages remembers what the Operator uploaded in this run for a field scope, so a write can name only pictures that were uploaded for it.
var recentFieldImages = struct {
	sync.Mutex
	m map[string]time.Time
}{m: map[string]time.Time{}}

func rememberFieldImage(scope, hexID string, now time.Time) {
	recentFieldImages.Lock()
	defer recentFieldImages.Unlock()
	for k, at := range recentFieldImages.m {
		if now.Sub(at) > fieldImageTTL {
			delete(recentFieldImages.m, k)
		}
	}
	for len(recentFieldImages.m) >= fieldImageMemoryCap { // the oldest goes first
		var oldK string
		var oldAt time.Time
		for k, at := range recentFieldImages.m {
			if oldK == "" || at.Before(oldAt) {
				oldK, oldAt = k, at
			}
		}
		delete(recentFieldImages.m, oldK)
	}
	recentFieldImages.m[commentImageKey(scope, hexID)] = now
}

func recentFieldImage(scope, hexID string, now time.Time) bool {
	recentFieldImages.Lock()
	defer recentFieldImages.Unlock()
	at, ok := recentFieldImages.m[commentImageKey(scope, hexID)]
	return ok && now.Sub(at) <= fieldImageTTL
}

// fieldImageRateKey is what the upload's rate limit counts under: the team and the field, not the draft (a client cannot get more uploads by changing the draft id).
func fieldImageRateKey(project, scope string) string { return "field-rate:" + project + ":" + scope }

// fieldPictures reads and checks the images of a write for the fields it allows. It answers the request itself when a picture is not allowed and then returns false. A write with no images field
// returns nil. record is what the record already holds (nil for a new one), so a picture on it can be named again.
func (h *BoardHandler) fieldPictures(w http.ResponseWriter, r *http.Request, project, scope, draft string, in map[string][]string, record map[string][]board.GoalImage, allowed ...string) (map[string][]board.GoalImage, bool) {
	if in == nil {
		return nil, true
	}
	if !operatorOnly(w, r) {
		return nil, false
	}
	if draft != "" && !fieldDraftRe.MatchString(draft) {
		errBadRequest(w, "images_draft must be 1 to 64 characters of a-z, 0-9 and -")
		return nil, false
	}
	have := map[string]board.GoalImage{}
	for _, imgs := range record {
		for _, im := range imgs {
			have[im.Hex] = im
		}
	}
	out := map[string][]board.GoalImage{}
	for field, hexes := range in {
		ok := false
		for _, a := range allowed {
			ok = ok || a == field
		}
		if !ok {
			writeError(w, http.StatusBadRequest, "picture_field_unknown", "pictures go with "+strings.Join(allowed, ", ")+", not "+field)
			return nil, false
		}
		if len(hexes) > maxCommentImages {
			writeError(w, http.StatusBadRequest, "too_many_pictures", "at most 4 pictures can be attached to a field")
			return nil, false
		}
		kept := []board.GoalImage{}
		seen := map[string]bool{}
		for _, raw := range hexes {
			hexID := strings.ToLower(strings.TrimSpace(raw))
			if !objectNameRe.MatchString(hexID) || seen[hexID] {
				writeError(w, http.StatusBadRequest, "picture_not_yours", "a picture was not added for this: add it again")
				return nil, false
			}
			seen[hexID] = true
			if im, onRecord := have[hexID]; onRecord {
				kept = append(kept, im)
				continue
			}
			if !recentFieldImage(fieldImageScope(project, scope, draft), hexID, time.Now()) {
				writeError(w, http.StatusBadRequest, "picture_not_yours", "a picture was not added for this: add it again")
				return nil, false
			}
			meta, found := readSidecar(filepath.Join(h.artifactObjectDir(), hexID+".json"))
			if !found {
				writeError(w, http.StatusBadRequest, "picture_not_yours", "a picture is gone: add it again")
				return nil, false
			}
			kept = append(kept, board.GoalImage{Hex: hexID, Name: meta.Name, ContentType: meta.MediaType})
		}
		out[field] = kept
	}
	return out, true
}

// pictureLines is the references an agent reads after the text of a field: one coral://artifacts/<hex> line per picture, never the bytes. The hash is checked, so the lines are safe data.
func pictureLines(imgs []board.GoalImage) string {
	var b strings.Builder
	for _, im := range imgs {
		b.WriteString("\ncoral://artifacts/" + im.Hex)
	}
	return b.String()
}

// recordedFieldImages reads what a record holds, for fieldPictures.
func (h *BoardHandler) recordedFieldImages(r *http.Request, project, kind, owner string) map[string][]board.GoalImage {
	m, _ := h.bs.FieldImages(r.Context(), project, kind, owner)
	return m
}
