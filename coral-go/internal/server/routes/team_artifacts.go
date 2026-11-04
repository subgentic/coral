package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/subgentic/coral/internal/querypage"
	"github.com/subgentic/coral/internal/safego"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/hubproxy"
)

const (
	defaultTeamArtifactLimit = 100
	maxTeamArtifactLimit     = 200
	maxTeamArtifactOffset    = 10000
	maxArtifactMetaBytes     = 64 << 10
)

var digestLikeName = regexp.MustCompile(`^(?:sha256:)?[a-fA-F0-9]{32,64}$`)

// teamArtifact is one deduplicated artifact reference in a team's task results.
type teamArtifact struct {
	Uploader   string `json:"uploader,omitempty"`
	Role       string `json:"role,omitempty"`
	UploadedBy string `json:"uploaded_by,omitempty"`
	ID         string `json:"id"`
	Name       string `json:"name"`
	MediaType  string `json:"media_type,omitempty"`
	Size       *int64 `json:"size"`
	// Starred: the Operator starred this stored object on this computer (#9819); false for a row with no stored object.
	Starred   bool   `json:"starred"`
	CreatedAt string `json:"created_at"`
	// ReviewSentAt is when the file was sent for review (RFC 3339, UTC), present only while it carries the tag "for review" and was sent after the time was kept (#13231): "waiting for review" counts from it, a re-send starts it again.
	ReviewSentAt string `json:"review_sent_at,omitempty"`
	TaskID       int64  `json:"task_id"`
	TaskTitle    string `json:"task_title"`
	// GoalID and GoalTitle: the goal of this board the task works toward (#8579); absent for a task with none, and for a row of no task.
	GoalID    *int64 `json:"goal_id,omitempty"`
	GoalTitle string `json:"goal_title,omitempty"`
	// WaitsOnThis: what waits on a "for review" row's task: the open tasks of every board that list it as a blocker, and the goal it would close (#11455). Only on a row tagged for review with a task.
	WaitsOnThis *board.WaitsOnThis `json:"waits_on_this,omitempty"`
	// Tags: the team's tags on this stored object (#8583), lowercase words, sorted; absent for none.
	Tags []string `json:"tags,omitempty"`
	// Private: the manager marked this stored object private, so no guide reads it (#11457). Present (true) only for the owner's own read; never in anything an agent or a guide reads, and absent when it is not marked.
	Private bool `json:"private,omitempty"`
	// ReviewQuestion: what the agent that uploaded this file asks the Operator to decide (#11555), cleaned and at most 140 characters: on a row tagged for review, when its upload said (agent text: show it as text).
	ReviewQuestion string `json:"review_question,omitempty"`
	// Kind and Muted (#12144, the Operator's choice of what reaches Needs you): the kind of a file for review (done, release, decided or digest; absent for a plain file) and whether the Operator's settings mute it (its
	// kind is switched off or its team is not included): a muted file is in its folder and under the Muted line, and is not counted, badged or pushed. Only in the Operator's own read.
	Kind  string `json:"kind,omitempty"`
	Muted bool   `json:"muted,omitempty"`
	// NewComments: how many replies agents have left in the Operator's comment threads on this file since the Operator last opened them (#12026): the file's row says "New comments" and counts as unread again. Absent for none; only the
	// owner's own list has it.
	NewComments int `json:"new_comments,omitempty"`
	// Version and Versions: which version of its series this artifact is and how many the series has (#11890), present only for an artifact in a series of two or more; the Needs you row says "version 2"
	// from them, with no request of its own. They come from the upload records, the authority (digestSeries, seriesMembers).
	Version  int `json:"version,omitempty"`
	Versions int `json:"versions,omitempty"`
	// EarlierVersions: how many older versions of this file (the same team, uploader and name) a collapsed list leaves out (#11700): only on a list asked with versions=newest, and absent for none.
	EarlierVersions int `json:"earlier_versions,omitempty"`
	// Review is the Operator's decision on an artifact tagged for review, with its time (#136584): absent until one is made.
	Review         *board.ArtifactReview `json:"review,omitempty"`
	Source         string                `json:"source"`
	URI            string                `json:"uri,omitempty"`
	Digest         string                `json:"digest,omitempty"`
	Available      bool                  `json:"available"`
	Inline         bool                  `json:"inline"`
	ReferenceCount int                   `json:"reference_count"`
	PreviewURL     string                `json:"preview_url,omitempty"`
	DownloadURL    string                `json:"download_url,omitempty"`
	ContentURL     string                `json:"content_url,omitempty"`
	// SessionID/ProducedBy are the stored-ownership attribution (null when it
	// cannot be established); see board.ArtifactProducer.
	SessionID  *string `json:"session_id"`
	ProducedBy *string `json:"produced_by"`
	// Provenance is how a task result's managed link was checked (#4379): "uploaded", "person",
	// "received" (a file the board received with a cross-team message), or
	// "unverified" (a coral://artifacts link the team never uploaded: listed as a plain link, with no
	// size, type, preview or download from the store, "link not verified"). Omitted otherwise.
	Provenance string `json:"provenance,omitempty"`
	// A "shared" row (sent by this board) says where it went: SharedTo, the board on this Coral
	// (<server>/<board> across Corals). A "received" row says where it came from: ReceivedFrom (the
	// same form) and FromBoard (the sending board; only a claim across Corals). SentBy is who sent
	// it. Received files are not scanned (#4379).
	SharedTo     string `json:"shared_to,omitempty"`
	ReceivedFrom string `json:"received_from,omitempty"`
	FromBoard    string `json:"from_board,omitempty"`
	// AlsoReceivedFrom: other <server>/<board> that sent the same bytes later (#4449).
	AlsoReceivedFrom []string `json:"also_received_from,omitempty"`
	SentBy           string   `json:"sent_by,omitempty"`
	// BoardID and Team name the team a row belongs to in the cross-team list (GET /api/team-artifacts); a team's own list leaves them out.
	BoardID string `json:"board_id,omitempty"`
	Team    string `json:"team,omitempty"`

	index      int
	managed    string // 64-hex Coral object id for coral-managed artifacts
	fromRecord bool   // an upload row whose record holds the name, the type and the digest: the list needs no read of the sidecar for it (#13552)
	uploadTask int64  // the task an upload's record says it is linked to (#7739): shown only once the board says the task is the team's (linkUploadTasks)
}

