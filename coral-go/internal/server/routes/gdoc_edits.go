package routes

// Share to Google Docs, slice E of #20010 (#20047): an edit made in the shared Doc comes back into Coral by itself, as the Dropbox edits do (dropbox_edit_decide.go): the sync
// loop reads the Doc when its revision is not the one Coral recorded at its last sync, turns it into Markdown (gdocsync Pull, #20013) and stores it as the next version of the
// file's series. When the file also has a newer version in Coral the Google edit is kept as its own file next to it, and the loop's own keep-both (pushGdoc) keeps the Doc as it
// is and sends the new version to a new Doc: nothing of either side is lost, and nothing is overwritten. The text from the Doc is what anyone with access to the Doc wrote, so
// the version never names the Operator or an agent as its writer, is capped, and is taken at most gdocWritesPerHour times an hour for one file.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/gdocsync"
	"github.com/subgentic/coral/internal/store"
)

const (
	sourceGdocEdit     = "gdoc_edit"                     // a version made from an edit in a Google Doc, taken by the sync loop
	gdocEditUploadedBy = "google"                        // the record\'s uploaded_by: a fixed value that is never "owner" (which the list shows as the Operator), as Dropbox\'s is "dropbox"
	gdocEditUploader   = "unknown writer in Google Docs" // never the owner: anyone with access to the Doc could have written it
	gdocSeparateTail   = " (edited in Google)"
)

var (
	errGdocNoTeam   = errors.New("gdoc: the file belongs to no team")
	gdocCoralHeader = regexp.MustCompile(`\A\s*Written (?:by [^\n]{1,200} )?in Coral\.(?:\n\s*\n|\n|\z)`)
)

// gdocBody is the Doc's text without the line Coral puts at the top ("Written by <agent> in Coral."), which is not part of the file.
func gdocBody(md string) string {
	return strings.TrimLeft(gdocCoralHeader.ReplaceAllString(md, ""), "\n")
}

// gdocSame says two texts are the same file for a person: a Doc gives back the lines it was sent, only with its own spacing at the ends.
func gdocSame(a, b string) bool {
	return strings.TrimSpace(strings.ReplaceAll(a, "\r\n", "\n")) == strings.TrimSpace(strings.ReplaceAll(b, "\r\n", "\n"))
}

// gdocTakeEdits is the loop's first step for one share: it returns true when the Google edit was taken as the file's newest version (the Doc and Coral are then the same, and there is nothing to send).
// It returns false, with no change, when the Doc is as it was at the last sync, when the edit cannot be taken (the Doc then keeps what it has and the loop's own step decides), or when the file also
// changed in Coral (the edit is kept as its own file, and the loop's keep-both follows).
func (h *SessionsHandler) gdocTakeEdits(ctx context.Context, c *gdocsync.Client, sh store.GdocShare, members []seriesMember) (bool, error) {
	if len(members) == 0 || sh.DocRevision == "" {
		return false, nil // no series, or no revision to compare with: there is nothing to say a Doc changed
	}
	p, err := c.Pull(ctx, sh.DocID)
	if err != nil {
		return false, err
	}
	if p.Revision == "" || p.Revision == sh.DocRevision {
		return false, nil
	}
	body := gdocBody(p.Markdown)
	if len(body) > gdocMaxMarkdown || !utf8.ValidString(body) || strings.TrimSpace(body) == "" {
		slog.Info("[gdoc] an edit in a shared Doc was not taken: its text is empty, too large or not text")
		return false, nil
	}
	latest := members[len(members)-1]
	if cur, _, ok := h.gdocReadVersion(latest.Digest); ok && gdocSame(string(cur), body) {
		return true, h.gdocRecord(ctx, sh, latest.Digest, p.Revision) // only the Doc's own spacing changed: the same version, the new revision
	}
	if !gdocEditsLimit.allow(sh.Key, time.Now()) {
		return false, errGdocRate
	}
	if latest.Digest != sh.Digest {
		// The file changed in Coral too: keep both. The edit becomes its own file; the revision is NOT recorded, so the push that follows sees a Doc edited since the last sync and keeps it.
		if _, err := h.gdocStoreEdit(sh.Key, latest, []byte(body), true); err != nil {
			if errors.Is(err, errGdocNoTeam) {
				return false, nil // a file of no team has nowhere to keep the edit: the Doc is still kept as it is by the push that follows
			}
			return false, err
		}
		slog.Info("[gdoc] a shared Doc was edited in Google and its file changed in Coral: the edit is kept as its own file and the Doc is kept as it is")
		return false, nil
	}
	digest, err := h.gdocStoreEdit(sh.Key, latest, []byte(body), false)
	if err != nil {
		if errors.Is(err, errGdocNoTeam) {
			return false, nil // nothing is taken and the revision is not recorded: the Doc is left as it is
		}
		return false, err
	}
	return true, h.gdocRecord(ctx, sh, digest, p.Revision)
}

