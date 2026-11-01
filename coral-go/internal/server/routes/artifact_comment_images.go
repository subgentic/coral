package routes

// Pictures in a comment (#11650, goal #184 slice 1): a person writing a comment on an artifact can attach images. Each is uploaded first (POST /api/artifacts/{id}/comment-images, the raw file),
// stored as an artifact of the same team as the commented one, and named by its id in the comment's "images". The person's alone: an agent token, a viewer and a guest have no route to it.
//
// The server decides what a file is by its own bytes (PNG, JPEG or WebP magic), never by the declared type; a declared type that disagrees is refused, the sniffed type is what is stored, and the metadata
// a camera adds is removed as for any image (cleanUploadedImage). A comment names only pictures its caller uploaded a moment ago for that artifact (recentCommentImages), never an artifact picked from elsewhere.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/safefs"
)

const (
	maxCommentImageBytes = 25 << 20 // one picture
	maxCommentImages     = 4        // pictures in one comment
	commentImageTTL      = 30 * time.Minute
	sourceCommentImage   = "comment-image"
)

// commentImageLimitPerMinute is how many pictures a person can upload in a minute; a refused one counts.
var commentImageLimitPerMinute = 30

var commentImageLimit minuteLimiter

// commentImage is one picture of a comment as the client sees it, and as it is kept with the comment.
type commentImage struct {
	Hex         string `json:"hex"`
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
}

// recentCommentImages remembers what a person uploaded in this run, by artifact and picture, so a comment can only name pictures that were just stored for it here.
var recentCommentImages = struct {
	sync.Mutex
	m map[string]time.Time
}{m: map[string]time.Time{}}

func commentImageKey(artifactID, hexID string) string { return artifactID + "\x00" + hexID }

func rememberCommentImage(artifactID, hexID string, now time.Time) {
	recentCommentImages.Lock()
	defer recentCommentImages.Unlock()
	for k, at := range recentCommentImages.m {
		if now.Sub(at) > commentImageTTL {
			delete(recentCommentImages.m, k)
		}
	}
	for len(recentCommentImages.m) >= 256 { // the oldest goes first
		oldK, oldT := "", now
		for k, at := range recentCommentImages.m {
			if oldK == "" || at.Before(oldT) {
				oldK, oldT = k, at
			}
		}
		delete(recentCommentImages.m, oldK)
	}
	recentCommentImages.m[commentImageKey(artifactID, hexID)] = now
}

func recentCommentImage(artifactID, hexID string, now time.Time) bool {
	recentCommentImages.Lock()
	defer recentCommentImages.Unlock()
	at, ok := recentCommentImages.m[commentImageKey(artifactID, hexID)]
	return ok && now.Sub(at) <= commentImageTTL
}

// commentImageTypes are the pictures a comment takes, by sniffed type, with the extension a name gets when none is sent.
var commentImageTypes = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}

// commentImageTeam finds the session whose team the picture is stored for: a session that uploaded the commented artifact (so the picture is listed in that team's Artifacts and an agent of the team can read
// it), and that session's board (the query's board names it when the session is gone, and picks among several teams that hold the artifact).
func (h *SessionsHandler) commentImageTeam(artifactID, wantBoard string) (session, board string, ok bool) {
	coralDir := h.cfg.CoralDir()
	sessions, err := os.ReadDir(filepath.Join(coralDir, "artifacts", "uploads"))
	if err != nil {
		return "", "", false
	}
	for _, s := range sessions {
		if !s.IsDir() || !safefs.IsSafeID(s.Name()) {
			continue
		}
		if _, held := readUploadRecord(coralDir, s.Name(), artifactID); !held {
			continue
		}
		b, _, _ := uploaderOf(s.Name())
		if wantBoard != "" && b != "" && b != wantBoard {
			continue
		}
		if b == "" {
			b = wantBoard
		}
		if session == "" || (b != "" && board == "") {
			session, board = s.Name(), b
		}
		if board != "" {
			break
		}
	}
	return session, board, session != ""
}

// receivedPicture is a picture the server took from a request and checked: its bytes are in tmpPath (in the object folder, to be moved into the store), named by hexID.
type receivedPicture struct {
	tmpPath string
	hexID   string
	size    int64
	sniffed string
	name    string
}