func (h *BoardHandler) artifactObjectDir() string {
	if h.coralDir == "" {
		return ""
	}
	return filepath.Join(h.coralDir, "artifacts", "objects")
}

func parseBoundedInt(raw string, def, min, max int) (int, bool) {
	if raw == "" {
		return def, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < min || n > max {
		return 0, false
	}
	return n, true
}

// ListTeamArtifacts lists artifacts referenced by the selected team's task
// results. It reads only task workflow records and, for the returned page, the
// small metadata sidecar of Coral-managed objects (and stats the blob); it never scans the artifact
// directory or loads artifact bytes.
// GET /api/board/{project}/artifacts?limit=&offset=[&q=&kind=&origin=&by=&board=&kept=&since=&until=&sort=&cursor=&versions=newest]
//
// With only limit, offset and session_id the reply is the plain list. Any of the others makes it a query (team_artifacts_query.go,
// #4572): the reply then also has total, and next_cursor when there is another page.
func (h *BoardHandler) ListTeamArtifacts(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // through Coral Hub the owner's alone (#5575)
		return
	}
	project := urlParam(r, "project")
	// A query string Go cannot parse (a ";" or a bad %-escape) is dropped part by part by r.URL.Query(), which would answer a mistyped
	// filter with the unfiltered list: refuse it. An unknown parameter is refused by name (#4572).
	vals, perr := url.ParseQuery(r.URL.RawQuery)
	if perr != nil {
		errBadRequest(w, "the query string is not valid (no ';', and %-escapes must be two hex digits)")
		return
	}
	var unknown []string
	for k := range vals {
		if !teamArtifactParamNames[k] {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		errBadRequest(w, "unknown parameter "+strings.Join(unknown, ", "))
		return
	}
	tq, qerr := parseTeamArtifactQuery(vals)
	if qerr != nil {
		errBadRequest(w, strings.TrimPrefix(qerr.Error(), errTeamArtifactQuery.Error()+": "))
		return
	}
	limit, ok := parseBoundedInt(r.URL.Query().Get("limit"), defaultTeamArtifactLimit, 1, maxTeamArtifactLimit)
	if !ok {
		errBadRequest(w, fmt.Sprintf("limit must be an integer between 1 and %d", maxTeamArtifactLimit))
		return
	}
	offset, ok := parseBoundedInt(r.URL.Query().Get("offset"), 0, 0, maxTeamArtifactOffset)
	if !ok {
		errBadRequest(w, fmt.Sprintf("offset must be an integer between 0 and %d", maxTeamArtifactOffset))
		return
	}
	sessionFilter := strings.TrimSpace(r.URL.Query().Get("session_id"))
	if len(sessionFilter) > 128 || querypage.HasControl(sessionFilter) {
		errBadRequest(w, "session_id must be at most 128 characters without control characters")
		return
	}
	artifactsRev := h.bs.ArtifactsRevision(project)
	items, scanTruncated, _, err := h.projectArtifactItemsView(r, project, sessionFilter) // read-only: the query below filters into a new slice, and the page below is copied before a row of it is changed (#13552)
	if err != nil {
		errInternalServer(w, "could not list artifacts")
		return
	}
	// A name or id no board has, and nothing that names it, is "not found", not an empty list (#8821): the page says "No team named <name>". The board key resolver has already turned a label into its board's id; a board
	// with a row, a subscriber, a message, a task or a goal, or with artifacts recorded under its name, is known.
	if len(items) == 0 {
		if known, kerr := h.bs.BoardKnown(r.Context(), project); kerr == nil && !known {
			writeError(w, http.StatusNotFound, "board_not_found", "No team named "+project)
			return
		}
	}
	if tq != nil {
		h.queryTeamArtifacts(w, r, project, items, scanTruncated, limit, offset, sessionFilter, tq, artifactsRev)
		return
	}
	end := offset + limit
	hasMore := end < len(items)
	if offset > len(items) {
		offset = len(items)
	}
	if end > len(items) {
		end = len(items)
	}
	page := append([]teamArtifact(nil), items[offset:end]...) // this page's own rows: the list it was cut from may be the kept one
	dir := h.artifactObjectDir()
	starred, serr := h.bs.StarredArtifactIDs(r.Context()) // a bookmark: an unreadable set leaves the rows unstarred
	if serr != nil {
		starred = map[string]bool{}
	}
	for i := range page {
		enrichTeamArtifact(&page[i], dir)
		page[i].Starred = page[i].managed != "" && starred[page[i].managed]
		if digestLikeName.MatchString(page[i].Name) || strings.TrimSpace(page[i].Name) == "" {
			if page[i].TaskID == 0 {
				page[i].Name = "Uploaded artifact"
			} else {
				page[i].Name = fmt.Sprintf("Task #%d artifact", page[i].TaskID)
			}
		}
	}
	h.addWaitsOnThis(r, project, page)
	h.attachSeriesVersions(page, project)
	if page == nil {
		page = []teamArtifact{}
	}
	resp := map[string]any{
		"artifacts_rev": artifactsRev,
		"project":       project, "artifacts": page, "limit": limit, "offset": offset,
		"has_more": hasMore, "truncated": scanTruncated,
	}
	if sessionFilter != "" {
		resp["session_id"] = sessionFilter
	}
	writeJSON(w, http.StatusOK, resp)
}

// projectArtifactItems is a team's artifact list as the team route builds it, before any query: the task results, the uploads of its agents, the cross-team rows and the upload task links, cut to what the caller may read.
// sessionFilter keeps one session's uploads (only a session of this board).
func (h *BoardHandler) projectArtifactItems(r *http.Request, project, sessionFilter string) ([]teamArtifact, bool, error) {
	items, truncated, aliased, err := h.projectArtifactItemsView(r, project, sessionFilter)
	if err != nil {
		return nil, false, err
	}
	if aliased {
		items = cloneTeamRows(items) // a caller that writes to its rows (or through them) gets its own list
	}
	return items, truncated, nil
}

// projectArtifactItemsView is projectArtifactItems for a caller that only READS the rows (the team list's query: it filters into a new slice and copies the rows of its page before it changes one). shared says the
// rows are the kept list's (aliased: the slice itself, or a copy of it that still shares what the rows point to), which no request may write to or through; a request whose parts need a row changed (the new-comments counts, a kind or a muted team, a private mark taken off, a Hub viewer's redaction) gets its own
// copy, and one that changes nothing, the Operator's walk of a big board, copies nothing: 20,000 rows were copied for every page (#13552).
func (h *BoardHandler) projectArtifactItemsView(r *http.Request, project, sessionFilter string) (items []teamArtifact, scanTruncated, aliased bool, err error) {
	subscribers, err := h.bs.TeamSubscriberSessions(r.Context(), project)
	if err != nil {
		return nil, false, false, err
	}
	// The revision is read BEFORE the data: a write during the build leaves the entry older than the next token (see teamItemsCache).
	key := teamItemsKey{project: project, session: sessionFilter, rev: h.bs.ArtifactsRevision(project), subscribers: h.teamItemsSubscribers(subscribers)}
	items, scanTruncated, anyPrivate, hit := h.itemsCache.get(key)
	shared := hit // the slice is the kept one (own() copies it by value); the rows keep sharing what they point to either way
	if !hit {
		items, scanTruncated, err = h.buildProjectArtifactItems(r, project, sessionFilter, subscribers)
		if err != nil {
			return nil, false, false, err
		}
		h.itemsCache.put(key, items, scanTruncated)
		for i := range items {
			if items[i].Private {
				anyPrivate = true
				break
			}
		}
	}
	own := func() { // the first write to a shared list copies it
		if shared {
			items = append([]teamArtifact(nil), items...)
			shared = false
		}
	}
	ctx := r.Context()
	// What depends on the caller, or on settings that do not move the revision, is applied to this request's own view.
	if h.commentNews != nil && len(items) > 0 && operatorOrKeyCaller(r) {
		if news, nerr := h.commentNews(ctx); nerr == nil && len(news) > 0 {
			own()
			for i := range items {
				items[i].NewComments = news[items[i].ID]
			}
		}
	}
	if len(items) > 0 && operatorOrKeyCaller(r) {
		if kinds, kerr := h.bs.ArtifactKindsOf(ctx, project); kerr == nil {
			prefs := h.inboxPrefs(ctx)
			for i := range items {
				if items[i].managed == "" {
					continue
				}
				kind := kinds[items[i].managed]
				setKind := kind != "" && kind != board.KindFile
				muted := prefs.muted(project, kind)
				if !setKind && !muted {
					continue
				}
				own()
				if setKind {
					items[i].Kind = kind
				}
				if muted {
					items[i].Muted = true
				}
			}
		}
	}
	if filtered := filterReadable(r, h.coralDir, items); !sameList(filtered, items) { // an agent's list holds only what the one read check lets it read, so the totals and the cursor count nothing else (#5577)
		items, shared = filtered, false // a new slice: this request's own
	}
	if anyPrivate && !ownerSeesPrivateMarks(r) {
		own()
		for i := range items {
			items[i].Private = false // the marks are kept with the list; this caller may not see them
		}
	}
	if shared && cloud.Tunneled(r) {
		own() // a Hub viewer's rows are redacted in place by the query
	}
	return items, scanTruncated, hit, nil
}

// sameList says a and b are the one slice (the same first row, the same length): filterReadable answers the list it was given when it has nothing to take out.
func sameList(a, b []teamArtifact) bool {
	if len(a) != len(b) {
		return false
	}
	return len(a) == 0 || &a[0] == &b[0]
}

// buildProjectArtifactItems is the part of the list that is the team's own (the same for every caller): the task results, the uploads of its agents, the cross-team rows, the upload task links and the tags.
func (h *BoardHandler) buildProjectArtifactItems(r *http.Request, project, sessionFilter string, subscribers map[string]string) ([]teamArtifact, bool, error) {
	teamItemsBuildHook()
	tasks, scanTruncated, err := h.bs.ListTeamArtifactTasksQuery(r.Context(), board.TeamArtifactQuery{
		Project: project, Limit: board.MaxTeamArtifactTaskScan, SessionID: sessionFilter, Subscribers: subscribers,
	})
	if err != nil {
		return nil, false, err
	}
	items := collectTeamArtifacts(project, tasks, subscribers, sessionFilter)
	if sessionFilter != "" {
		// Only a session of this board: the filter used to list ANY session's uploads under
		// this board's name (#3601, weak site W27).
		if _, onBoard := teamUploadSessions(tasks, subscribers)[sessionFilter]; onBoard {
			items = h.uploads.merge(items, h.coralDir, map[string]string{sessionFilter: ""})
		}
	} else {
		items = h.uploads.merge(items, h.coralDir, teamUploadSessions(tasks, subscribers))
		items = h.mergeCrossTeamRows(items, project)
	}
	h.linkUploadTasks(r.Context(), project, items)
	h.attachArtifactTags(r.Context(), project, items)
	h.markPrivateArtifacts(r.Context(), items)
	return items, scanTruncated, nil
}

// collectTeamArtifacts flattens task references into deduplicated items. When
// sessionFilter is set, artifacts not attributed to that session are dropped
// before ordering and dedupe, so repeated objects collapse per agent.
func collectTeamArtifacts(project string, tasks []board.TeamArtifactTask, subscribers map[string]string, sessionFilter string) []teamArtifact {
	var all []teamArtifact
	add := func(t board.TeamArtifactTask, source, created string, refs []board.TaskArtifact) {
		if created == "" {
			created = t.CreatedAt
		}
		producer, session := board.ArtifactProducer(t, source, subscribers)
		if sessionFilter != "" && session != sessionFilter {
			return
		}
		for i, a := range refs {
			item := teamArtifact{Name: a.Name, MediaType: a.MediaType, CreatedAt: created, TaskID: t.TaskID, TaskTitle: t.Title, GoalID: t.GoalID, GoalTitle: t.GoalTitle, Source: source, URI: a.URI, Digest: a.Digest, index: i, ReferenceCount: 1, Provenance: a.Provenance}
			if producer != "" {
				p := producer
				item.ProducedBy = &p
			}
			if session != "" {
				sid := session
				item.SessionID = &sid
			}
			switch {
			case a.URI != "":
				// A managed link counts as the team's file unless the check at completion marked it
				// unverified (#4379); legacy rows (no provenance) show as they always did.
				if id := managedArtifactID(a.URI); id != "" && a.Provenance != provenanceUnverified {
					item.managed = id
					item.ID = item.managed
				} else {
					item.ID = "uri:" + a.URI
					if id != "" {
						item.MediaType, item.Digest = "", "" // nothing from the store, nor what the agent claimed of it
					}
				}
			case a.Content != "":
				n := int64(len(a.Content))
				item.Size, item.Inline, item.Available = &n, true, true
				item.ID = fmt.Sprintf("task-%d-%s-%d", t.TaskID, source, i)
				if item.MediaType == "" {
					item.MediaType = "text/plain; charset=utf-8"
				}
				item.ContentURL = fmt.Sprintf("/api/board/%s/tasks/%d/artifact-content?source=%s&index=%d", url.PathEscape(project), t.TaskID, source, i)
			default:
				continue
			}
			all = append(all, item)
		}
	}
	for _, t := range tasks {
		add(t, "completion", t.CompletedAt, t.Artifacts)
		if t.Review != nil {
			add(t, "review", t.Review.SubmittedAt, t.Review.Artifacts)
		}
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].CreatedAt != all[j].CreatedAt {
			return all[i].CreatedAt > all[j].CreatedAt
		}
		if all[i].TaskID != all[j].TaskID {
			return all[i].TaskID > all[j].TaskID
		}
		if all[i].Source != all[j].Source {
			return all[i].Source < all[j].Source
		}
		return all[i].index < all[j].index
	})
	// Repeated references to one stored object or URI collapse to the newest.
	seen := make(map[string]int, len(all))
	out := all[:0:0]
	for _, it := range all {
		if at, dup := seen[it.ID]; dup {
			out[at].ReferenceCount++
			continue
		}
		seen[it.ID] = len(out)
		out = append(out, it)
	}
	return out
}

