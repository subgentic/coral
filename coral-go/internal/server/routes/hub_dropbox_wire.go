package routes

import (
	"context"
	"net/http"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/hubdropbox"
	"github.com/subgentic/coral/internal/secrets"
)

// NewHubDropbox builds the Hub-called Dropbox routes' state from the real stores (#16109). The board store's private mark and tag reads are the gate right before the bytes go; without the store nothing is sent.
func (h *CloudHandler) NewHubDropbox(coralDir string, bs *board.Store) *HubDropbox {
	_ = secrets.Init()
	hubdropbox.Scan = func(b []byte) ([]byte, error) { return secrets.Redactor().Text(b) } // the redactor Share via Dropbox uses
	d := &HubDropbox{
		CoralDir: coralDir,
		On: func(ctx context.Context) (bool, error) {
			s, err := h.ss.GetSettings(ctx)
			if err != nil {
				return false, err
			}
			return HubDropboxShareOn(s), nil
		},
		Who: func(digest string) (string, string, string) {
			for _, rec := range recordsOfDigest(coralDir, digest) {
				agent := rec.rec.Uploader
				if agent == "" {
					agent = "operator"
				}
				return rec.rec.Name, rec.rec.Board, agent
			}
			return "", "", ""
		},
	}
	if bs != nil {
		d.Private = func(ctx context.Context, digest string) (bool, error) { return bs.ArtifactPrivate(ctx, digest) }
		d.Internal = func(ctx context.Context, digest string) (bool, error) {
			return bs.ArtifactTaggedAnywhere(ctx, digest, "internal")
		}
	}
	return d
}

// LocalUploadAnyway is POST /api/dropbox/upload-anyway/{digest}: the owner's click in this computer's own dashboard for a held file. Never through the tunnel, never an agent's token.
func (d *HubDropbox) LocalUploadAnyway(h *CloudHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.refuseCloud(w, r, allowDashboard) {
			return
		}
		if !humanInputCaller(r) {
			writeError(w, http.StatusForbidden, "operator_only", "Only you can let a held file go, from this computer's dashboard")
			return
		}
		d.UploadAnyway(w, r)
	}
}