// receivePicture reads one picture from a request and checks it, answering the request itself when it is refused: a declared type of png, jpeg or webp, a size within the cap (said before a byte is read when the length is known),
// a name of plain text, the bytes' own type (the sniffed one is what is kept; a declared type that disagrees is refused) and the metadata a camera adds removed. The caller removes tmpPath when it is done.
func receivePicture(w http.ResponseWriter, r *http.Request, coralDir string) (*receivedPicture, bool) {
	declared := strings.ToLower(strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0]))
	if _, known := commentImageTypes[declared]; !known {
		commentRefuse(w, http.StatusUnsupportedMediaType, "image_type", "Only PNG, JPEG and WebP pictures can go in a comment")
		return nil, false
	}
	if r.ContentLength > maxCommentImageBytes { // said before a byte is read
		commentRefuse(w, http.StatusRequestEntityTooLarge, "image_too_large", "A picture can be at most 25 MB")
		return nil, false
	}
	name := strings.TrimSpace(r.Header.Get("X-Artifact-Name"))
	if name != "" && (!board.ValidLabel(name, 160) || hasSignInLink(name)) {
		errBadRequest(w, "X-Artifact-Name must be 1–160 characters of plain text")
		return nil, false
	}
	if refuseIfDiskLow(w) {
		return nil, false
	}
	// The picture is read into memory (25 MB at most) and checked there; only a picture that passes is written to the object folder.
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCommentImageBytes+1))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) || len(data) > maxCommentImageBytes {
		commentRefuse(w, http.StatusRequestEntityTooLarge, "image_too_large", "A picture can be at most 25 MB")
		return nil, false
	}
	if err != nil || len(data) == 0 {
		errBadRequest(w, "the picture was cut short or empty")
		return nil, false
	}
	sniffed := sniffImageFamily(data)
	if _, known := commentImageTypes[sniffed]; !known {
		commentRefuse(w, http.StatusUnsupportedMediaType, "image_type", "Only PNG, JPEG and WebP pictures can go in a comment")
		return nil, false
	}
	if sniffed != declared {
		commentRefuse(w, http.StatusUnsupportedMediaType, "image_type_mismatch", "The file is not the type it was sent as")
		return nil, false
	}
	clean, changed, cerr := cleanUploadedImage(data)
	if cerr != nil {
		commentRefuse(w, http.StatusBadRequest, "image_metadata", cerr.Error())
		return nil, false
	}
	if changed {
		data = clean
	}
	dir := filepath.Join(coralDir, "artifacts", "objects")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		errInternalServer(w, "could not store the picture")
		return nil, false
	}
	tmp, err := os.CreateTemp(dir, artifactUploadTempP+"*")
	if err != nil {
		errInternalServer(w, "could not store the picture")
		return nil, false
	}
	tmpPath := tmp.Name()
	_, werr := tmp.Write(data)
	if cerr := tmp.Close(); werr != nil || cerr != nil {
		os.Remove(tmpPath)
		errInternalServer(w, "could not store the picture")
		return nil, false
	}
	sum := sha256.Sum256(data)
	if name == "" {
		name = "picture" + commentImageTypes[sniffed]
	}
	return &receivedPicture{tmpPath: tmpPath, hexID: hex.EncodeToString(sum[:]), size: int64(len(data)), sniffed: sniffed, name: name}, true
}

// uploadCommentImage stores one picture for a comment on an artifact: POST /api/artifacts/{id}/comment-images?board=&version_of=
// The body is the file; Content-Type is its declared type (png, jpeg or webp) and X-Artifact-Name an optional name. It answers {hex, name, content_type, size}; with version_of=<a picture just uploaded for this artifact>
// the new picture is the next version of that picture's series (the marked-up copy of a screenshot).
func (h *SessionsHandler) uploadCommentImage(w http.ResponseWriter, r *http.Request) {
	caller, ok := h.commentCallerFor(w, r, commentCreate)
	if !ok {
		return
	}
	if caller.Kind != commentCallerOwner || !humanInputCaller(r) {
		commentRefuse(w, http.StatusForbidden, "owner_only", "only the person at this computer can add a picture to a comment")
		return
	}
	id := chi.URLParam(r, "id")
	if !objectNameRe.MatchString(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	if !artifactReadable(r, h.cfg.CoralDir(), id) {
		errNotFound(w, "artifact not found")
		return
	}
	if !commentImageLimit.allow(id, commentImageLimitPerMinute, time.Now()) {
		httputil.WriteActionLimit(w, 60, "rate_limited", "too many pictures in a minute; try again shortly")
		return
	}
	coralDir := h.cfg.CoralDir()
	wantBoard := strings.TrimSpace(r.URL.Query().Get("board"))
	if wantBoard != "" && !commentBoardRe.MatchString(wantBoard) {
		errBadRequest(w, "invalid board")
		return
	}
	session, teamBoard, found := h.commentImageTeam(id, wantBoard)
	if !found {
		commentRefuse(w, http.StatusConflict, "no_team", "this file has no team to keep a picture with")
		return
	}
	versionOf := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("version_of")))
	if versionOf != "" && (!objectNameRe.MatchString(versionOf) || !recentCommentImage(id, versionOf, time.Now())) {
		commentRefuse(w, http.StatusNotFound, "series_not_found", "that is not a picture you just added to this comment")
		return
	}
	pic, ok := receivePicture(w, r, coralDir)
	if !ok {
		return
	}
	defer os.Remove(pic.tmpPath) // a no-op once it is in the store
	var plan *seriesPlan
	var stamp *seriesStamp
	if versionOf != "" {
		var err error
		if plan, err = planNewVersion(coralDir, versionOf, teamBoard, pic.hexID); err != nil {
			h.answerSeriesRefusal(w, coralDir, pic.hexID, err)
			return
		}
		defer plan.unlock()
		if plan.same != nil {
			h.answerExistingVersion(w, coralDir, plan, *plan.same)
			return
		}
		stamp = &plan.stamp
	}
	reply, ok := storeReceivedPicture(w, coralDir, session, pic, stamp, sourceCommentImage)
	if !ok {
		return
	}
	if plan != nil {
		versions, cerr := plan.commit(coralDir, pic.hexID, session)
		if cerr != nil {
			slog.Warn("[comment images] a new version was stored but its series could not be recorded", "series", plan.id, "error", cerr)
			errInternalServer(w, "the picture was stored but its series could not be recorded")
			return
		}
		reply["series_id"], reply["version"], reply["versions"] = plan.id, plan.stamp.Version, versions
	}
	rememberCommentImage(id, pic.hexID, time.Now())
	slog.Info("[comment images] stored", "surface", "local", "digest", pic.hexID) // which, never a name or a byte
	writeJSON(w, http.StatusCreated, reply)
}