// enrichTeamArtifact fills size, availability and URLs. Only the sidecar
// metadata file of Coral-managed objects is read, never the object itself.
// sidecarMetaCache holds the parsed sidecar of a managed object by its path, so a list does not open, read and parse the same small
// files on every request (#9535). An entry answers only while the sidecar's size and mtime are the ones it was read at (the stat that
// checks them is the only syscall a hit costs), and a sidecar modified within uploadDirSettle is never kept: a coarse mtime cannot then hide
// a rewrite made within the same tick. The map is bounded: when full it starts over.
var sidecarMetaCache = struct {
	sync.Mutex
	m map[string]sidecarMetaEntry
}{m: map[string]sidecarMetaEntry{}}

const maxSidecarMetaEntries = 4096

type sidecarMetaEntry struct {
	mod  time.Time
	size int64
	meta agentArtifactMeta
}

// readArtifactSidecar is the parsed sidecar at metaPath; false when it is missing, over maxArtifactMetaBytes or not JSON.
func readArtifactSidecar(metaPath string) (agentArtifactMeta, bool) {
	st, err := os.Stat(metaPath)
	if err != nil || st.Size() > maxArtifactMetaBytes {
		return agentArtifactMeta{}, false
	}
	sidecarMetaCache.Lock()
	e, hit := sidecarMetaCache.m[metaPath]
	sidecarMetaCache.Unlock()
	if hit && e.size == st.Size() && e.mod.Equal(st.ModTime()) {
		return e.meta, true
	}
	data, err := os.ReadFile(metaPath)
	if err != nil {
		return agentArtifactMeta{}, false
	}
	var meta agentArtifactMeta
	if json.Unmarshal(data, &meta) != nil {
		return agentArtifactMeta{}, false
	}
	if time.Since(st.ModTime()) > uploadDirSettle {
		sidecarMetaCache.Lock()
		if len(sidecarMetaCache.m) >= maxSidecarMetaEntries {
			sidecarMetaCache.m = map[string]sidecarMetaEntry{}
		}
		sidecarMetaCache.m[metaPath] = sidecarMetaEntry{mod: st.ModTime(), size: st.Size(), meta: meta}
		sidecarMetaCache.Unlock()
	}
	return meta, true
}

