// Share as artifact (#10269): the person turns one file of an agent's working folder into an artifact they own.

package routes

import (
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/mediatype"
)

// shareFileBucket is the hourly upload bucket of files the person shares from the Files tab on this computer (their own, apart from any agent's).
const shareFileBucket = "owner:share-file"

// shareFileHubBucket is the prefix of the windows of files shared through Coral Hub: one per hub account ("owner:share-file-hub:hub-user-<8 hex>", or "owner:share-file-hub:" when the hub sent none), each with
// half the allowance (windowLimits), so a grantee cannot use up the owner's own window or another grantee's (#10855, coral-hub Security).
const shareFileHubBucket = "owner:share-file-hub:"

// shareBucket is the window a share counts in: the owner's own, or the one of the hub account that made the request.
func shareBucket(via uploadVia) string {
	if !via.Hub {
		return shareFileBucket
	}
	return shareFileHubBucket + via.User
}

// ShareFileArtifact stores a file of the agent's working tree as an artifact owned by the person and answers with its link.
// POST /api/sessions/live/{name}/share-file?filepath=...&session_id=...
// The file is read under the bounds of file-content (the folder, the denylist, the tunnel's roots) and held to the size cap of an agent's upload.
func (h *SessionsHandler) ShareFileArtifact(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	fp := r.URL.Query().Get("filepath")
	sessionID := r.URL.Query().Get("session_id")
	if !h.requireAgentSession(w, r, name, sessionID) {
		return
	}
	if fp == "" || strings.HasPrefix(fp, "-") || strings.ContainsAny(fp, "\x00") {
		errBadRequest(w, "filepath is required")
		return
	}
	coralDir := h.cfg.CoralDir()
	if coralDir == "" || sessionID == "" {
		errBadRequest(w, "the artifact store is not available")
		return
	}
	if refuseIfDiskLow(w) {
		return
	}
	content, _, ok := h.readWorkFile(w, r, name, sessionID, fp, maxAgentArtifactSize, "This file is too large to share (the limit is 64 MiB)")
	if !ok {
		return
	}
	fileName := filepath.Base(fp)
	if !board.ValidLabel(fileName, 160) {
		errBadRequest(w, "this file's name cannot be an artifact's name")
		return
	}
	mt := mediatype.Resolve("", fileName)
	if mt == "" {
		mt = mediatype.Generic
	}
	if sniffImageFamily(content) != "" { // a picture goes without its metadata, or is refused, as an agent's upload does
		cleaned, _, err := cleanUploadedImage(content)
		if err != nil {
			artifactRefusal(w, http.StatusBadRequest, "image_metadata", "", err.Error())
			return
		}
		content = cleaned
	}
	st := storeFor(coralDir)
	via := hubViaOf(r)
	bucket := shareBucket(via)
	if ok, retry := st.admitUpload(bucket); !ok {
		artifactHourlyLimited(w, retry, fmt.Sprintf("the hourly limit for shared files is used up; try again in %s", retry.Round(time.Minute)))
		return
	}
	if !st.chargeUpload(bucket, int64(len(content))) {
		artifactHourlyLimited(w, 0, "the hourly size limit for shared files is used up; try again later")
		return
	}
	id, meta, err := storeArtifactVia(coralDir, sessionID, fileName, mt, uploadedByOwner, "", via.User, content) // the hub account that shared it is on the record, as for a pasted image (#6088)
	if errors.Is(err, errStoreFull) {
		b, _, max := st.size()
		artifactRefusal(w, http.StatusRequestEntityTooLarge, "artifact_quota", "store",
			fmt.Sprintf("the artifact store is full (%s of %s): delete old artifacts or raise the limit in Settings > Storage and cleanup", humanBytes(b), humanBytes(max)))
		return
	}
	if err != nil {
		errInternalServer(w, "could not store the artifact")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"uri":        "coral://artifacts/" + id,
		"url":        artifactURL(id),
		"name":       meta.Name,
		"media_type": meta.MediaType,
		"size":       meta.Size,
		"digest":     meta.Digest,
	})
}
