package routes

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
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
	sent, _ := h.bs.ArtifactReviewSent(ctx, project)     // when each file was sent for review (#13231); a read that fails leaves the rows without it
	for i := range items {
		if items[i].managed != "" {
			items[i].Tags = tags[items[i].managed]
			if hasTag(items[i].Tags, tagForReview) && items[i].MediaType != "" && !mediatype.Viewable(items[i].MediaType, items[i].Name) {
				items[i].Tags = withoutTag(items[i].Tags, tagForReview) // a row Needs you cannot show leaves it, whoever tagged it and whenever (#11553); the stored tag is not changed
			}
			if q, ok := questions[items[i].managed]; ok && hasTag(items[i].Tags, tagForReview) {
				items[i].ReviewQuestion = q.Question
			}
			if at, ok := sent[items[i].managed]; ok && hasTag(items[i].Tags, tagForReview) {
				items[i].ReviewSentAt = at
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

// teamTagCountsByFile is teamTagCounts over files, not versions (#11700): a file counts once for a tag when any of its versions carries it, the number the Tag filter then shows rows for.
func teamTagCountsByFile(items []teamArtifact) map[string]int {
	type slot struct{ key, tag string }
	counts := map[string]int{}
	seen := map[slot]bool{}
	for i, it := range items {
		key := artifactVersionKey(it)
		if key == "" {
			key = "row:" + strconv.Itoa(i) // a row with no uploader is its own file
		}
		for _, t := range it.Tags {
			if !seen[slot{key, t}] {
				seen[slot{key, t}] = true
				counts[t]++
			}
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
	var tags, was []string
	var err error
	hub := cloud.Tunneled(r)
	if hub {
		tags, was, err = h.hubArtifactTags(r.Context(), project, id, body.Tags)
	} else {
		tags, err = board.NormalizeArtifactTags(body.Tags)
	}
	if err != nil {
		errBadRequest(w, strings.TrimPrefix(err.Error(), board.ErrArtifactTag.Error()+": "))
		return
	}
	if !h.teamHasManagedArtifact(r.Context(), project, id) {
		errNotFound(w, "this team has no such artifact")
		return
	}
	if hub {
		// A Hub write was judged against the list read above: it is made only if the list is still that one (#13129). If a local edit landed in between, the request is judged again against the new list (a few times), so it
		// can never overwrite that edit; one the rule now refuses is a 400.
		for attempt := 0; ; attempt++ {
			err = h.bs.SetArtifactTagsIf(r.Context(), project, id, was, tags)
			if !errors.Is(err, board.ErrArtifactTagsChanged) {
				break
			}
			if attempt >= hubTagsRetries {
				errConflict(w, "the tags changed while this was being saved; try again")
				return
			}
			if tags, was, err = h.hubArtifactTags(r.Context(), project, id, body.Tags); err != nil {
				errBadRequest(w, strings.TrimPrefix(err.Error(), board.ErrArtifactTag.Error()+": "))
				return
			}
		}
	} else {
		err = h.bs.SetArtifactTags(r.Context(), project, id, tags)
	}
	if err != nil {
		errInternalServer(w, "could not change the tags")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "tags": tags})
}

// applyManifestTags records the tags an agent asked for on the stored objects its task result links (#8583), added to the team's tags of each (at most five in all), and takes them out of the rows:
// the table is where a tag lives, so a person's later change is the only word. A tag that is not one is left out, never an error.
func (h *BoardHandler) applyManifestTags(ctx context.Context, project, asker string, person bool, artifacts []board.TaskArtifact) (notes []string) {
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
		var theirs []string
		for _, raw := range tags {
			if tag, _ := board.NormalizeArtifactTag(raw); board.OperatorArtifactTag(raw) && !hasTag(theirs, tag) {
				theirs = append(theirs, tag)
			}
		}
		if len(theirs) > 0 {
			notes = append(notes, fmt.Sprintf("%q: left out %s: those tags are the Operator's own; an agent does not set them.", a.Name, strings.Join(theirs, ", ")))
		}
		if hasTag(clean, tagForReview) {
			// The same rules as an upload with the tag, and the same words when one is not met: the result is not refused, the tag is left out, and the answer says why (#11581).
			q, qok := board.CleanReviewQuestion(question)
			meta, _ := h.objectSidecar(id)
			kept := false
			switch {
			case asker == "":
				notes = append(notes, fmt.Sprintf("%q: not tagged \"for review\": the result came from a caller that is not a member of this team.", a.Name))
			case !(person || h.askerUploaded(asker, id)):
				notes = append(notes, fmt.Sprintf("%q: not tagged \"for review\": only the agent that uploaded a file can ask for its review in a task result (upload it yourself with --tag \"for review\" --question \"...\").", a.Name))
			case meta.Digest != "" && !mediatype.Viewable(meta.MediaType, a.Name):
				notes = append(notes, "not tagged \"for review\": "+notViewableForReview(a.Name, meta.MediaType))
			case !qok || hasSignInLink(question):
				notes = append(notes, fmt.Sprintf("%q: not tagged \"for review\": %s", a.Name, questionRequiredText))
			default:
				_, _ = h.bs.SetArtifactQuestion(ctx, project, id, q, asker, time.Now())
				kept = true
			}
			if !kept {
				clean = withoutTag(clean, tagForReview)
				slog.Warn("task artifact not tagged for review", "board", project, "artifact", a.Name, "why", notes[len(notes)-1])
			}
		}
		if len(clean) == 0 {
			continue
		}
		if _, err := h.bs.AddArtifactTags(ctx, project, id, clean); err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("task artifact tags not recorded", "board", project, "artifact", a.Name, "error", err)
		}
	}
	return notes
}

// askerUploaded says the session uploaded the stored object itself (its own upload record): an agent cannot tag for review, with a question of its own, a file another agent uploaded (#11555).
func (h *BoardHandler) askerUploaded(session, id string) bool {
	if session == "" || session == "operator" {
		return false
	}
	_, ok := h.uploadRecordOf(session, id)
	return ok
}

// hubArtifactTags is the tags of a write that came through Coral Hub (#12742, #13117, #13450), judged against the list the server holds, never the client's word for what is there. The tags of a file are this computer's:
// a Hub write, which is the owner's alone (the route refuses anyone else before this runs), may only ADD or REMOVE one of THREE fixed marks, "read" (the file was opened), "saved" and "ignored" (the owner's Save and Ignore in
// the Needs you table drawn on the Hub). Any other difference from the stored list, a tag added or a tag removed, is refused and nothing is stored: a stored tag the write does not name is never dropped. The request is a set:
// the same tags in another order, or a repeat of the stored list, changes nothing, and what is stored keeps its order (the marks added go on the end, in the order read, saved, ignored). Marking a file read adds nothing else
// and is never refused for the five-tag count; adding "saved" or "ignored" is (a sixth tag is refused). The local rule (1 to 24 letters, digits, spaces or hyphens) still holds for every tag in the request.
func (h *BoardHandler) hubArtifactTags(ctx context.Context, project, id string, raw []string) (tags, was []string, err error) {
	want := map[string]bool{}
	for _, r := range raw {
		tag, ok := board.NormalizeArtifactTag(r)
		if !ok {
			return nil, nil, fmt.Errorf("%w: %q (1 to %d letters, digits, spaces or hyphens)", board.ErrArtifactTag, r, board.MaxArtifactTagLen)
		}
		want[tag] = true
	}
	all, err := h.bs.ArtifactTags(ctx, project)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: the tags could not be read", board.ErrArtifactTag)
	}
	stored := all[id]
	had := map[string]bool{}
	for _, t := range stored {
		had[t] = true
	}
	for t := range want {
		if !had[t] && !hubMarkTags[t] {
			return nil, nil, fmt.Errorf("%w: through Coral Hub only the tags %s can be added or removed, and %q is not on this file", board.ErrArtifactTag, hubMarkList, t)
		}
	}
	for t := range had {
		if !want[t] && !hubMarkTags[t] {
			return nil, nil, fmt.Errorf("%w: through Coral Hub only the tags %s can be added or removed, and %q is on this file", board.ErrArtifactTag, hubMarkList, t)
		}
	}
	out := make([]string, 0, len(stored)+len(hubMarkOrder))
	for _, t := range stored {
		if !hubMarkTags[t] || want[t] {
			out = append(out, t)
		}
	}
	// the marks that are in the write and were not on the file, appended in a fixed order
	addedChoice := false
	for _, m := range hubMarkOrder {
		if want[m] && !had[m] {
			out = append(out, m)
			if m != hubMarkRead {
				addedChoice = true
			}
		}
	}
	if addedChoice && len(out) > board.MaxArtifactTags {
		return nil, nil, fmt.Errorf("%w: at most %d tags on an artifact", board.ErrArtifactTag, board.MaxArtifactTags)
	}
	hubTagsAfterRead()
	return out, stored, nil
}

// The marks a write through Coral Hub may add or remove (#13117, #13450): the file was opened, the owner saved it, the owner put it away. A fixed list, never free text.
const (
	hubMarkRead    = "read"
	hubMarkSaved   = "saved"
	hubMarkIgnored = "ignored"
	hubMarkList    = `"read", "saved" and "ignored"`
)

var (
	hubMarkOrder = []string{hubMarkRead, hubMarkSaved, hubMarkIgnored}
	hubMarkTags  = map[string]bool{hubMarkRead: true, hubMarkSaved: true, hubMarkIgnored: true}
)

// hubTagsRetries is how many times a Hub write is judged again when a local edit changed the tags under it (#13129).
const hubTagsRetries = 3

// hubTagsAfterRead is a seam for a test: it runs once a Hub write has read the stored tags and worked out its answer, before it is written.
var hubTagsAfterRead = func() {}