func enrichTeamArtifact(it *teamArtifact, objectDir string) {
	switch {
	case it.managed != "":
		it.PreviewURL = artifactURL(it.managed)
		it.DownloadURL = it.PreviewURL
		if objectDir == "" || !objectNameRe.MatchString(it.managed) { // a managed id is a 64-digit hex name before it is joined onto the objects folder (#5305)
			return
		}
		path := filepath.Join(objectDir, it.managed)
		// Availability is the stored blob itself (stat only, never read), so
		// stale or orphaned metadata cannot report a missing object as present.
		blob, err := os.Stat(path)
		if err != nil || !blob.Mode().IsRegular() {
			return
		}
		size := blob.Size()
		it.Size, it.Available = &size, true
		if it.fromRecord { // the upload record already holds the name, the type and the digest (the sidecar is the same text): the blob's own stat above is the one check of the file (#13552)
			return
		}
		meta, ok := readArtifactSidecar(path + ".json")
		if !ok {
			return
		}
		if meta.MediaType != "" {
			it.MediaType = meta.MediaType
		}
		if it.Digest == "" {
			it.Digest = meta.Digest
		}
		if digestLikeName.MatchString(it.Name) && meta.Name != "" && !digestLikeName.MatchString(meta.Name) {
			it.Name = meta.Name
		}
	case it.Inline:
		// Already complete; content is served by ContentURL.
	default:
		// External URI: Coral does not fetch it, so only report the link.
		it.Available = strings.HasPrefix(it.URI, "http://") || strings.HasPrefix(it.URI, "https://")
		if it.Available {
			it.PreviewURL, it.DownloadURL = it.URI, it.URI
		}
	}
}

