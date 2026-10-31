package routes

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/mediatype"
)

// withoutTag is tags without drop, in a new slice (the stored list is shared); nil when none is left.
func withoutTag(tags []string, drop string) []string {
	var out []string
	for _, t := range tags {
		if t != drop {
			out = append(out, t)
		}
	}
	return out
}

// Artifact tags (#8583, Goal #61): the team's words on its stored artifacts ("for review", "internal"). A tag belongs to a team's use of an object (board.Store.ArtifactTags).

// attachArtifactTags sets Tags on the managed items of project from the team's tags. A read that fails leaves the rows untagged.
func (h *BoardHandler) attachArtifactTags(ctx context.Context, project string, items []teamArtifact) {
	tags, err := h.bs.ArtifactTags(ctx, project)
	if err != nil || len(tags) == 0 {
		return
	}
	questions, _ := h.bs.ArtifactQuestions(ctx, project) // what each upload for review asks (#11555); a read that fails leaves the rows without it
	reviews, _ := h.bs.ArtifactReviews(ctx, project)     // when a review was decided (#136584); a read that fails leaves the rows without it
	for i := range items {
		if items[i].managed != "" {
			items[i].Tags = tags[items[i].managed]
			if hasTag(items[i].Tags, tagForReview) && items[i].MediaType != "" && !mediatype.Viewable(items[i].MediaType, items[i].Name) {
				items[i].Tags = withoutTag(items[i].Tags, tagForReview) // a row Needs you cannot show leaves it, whoever tagged it and whenever (#11553); the stored tag is not changed
			}
			if q, ok := questions[items[i].managed]; ok && hasTag(items[i].Tags, tagForReview) {
				items[i].ReviewQuestion = q.Question
			}
			if rv, ok := reviews[items[i].managed]; ok {
				rv := rv
				items[i].Review = &rv
			}
		}
	}
}

// hasAnyTag reports whether have holds any of want.
func hasAnyTag(have, want []string) bool {
	for _, h := range have {
		for _, w := range want {
			if h == w {
				return true
			}
		}
	}
	return false
}

// teamTagCounts is how many of the items carry each tag.
func teamTagCounts(items []teamArtifact) map[string]int {
	counts := map[string]int{}
	for _, it := range items {
		for _, t := range it.Tags {
			counts[t]++
		}
	}
	return counts
}

// teamHasManagedArtifact reports whether the object id is one of the team's artifacts: referenced by a task result of the board, uploaded by one of its sessions, or received by it.
func (h *BoardHandler) teamHasManagedArtifact(ctx context.Context, project, id string) bool {
	_, ok := h.teamManagedArtifact(ctx, project, id)
	return ok
}

// teamManagedArtifact is the team's row for the object id (its name, and who uploaded it), or false when it is not one of the team's.
func (h *BoardHandler) teamManagedArtifact(ctx context.Context, project, id string) (teamArtifact, bool) {
	subscribers, err := h.bs.TeamSubscriberSessions(ctx, project)
	if err != nil {
		return teamArtifact{}, false
	}
	tasks, _, err := h.bs.ListTeamArtifactTasksQuery(ctx, board.TeamArtifactQuery{Project: project, Limit: board.MaxTeamArtifactTaskScan, Subscribers: subscribers})
	if err != nil {
		return teamArtifact{}, false
	}
	items := collectTeamArtifacts(project, tasks, subscribers, "")
	items = h.uploads.merge(items, h.coralDir, teamUploadSessions(tasks, subscribers))
	items = h.mergeCrossTeamRows(items, project)
	for _, it := range items {
		if it.managed == id {
			return it, true
		}
	}
	return teamArtifact{}, false
}

// SetArtifactTags replaces the tags of one of the team's artifacts: the Operator's and the team owner's (an agent's token is refused by the identity layer; a Hub viewer has no route to it).
// PUT /api/board/{project}/artifacts/{id}/tags  {"tags": ["for review", "internal"]}
func (h *BoardHandler) SetArtifactTags(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	project := urlParam(r, "project")
	id := strings.ToLower(chi.URLParam(r, "id"))
	if !objectNameRe.MatchString(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	var body struct {
		Tags []string `json:"tags"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	tags, err := board.NormalizeArtifactTags(body.Tags)
	if err != nil {
		errBadRequest(w, strings.TrimPrefix(err.Error(), board.ErrArtifactTag.Error()+": "))
		return
	}
	if !h.teamHasManagedArtifact(r.Context(), project, id) {
		errNotFound(w, "this team has no such artifact")
		return
	}
	if err := h.bs.SetArtifactTags(r.Context(), project, id, tags); err != nil {
		errInternalServer(w, "could not change the tags")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "tags": tags})
}

// applyManifestTags records the tags an agent asked for on the stored objects its task result links (#8583), added to the team's tags of each (at most five in all), and takes them out of the rows:
// the table is where a tag lives, so a person's later change is the only word. A tag that is not one is left out, never an error.
func (h *BoardHandler) applyManifestTags(ctx context.Context, project, asker string, artifacts []board.TaskArtifact) {
	for i := range artifacts {
		a := &artifacts[i]
		tags := a.Tags
		a.Tags = nil
		question := strings.TrimSpace(a.Question)
		a.Question = "" // the table is where a question lives, as a tag does
		if len(tags) == 0 || a.Provenance == provenanceUnverified {
			continue
		}
		id := managedArtifactID(a.URI)
		if id == "" {
			continue
		}
		clean := board.CleanArtifactTags(tags)
		if hasTag(clean, tagForReview) {
			q, ok := board.CleanReviewQuestion(question)
			if !ok || hasSignInLink(question) || asker == "" {
				clean = withoutTag(clean, tagForReview) // no question, no review row: the Operator would not know what is asked (#11555)
				slog.Warn("task artifact not tagged for review: it has no question", "board", project, "artifact", a.Name)
			} else {
				_, _ = h.bs.SetArtifactQuestion(ctx, project, id, q, asker, time.Now())
			}
		}
		if len(clean) == 0 {
			continue
		}
		if _, err := h.bs.AddArtifactTags(ctx, project, id, clean); err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("task artifact tags not recorded", "board", project, "artifact", a.Name, "error", err)
		}
	}
}