// gdocEditsLimit bounds the edits taken from one Doc in an hour, apart from the writes to it.
var gdocEditsLimit = &gdocLimiter{at: map[string][]time.Time{}}

// gdocRecord remembers the version now in the Doc and its revision, and never brings back a share the owner stopped.
func (h *SessionsHandler) gdocRecord(ctx context.Context, sh store.GdocShare, digest, rev string) error {
	gdocShareMu.Lock()
	defer gdocShareMu.Unlock()
	cur, err := h.ss.GetGdocShare(ctx, sh.Key)
	if err != nil || cur == nil {
		return err
	}
	cur.Digest, cur.DocRevision = digest, rev
	cur.SyncedAt = time.Now().UTC().Format(time.RFC3339)
	return h.ss.SaveGdocShare(ctx, *cur, time.Now())
}

// gdocStoreEdit stores the Doc's text: as the next version of the file's series, or (separate) as a file of its own next to it. The record names no one as the writer.
func (h *SessionsHandler) gdocStoreEdit(key string, latest seriesMember, body []byte, separate bool) (string, error) {
	coralDir := h.cfg.CoralDir()
	if latest.Board == "" {
		return "", errGdocNoTeam // a file of no team has no series to join
	}
	sum := sha256.Sum256(body)
	hexID := hex.EncodeToString(sum[:])
	dir := filepath.Join(coralDir, "artifacts", "objects")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, artifactUploadTempP+"*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // a no-op once it is in the store
	_, werr := tmp.Write(body)
	if cerr := tmp.Close(); werr != nil || cerr != nil {
		return "", errors.New("gdoc: could not store the edit")
	}
	base, _ := readUploadRecord(coralDir, latest.Session, latest.Digest)
	name := base.Name
	if name == "" {
		name = latest.Name
	}
	if name == "" {
		name = "Coral artifact.md"
	}
	shape := func(rec *agentUploadRecord) {
		rec.Board, rec.OwnerKind, rec.OwnerID = latest.Board, base.OwnerKind, base.OwnerID
		rec.Uploader, rec.Role = gdocEditUploader, ""
		rec.UploadedBy, rec.Source, rec.PromotedBy = gdocEditUploadedBy, sourceGdocEdit, "auto_sync" // never the Operator, never the original uploader
		rec.TaskID = 0
	}
	if separate {
		if _, _, err := storeArtifactFileAs(coralDir, latest.Session, gdocSeparateName(name), "text/markdown", tmpPath, hexID, int64(len(body)), nil, 0, shape); err != nil {
			return "", err
		}
		noteArtifactsChanged()
		return hexID, nil
	}
	plan, err := planNewVersion(coralDir, "coral://artifacts/"+latest.Digest, latest.Board, hexID)
	if err != nil {
		return "", err
	}
	defer plan.unlock()
	if plan.same != nil {
		return plan.same.Digest, nil
	}
	if len(plan.rows) > 0 && plan.rows[len(plan.rows)-1].Digest != latest.Digest {
		return "", errors.New("gdoc: the file changed while the edit was read") // the next pass reads both again
	}
	if _, _, err := storeArtifactFileAs(coralDir, latest.Session, name, "text/markdown", tmpPath, hexID, int64(len(body)), &plan.stamp, 0, shape); err != nil {
		return "", err
	}
	if _, err := plan.commit(coralDir, hexID, latest.Session); err != nil {
		return "", err
	}
	noteArtifactsChanged()
	return hexID, nil
}

// gdocSeparateName is "<name> (edited in Google).<ext>", cleaned and capped like any shown name.
func gdocSeparateName(name string) string {
	name = cleanValue(name)
	if name == "" {
		name = "file"
	}
	ext := filepath.Ext(name)
	if len(ext) > 12 {
		ext = ""
	}
	return cleanValue(strings.TrimSuffix(name, ext) + gdocSeparateTail + ext)
}
