package routes

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/subgentic/coral/internal/board"
)

// Pictures on a scheduled job's prompt (#20750, goal #285): images {"prompt": [hex]} on the create and the edit, the Operator's alone, uploaded with POST /api/field-images?scope=instruction (a person's field has no team,
// so the pictures are kept under the empty board id). They stay until the prompt's pictures are replaced or the job is deleted; a run is given the prompt and then one coral://artifacts line per picture.

// SetPictures gives the handler the board handler that checks and keeps field pictures.
func (h *ScheduleHandler) SetPictures(bh *BoardHandler) { h.pictures = bh }

func jobPictureOwner(jobID int64) string { return strconv.FormatInt(jobID, 10) }

// jobPictures checks the images of a job write (the field is prompt). It answers the request when one is not allowed.
func (h *ScheduleHandler) jobPictures(w http.ResponseWriter, r *http.Request, draft string, in map[string][]string, jobID int64) (map[string][]board.GoalImage, bool) {
	if in == nil {
		return nil, true
	}
	if h.pictures == nil || h.pictures.bs == nil {
		writeError(w, http.StatusServiceUnavailable, "pictures_unavailable", "pictures are not available here")
		return nil, false
	}
	var record map[string][]board.GoalImage
	if jobID != 0 {
		record = h.pictures.recordedFieldImages(r, "", board.FieldImagesJob, jobPictureOwner(jobID))
	}
	return h.pictures.fieldPictures(w, r, "", "instruction", draft, in, record, "prompt")
}

// keepJobPictures saves what a write named for a job; false when the save failed (the job is written: the answer says its pictures are not saved, #20758).
func (h *ScheduleHandler) keepJobPictures(ctx context.Context, jobID int64, pictures map[string][]board.GoalImage) bool {
	if len(pictures) == 0 {
		return true
	}
	if err := h.pictures.saveFieldImages(ctx, "", board.FieldImagesJob, jobPictureOwner(jobID), pictures); err != nil {
		slog.Warn("[schedule] the pictures of a job were not kept", "job", jobID, "error", err)
		return false
	}
	return true
}

// jobAnswer is a job as the routes answer it: its fields, its pictures and, when a save failed, the flag that says so.
func (h *ScheduleHandler) jobAnswer(ctx context.Context, job any, jobID int64, lost bool) any {
	raw, err := json.Marshal(job)
	var out map[string]any
	if err != nil || json.Unmarshal(raw, &out) != nil {
		return job
	}
	if h.pictures != nil && h.pictures.bs != nil {
		if m, err := h.pictures.bs.FieldImages(ctx, "", board.FieldImagesJob, jobPictureOwner(jobID)); err == nil && len(m) > 0 {
			out["images"] = m
		}
	}
	if lost {
		out["pictures_not_saved"], out["pictures_warning"] = true, picturesNotSavedWords
	}
	return out
}

// takeImages removes images and images_draft from an update's fields and returns them in the shape a write names them.
func takeImages(fields map[string]interface{}) (images map[string][]string, draft string, ok bool) {
	raw, has := fields["images"]
	delete(fields, "images")
	if d, isStr := fields["images_draft"].(string); isStr {
		draft = d
	}
	delete(fields, "images_draft")
	if !has {
		return nil, draft, true
	}
	b, err := json.Marshal(raw)
	if err != nil || json.Unmarshal(b, &images) != nil || images == nil {
		return nil, draft, false
	}
	return images, draft, true
}

// JobPictureLines is what a run's prompt gets after its words: one coral://artifacts line per picture the job carries.
func (h *ScheduleHandler) JobPictureLines(ctx context.Context, jobID int64) string {
	if h.pictures == nil || h.pictures.bs == nil {
		return ""
	}
	m, err := h.pictures.bs.FieldImages(ctx, "", board.FieldImagesJob, jobPictureOwner(jobID))
	if err != nil {
		return ""
	}
	return pictureLines(m["prompt"])
}