// TeamArtifactContent serves an inline task artifact as plain text.
// GET /api/board/{project}/tasks/{taskID}/artifact-content?source=completion|review&index=N
func (h *BoardHandler) TeamArtifactContent(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // through Coral Hub the owner's alone (#5575)
		return
	}
	project := urlParam(r, "project")
	taskID, err := parseID(chi.URLParam(r, "taskID"))
	if err != nil {
		errBadRequest(w, "invalid task ID")
		return
	}
	index, ok := parseBoundedInt(r.URL.Query().Get("index"), 0, 0, 1<<20)
	if !ok {
		errBadRequest(w, "invalid index")
		return
	}
	task, err := h.bs.GetTask(r.Context(), project, taskID)
	if err != nil || task == nil {
		errNotFound(w, "Task not found")
		return
	}
	var refs []board.TaskArtifact
	switch r.URL.Query().Get("source") {
	case "completion", "":
		refs = task.Workflow.Artifacts
	case "review":
		if task.Workflow.CompletionReview != nil {
			refs = task.Workflow.CompletionReview.Artifacts
		}
	default:
		errBadRequest(w, "source must be completion or review")
		return
	}
	if index >= len(refs) || refs[index].Content == "" {
		errNotFound(w, "artifact not found")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	// Already plain text; sandboxed as well, like every agent-written response.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", hubproxy.SandboxCSP)
	w.Header().Set("Content-Disposition", hubproxy.Disposition("inline", refs[index].Name))
	_, _ = w.Write([]byte(refs[index].Content))
}

// mayListSessionUploads ties a session's upload listing to the caller (#3601, weak site W27): an
// agent's token lists only its own session's uploads or those of a session on its board. The
// dashboard, the API key and Coral Hub see every session already and may list any.
func (h *BoardHandler) mayListSessionUploads(r *http.Request, sessionID string) bool {
	owner, ok := VerifiedSession(r.Context())
	if !ok || owner == nil {
		return true
	}
	if owner.SessionID != "" && owner.SessionID == sessionID {
		return true
	}
	sub, err := h.bs.GetSubscriptionBySessionName(r.Context(), owner.SessionName)
	if err != nil || sub == nil || sub.Project == "" {
		return false
	}
	sessions, err := h.bs.TeamSubscriberSessions(r.Context(), sub.Project)
	if err != nil {
		return false
	}
	for _, sid := range sessions {
		if sid == sessionID {
			return true
		}
	}
	return false
}

// teamUploadSessions maps each Coral session that belongs to the team to the
// subscriber it belongs to: every subscriber's stored session, and the session
// recorded when a team task was claimed (an agent that has since left or been
// replaced). Only these sessions' uploads appear in the team view.
func teamUploadSessions(tasks []board.TeamArtifactTask, subscribers map[string]string) map[string]string {
	out := make(map[string]string, len(subscribers))
	for _, t := range tasks {
		if t.SessionID != "" && t.AssignedTo != "" {
			out[t.SessionID] = t.AssignedTo
		}
	}
	for sub, sid := range subscribers {
		if sid != "" {
			out[sid] = sub // a subscriber's own record wins over a past claim
		}
	}
	return out
}

// sessionUpload is one parsed per-session upload record.
type sessionUpload struct {
	id  string
	rec agentUploadRecord
}

// uploadDirCache keeps each session's parsed upload records, keyed by the
// directory's modification time, so a team view over many agents stats each
// directory instead of re-reading every record on every request. A directory
// modified in the last uploadDirSettle is always re-read, so a coarse mtime
// cannot hide an upload made within the same tick. The zero value is ready.
type uploadDirCache struct {
	mu   sync.Mutex
	dirs map[string]uploadDirEntry
}