// storeReceivedPicture puts a checked picture in the store as the Operator's upload for the team of session, with the record's source say what it is for, and answers what the route replies; it answers the request itself on a refusal.
func storeReceivedPicture(w http.ResponseWriter, coralDir, session string, pic *receivedPicture, stamp *seriesStamp, source string) (map[string]any, bool) {
	meta, _, err := storeArtifactFileAs(coralDir, session, pic.name, pic.sniffed, pic.tmpPath, pic.hexID, pic.size, stamp, 0, func(rec *agentUploadRecord) {
		rec.Uploader, rec.Role = board.OperatorName, "operator"
		rec.UploadedBy, rec.Source = "owner", source
	})
	if errors.Is(err, errStoreFull) {
		artifactRefusal(w, http.StatusRequestEntityTooLarge, "artifact_quota", "store", "the artifact store is full: delete old artifacts or raise the limit (Settings > Storage and cleanup)")
		return nil, false
	}
	if err != nil {
		errInternalServer(w, "could not store the picture")
		return nil, false
	}
	return map[string]any{"hex": pic.hexID, "uri": "coral://artifacts/" + pic.hexID, "name": meta.Name, "content_type": pic.sniffed, "size": meta.Size}, true
}

// checkedPictures checks the pictures a new comment or goal names: at most maxCommentImages, each one this person just uploaded for scope (an artifact id, or "goal:<team>"), once. It answers them as they are
// kept, with the stored name and type, or why one is not allowed.
func checkedPictures(objectDir, scope string, hexes []string) ([]commentImage, string) {
	if len(hexes) == 0 {
		return nil, ""
	}
	if len(hexes) > maxCommentImages {
		return nil, "at most 4 pictures can be attached"
	}
	seen := map[string]bool{}
	var out []commentImage
	for _, raw := range hexes {
		hexID := strings.ToLower(strings.TrimSpace(raw))
		if !objectNameRe.MatchString(hexID) || seen[hexID] || !recentCommentImage(scope, hexID, time.Now()) {
			return nil, "a picture was not added just now: add it again"
		}
		seen[hexID] = true
		meta, ok := readSidecar(filepath.Join(objectDir, hexID+".json"))
		if !ok {
			return nil, "a picture is gone: add it again"
		}
		out = append(out, commentImage{Hex: hexID, Name: meta.Name, ContentType: meta.MediaType})
	}
	return out, ""
}

// commentImagesOf is checkedPictures for a comment on artifactID, as the JSON kept with the comment.
func (h *SessionsHandler) commentImagesOf(artifactID string, hexes []string) (string, string) {
	imgs, why := checkedPictures(h.artifactDir(), artifactID, hexes)
	if why != "" || len(imgs) == 0 {
		return "", why
	}
	b, _ := json.Marshal(imgs)
	return string(b), ""
}

// parseCommentImages reads the pictures kept with a comment; none, or a value that does not parse, is no pictures.
func parseCommentImages(kept string) []commentImage {
	if kept == "" {
		return nil
	}
	var out []commentImage
	if json.Unmarshal([]byte(kept), &out) != nil {
		return nil
	}
	return out
}

// commentPictureLinks are the links an agent reads a comment's pictures by.
func commentPictureLinks(kept string) []string {
	var out []string
	for _, im := range parseCommentImages(kept) {
		if objectNameRe.MatchString(im.Hex) {
			out = append(out, "coral://artifacts/"+im.Hex)
		}
	}
	return out
}