type uploadDirEntry struct {
	mod     time.Time
	uploads []sessionUpload
	files   map[string]uploadFileSig // each record file as it was read: a dir that changed re-reads only the files that did (#13292)
}

// uploadFileSig is what says a record file is as it was when it was read.
type uploadFileSig struct {
	size int64
	mod  time.Time
	up   sessionUpload
	ok   bool // the file held a record (a file that did not is remembered too, so it is not read again)
}

var uploadDirSettle = 2 * time.Second

// uploadReadWorkers is how many record files are read at once in a cold directory (#13292: 20,000 records were read one after the other, 3.85 s).
const uploadReadWorkers = 8

// uploadWarmFolders is how many folders the start-up warm reads at once (each by uploadReadWorkers readers: 16 files open at most, Security's INFO on #13292).
const uploadWarmFolders = 2

// uploadRecordReads counts every record file that was read (the server's start-up test reads it through UploadRecordReads).
var uploadRecordReads atomic.Int64

// UploadRecordReads is how many upload record files have been read by this process so far (a test seam: the start-up warm reads them before any request).
func UploadRecordReads() int64 { return uploadRecordReads.Load() }

// uploadRecordReadHook runs once for each record file that is actually read (tests count them).
var uploadRecordReadHook = func() {}

// list returns the session's upload records (nil when it has none).
func (c *uploadDirCache) list(coralDir, sessionID string) []sessionUpload {
	dir := uploadsDir(coralDir, sessionID)
	if dir == "" {
		return nil
	}
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		c.mu.Lock()
		delete(c.dirs, dir)
		c.mu.Unlock()
		return nil
	}
	mod := st.ModTime()
	settled := time.Since(mod) >= uploadDirSettle
	c.mu.Lock()
	prev, had := c.dirs[dir]
	if had && settled && prev.mod.Equal(mod) {
		c.mu.Unlock()
		return prev.uploads
	}
	c.mu.Unlock()

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	type slot struct {
		name string
		sig  uploadFileSig
		read bool // this file has to be read
	}
	slots := make([]slot, 0, len(entries))
	for _, e := range entries {
		id := strings.TrimSuffix(e.Name(), ".json")
		if e.IsDir() || id == e.Name() || len(id) != 64 {
			continue
		}
		sl := slot{name: e.Name(), read: true}
		if had {
			if info, err := e.Info(); err == nil {
				if old, ok := prev.files[e.Name()]; ok && old.size == info.Size() && old.mod.Equal(info.ModTime()) && time.Since(info.ModTime()) >= uploadDirSettle {
					sl.sig, sl.read = old, false // as it was read, and not written in the last moments
				}
			}
		}
		slots = append(slots, sl)
	}
	var wg sync.WaitGroup
	next := make(chan int)
	for w := 0; w < uploadReadWorkers; w++ {
		wg.Add(1)
		go func() {
			defer safego.Recover("upload records read")
			defer wg.Done()
			for i := range next {
				slots[i].sig = readUploadRecordFile(dir, slots[i].name)
			}
		}()
	}
	for i := range slots {
		if slots[i].read {
			next <- i
		}
	}
	close(next)
	wg.Wait()
	var uploads []sessionUpload
	files := make(map[string]uploadFileSig, len(slots))
	for _, sl := range slots {
		files[sl.name] = sl.sig
		if sl.sig.ok {
			uploads = append(uploads, sl.sig.up)
		}
	}
	// Newest first, ties by id, once per change of the folder (the cache keeps it sorted): every request merged these into the team's list and sorted 20,000 rows by their time again (#13522: 57% of a page's CPU).
	slices.SortStableFunc(uploads, func(a, b sessionUpload) int {
		if a.rec.CreatedAt != b.rec.CreatedAt {
			return strings.Compare(b.rec.CreatedAt, a.rec.CreatedAt)
		}
		return strings.Compare(a.id, b.id)
	})
	if settled {
		c.mu.Lock()
		if c.dirs == nil {
			c.dirs = make(map[string]uploadDirEntry)
		}
		c.dirs[dir] = uploadDirEntry{mod: mod, uploads: uploads, files: files}
		c.mu.Unlock()
	}
	return uploads
}

// readUploadRecordFile reads and parses one record file: the file as read (its size and time are those before the read, so a write during it is read again next time).
func readUploadRecordFile(dir, name string) uploadFileSig {
	uploadRecordReadHook()
	uploadRecordReads.Add(1)
	path := filepath.Join(dir, name)
	var sig uploadFileSig
	if info, err := os.Stat(path); err == nil {
		sig.size, sig.mod = info.Size(), info.ModTime()
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) > maxArtifactMetaBytes {
		return sig
	}
	var rec agentUploadRecord
	if json.Unmarshal(data, &rec) != nil {
		return sig
	}
	sig.up, sig.ok = sessionUpload{id: strings.ToLower(strings.TrimSuffix(name, ".json")), rec: rec}, true
	return sig
}

// warm reads every session's upload records into the cache, a few at a time, so the first artifacts read after a start is not the one that pays for the scan (#13292).
func (c *uploadDirCache) warm(coralDir string) {
	root := filepath.Join(coralDir, "artifacts", "uploads")
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	var wg sync.WaitGroup
	next := make(chan string)
	for w := 0; w < uploadWarmFolders; w++ {
		wg.Add(1)
		go func() {
			defer safego.Recover("upload records warm")
			defer wg.Done()
			for sid := range next {
				c.list(coralDir, sid)
			}
		}()
	}
	for _, e := range entries {
		if e.IsDir() {
			next <- e.Name()
		}
	}
	close(next)
	wg.Wait()
}

// merge adds the listed sessions' uploaded objects that no task result in items
// references, so an upload shows right away, before (or without) any task.
// sessions maps a session id to the subscriber shown as its producer ("" for
// none). Items already attached to a task keep their task attribution; the
// same object uploaded by two sessions is one row.
func (c *uploadDirCache) merge(items []teamArtifact, coralDir string, sessions map[string]string) []teamArtifact {
	if len(sessions) == 0 {
		return items
	}
	have := make(map[string]int, len(items))
	for i, it := range items {
		have[it.ID] = i
	}
	added := false
	sessionIDs := make([]string, 0, len(sessions))
	for sid := range sessions {
		sessionIDs = append(sessionIDs, sid)
	}
	sort.Strings(sessionIDs)
	for _, sessionID := range sessionIDs {
		producer := sessions[sessionID]
		for _, u := range c.list(coralDir, sessionID) {
			if i, ok := have[u.id]; ok {
				if items[i].SessionID == nil || *items[i].SessionID == sessionID {
					items[i].Uploader, items[i].Role, items[i].UploadedBy = u.rec.Uploader, u.rec.Role, u.rec.UploadedBy
				}
				continue
			}
			have[u.id] = len(items)
			sid := sessionID
			item := teamArtifact{
				Uploader: u.rec.Uploader, Role: u.rec.Role, UploadedBy: u.rec.UploadedBy,
				ID: u.id, Name: u.rec.Name, MediaType: u.rec.MediaType, CreatedAt: u.rec.CreatedAt, Size: sizeOfRecord(u.rec.Size),
				Source: "upload", URI: "coral://artifacts/" + u.id, Digest: u.rec.Digest,
				ReferenceCount: 1, SessionID: &sid, managed: u.id, uploadTask: u.rec.TaskID,
				fromRecord: u.rec.Name != "" && !digestLikeName.MatchString(u.rec.Name) && u.rec.MediaType != "" && u.rec.Digest != "",
			}
			if producer != "" {
				p := producer
				item.ProducedBy = &p
			}
			if u.rec.Source == sourceOperatorShare { // a file the Operator shared with the agent is the Operator's, not the agent's (#11376)
				op := board.OperatorName
				item.ProducedBy = &op
			}
			items = append(items, item)
			added = true
		}
	}
	if added {
		// Newest first; ties keep a stable order (by id) whatever the map order.
		slices.SortStableFunc(items, func(a, b teamArtifact) int {
			if a.CreatedAt != b.CreatedAt {
				return strings.Compare(b.CreatedAt, a.CreatedAt)
			}
			if a.TaskID == 0 && b.TaskID == 0 {
				return strings.Compare(a.ID, b.ID)
			}
			return 0
		})
	}
	return items
}

// ListSessionArtifacts lists the files a standalone agent (one with no team
// board) uploaded. Team agents use ListTeamArtifacts, which also covers task
// results.
// GET /api/session-artifacts?session_id=&limit=&offset=[&sort=newest|oldest|name|name_desc|size|size_asc|type|type_desc|tags|tags_desc]
func (h *BoardHandler) ListSessionArtifacts(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // through Coral Hub the owner's alone (#5575)
		return
	}
	sessionID := strings.TrimSpace(r.URL.Query().Get("session_id"))
	if sessionID == "" || len(sessionID) > 128 || querypage.HasControl(sessionID) {
		errBadRequest(w, "session_id is required")
		return
	}
	limit, ok := parseBoundedInt(r.URL.Query().Get("limit"), defaultTeamArtifactLimit, 1, maxTeamArtifactLimit)
	offset, ok2 := parseBoundedInt(r.URL.Query().Get("offset"), 0, 0, maxTeamArtifactOffset)
	if !ok || !ok2 {
		errBadRequest(w, "invalid limit or offset")
		return
	}
	if !h.mayListSessionUploads(r, sessionID) {
		writeError(w, http.StatusForbidden, "forbidden_for_agent", "an agent can list only its own uploads or those of its board's agents")
		return
	}
	items := filterReadable(r, h.coralDir, h.uploads.merge(nil, h.coralDir, map[string]string{sessionID: ""})) // #5577
	// the list's sort (#8945): the words of the team lists, over the whole list, then the page
	if sortName := strings.TrimSpace(r.URL.Query().Get("sort")); sortName != "" {
		if !validTeamArtifactSort(sortName) {
			errBadRequest(w, "unknown sort "+sortName)
			return
		}
		// Sorted on the fields the upload records hold (name, type, size, time): no sidecar is read and no blob is stat-ed for an item that is not on the page; only the page is enriched, below.
		for i := range items {
			finishTeamArtifactName(&items[i])
		}
		sort.SliceStable(items, func(i, j int) bool { return artifactAfter(sortName, keyOf(items[j]), keyOf(items[i])) })
	}
	end := offset + limit
	hasMore := end < len(items)
	if offset > len(items) {
		offset = len(items)
	}
	if end > len(items) {
		end = len(items)
	}
	page := items[offset:end]
	for i := range page {
		enrichSessionArtifact(&page[i], h.artifactObjectDir())
	}
	if page == nil {
		page = []teamArtifact{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"artifacts": page, "limit": limit, "offset": offset, "has_more": hasMore,
		"truncated": false, "session_id": sessionID,
	})
}

// linkUploadTasks gives an upload row the task its record says it is linked to (#7739): its number and title, but only when that task is on this team's board (a record's number is the
// uploader's own claim at the time, so it is checked here, where the title is read). A row that already has a task (a task result's reference) keeps it.
func (h *BoardHandler) linkUploadTasks(ctx context.Context, project string, items []teamArtifact) {
	var ids []int64
	seen := map[int64]bool{}
	for _, it := range items {
		if it.TaskID == 0 && it.uploadTask > 0 && !seen[it.uploadTask] {
			seen[it.uploadTask] = true
			ids = append(ids, it.uploadTask)
		}
	}
	if len(ids) == 0 {
		return
	}
	titles, err := h.bs.TaskTitles(ctx, project, ids)
	if err != nil {
		return
	}
	goals, _ := h.bs.TaskGoals(ctx, project, ids) // a read that fails leaves the rows without a goal, as a task with none
	for i := range items {
		if items[i].TaskID != 0 || items[i].uploadTask <= 0 {
			continue
		}
		if title, ok := titles[items[i].uploadTask]; ok {
			items[i].TaskID, items[i].TaskTitle = items[i].uploadTask, title
			if g, ok := goals[items[i].uploadTask]; ok {
				gid := g.ID
				items[i].GoalID, items[i].GoalTitle = &gid, g.Title
			}
		}
	}
}

// enrichSessionArtifact is what the standalone list does to each item of its page (a sidecar read and a stat); a test counts its calls to pin that nothing off the page is touched (#9031).
var enrichSessionArtifact = enrichTeamArtifact

// sizeOfRecord is an upload record's size as the list's size (nil when the record has none), so the size sorts need no stat of the blob.
func sizeOfRecord(n int64) *int64 {
	if n <= 0 {
		return nil
	}
	return &n
}

// addWaitsOnThis gives each "for review" row with a task what waits on that task (#11455), from one read of the board data per board: the Inbox's review rows say what they hold up without the page
// asking each team for its tasks. A row of a list that merges teams names its own board; project is the board of a list of one. A read that fails leaves the rows as they were.
func (h *BoardHandler) addWaitsOnThis(r *http.Request, project string, rows []teamArtifact) {
	if _, agent := VerifiedSession(r.Context()); agent { // an agent's token never gets other boards' task titles, on a row of its own board's list or any other (QA Engineer's MUST, #11455)
		return
	}
	if h.bs == nil || (cloud.Tunneled(r) && !hubOwnerRequest(r).owner) { // the routes are owner-only through Coral Hub already; the same guard here keeps the field from ever reaching another caller (Security, #11455)
		return
	}
	ctx := r.Context()
	byBoard := map[string][]int64{}
	for i := range rows {
		if rows[i].TaskID <= 0 || !hasTag(rows[i].Tags, "for review") {
			continue
		}
		b := rows[i].BoardID
		if b == "" {
			b = project
		}
		byBoard[b] = append(byBoard[b], rows[i].TaskID)
	}
	for b, ids := range byBoard {
		got, err := h.bs.WaitsOnTasks(ctx, b, ids)
		if err != nil {
			slog.Warn("could not read what waits on the review rows", "board", b, "error", err)
			continue
		}
		for i := range rows {
			rb := rows[i].BoardID
			if rb == "" {
				rb = project
			}
			if info, ok := got[rows[i].TaskID]; ok && rb == b && rows[i].TaskID > 0 && hasTag(rows[i].Tags, "for review") {
				v := info
				rows[i].WaitsOnThis = &v
			}
		}
	}
}

// attachArtifactPrivate marks the items the manager made private, for the owner's own read only (the person at this computer, or the Hub owner): an agent's list and a guide's never carry the mark. A failure leaves the
// marks off (the list is the same without them).
func (h *BoardHandler) attachArtifactPrivate(r *http.Request, items []teamArtifact) {
	if !ownerSeesPrivateMarks(r) {
		return
	}
	h.markPrivateArtifacts(r.Context(), items)
}

// markPrivateArtifacts puts Private on the rows whose artifact is private to the manager, whoever asks: the list kept for a walk holds it (a mark moves the revision, SetArtifactPrivate), and a caller who may not see
// the marks has them taken off its copy (hidePrivateMarks).
func (h *BoardHandler) markPrivateArtifacts(ctx context.Context, items []teamArtifact) {
	if h.bs == nil {
		return
	}
	ids := make([]string, 0, len(items))
	for _, it := range items {
		if id := artifactStoreID(it); id != "" {
			ids = append(ids, id)
		}
	}
	marks, err := h.bs.PrivateArtifacts(ctx, ids)
	if err != nil || len(marks) == 0 {
		return
	}
	for i := range items {
		if id := artifactStoreID(items[i]); id != "" && marks[id] {
			items[i].Private = true
		}
	}
}

// attachSeriesVersions puts Version and Versions on the rows of a page that are versions of a series of two or more (#11890). Nothing is read while the store has no series; a series is counted once per page.
func (h *BoardHandler) attachSeriesVersions(rows []teamArtifact, project string) {
	if h.coralDir == "" || len(rows) == 0 {
		return
	}
	if es, err := os.ReadDir(filepath.Join(h.coralDir, "artifacts", "series")); err != nil || len(es) == 0 {
		return
	}
	count := map[string]int{}
	for i := range rows {
		id := artifactStoreID(rows[i])
		if id == "" {
			continue
		}
		board := project // the same bytes can be uploaded by two teams into two series: the row is its own team's (all-teams rows say theirs)
		if board == "" {
			board = rows[i].Team
		}
		sid, n, ok := digestSeriesOnBoard(h.coralDir, id, board)
		if !ok {
			continue
		}
		c, seen := count[sid]
		if !seen {
			c = len(seriesMembers(h.coralDir, sid))
			count[sid] = c
		}
		if c > 1 {
			rows[i].Version, rows[i].Versions = n, c
		}
	}
}

// WarmUploads reads every session's upload records into the board handler's cache (called once after a start, in the background).
func (h *BoardHandler) WarmUploads() { h.uploads.warm(h.coralDir) }
