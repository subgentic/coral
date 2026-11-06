package tunnel

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #5610: one table says which routes are the owner's. The connector stamps the marker from it, and these tests hold it to what the hand-written lists said before (the oracle) and to the real
// connector (a stream's marker reaches every owner route for an owner and none for anyone else).

// oldIsOwnerRoute is the hand-written list this table replaced (hubrole.go at #5575 and #5572), kept here as the oracle.
func oldIsOwnerRoute(method, p string) bool {
	boardSettings := regexp.MustCompile(`^/api/board/[^/]+/settings$`)
	artifactRead := regexp.MustCompile(`^/api/artifacts(/[0-9a-f]{64}(/(meta|comments|readers))?)?$`)
	artifactDelete := regexp.MustCompile(`^/api/artifacts/[0-9a-f]{64}$`)
	teamArtifacts := regexp.MustCompile(`^/api/board/[^/]+/(artifacts|tasks/[0-9]+/artifact-content)$`)
	switchRoute := regexp.MustCompile(`^/api/board/[^/]+/cross-team/(files/)?(enable|disable)$`)
	if (method == http.MethodGet && p == "/api/system/update") || (method == http.MethodPost && p == "/api/system/update/relaunch") {
		return true
	}
	switch method {
	case http.MethodGet:
		return p == "/api/settings/prompt-inspection" || boardSettings.MatchString(p) || p == "/api/session-artifacts" || p == "/api/team-artifacts" || artifactRead.MatchString(p) || teamArtifacts.MatchString(p)
	case http.MethodPut:
		return boardSettings.MatchString(p)
	case http.MethodDelete:
		return artifactDelete.MatchString(p)
	case http.MethodPost:
		return switchRoute.MatchString(p)
	}
	return false
}

// instances turns a table pattern into concrete paths.
func instances(pattern string) []string {
	hex := strings.Repeat("a", 64)
	var out []string
	for _, id := range []string{"12", "x"} {
		p := strings.NewReplacer("{hex64}", hex).Replace(pattern)
		segs := strings.Split(p, "/")
		for i, s := range segs {
			if strings.HasPrefix(s, "{") {
				segs[i] = map[bool]string{true: "team", false: id}[s == "{project}"]
			}
		}
		out = append(out, strings.Join(segs, "/"))
	}
	return out
}

func TestTheOwnerTableAgreesWithTheHandWrittenListItReplaced(t *testing.T) {
	hex := strings.Repeat("a", 64)
	paths := []string{
		"/api/artifacts", "/api/artifacts/" + hex, "/api/artifacts/" + hex + "/meta", "/api/artifacts/" + hex + "/comments", "/api/artifacts/" + hex + "/readers", "/api/artifacts/" + hex[:63], "/api/artifacts/" + strings.ToUpper(hex),
		"/api/artifacts/" + hex + "/keep", "/api/artifacts/" + hex + "/x", "/api/session-artifacts", "/api/team-artifacts", "/api/board/team/artifacts", "/api/board/team/artifacts/x", "/api/board/a/b/artifacts",
		"/api/board/team/tasks/12/artifact-content", "/api/board/team/settings", "/api/board//settings", "/api/board/a/b/settings", "/api/board/team/settings/x", "/api/board/team/status",
		"/api/board/team/cross-team/enable", "/api/board/team/cross-team/disable", "/api/board/team/cross-team/files/enable", "/api/board/team/cross-team/files/disable",
		"/api/hub-auto-accept", "/api/hub-auto-accept/enable", "/api/hub-auto-accept/x",
		"/api/board/team/cross-team/toggle", "/api/board/team/cross-team/files", "/api/board/team/cross-team/enable/x", "/api/settings/prompt-inspection", "/api/settings/default-prompts",
		"/api/settings", "/api/system/update", "/api/system/update/relaunch", "/api/system/update/", "/api/system/update-check", "/api/system/hub-operator", "/api/health",
		"/api/sessions/live", "/api/cloud/hub-cross-team",
	}
	for _, r := range RoutePatterns() {
		parts := strings.Fields(r)
		paths = append(paths, instances(parts[1])...)
	}
	methods := []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch, http.MethodHead}
	compared, owners := 0, 0
	for _, p := range paths {
		for _, m := range methods {
			compared++
			want := oldIsOwnerRoute(m, p)
			got := IsOwnerRoute(m, p)
			if m == http.MethodHead { // the table treats HEAD as GET; the old list never saw one
				continue
			}
			// The owner's switch for Coral Hub auto-accept (#5840) is new: the old list never had it.
			if m == http.MethodPost && p == "/api/hub-auto-accept" {
				continue
			}
			// The owner's Dismiss of an agent's stale wait (#11352) is new: the old list never had it.
			if m == http.MethodPost && strings.HasPrefix(p, "/api/sessions/live/") && strings.HasSuffix(p, "/dismiss-wait") {
				continue
			}
			// The live list is an OwnerSees route since #12377 (the owner's rows carry waits_on_this): the old list never had it.
			if m == http.MethodGet && p == "/api/sessions/live" {
				continue
			}
			// The owner's switch of one agent's auto-sleep (#12111) is new: the old list never had it.
			if m == http.MethodPost && strings.HasPrefix(p, "/api/sessions/live/") && strings.HasSuffix(p, "/auto-sleep") {
				continue
			}
			// The owner's read of one team's cross-team state (#5636) is new: the old list never had it.
			if m == http.MethodGet && strings.HasSuffix(p, "/cross-team/settings") {
				continue
			}
			// The custom models (#5996) are the owner's alone through the hub: the old list never had them.
			if p == "/api/custom-models" && (m == http.MethodGet || m == http.MethodPut) {
				continue
			}
			// Resolving a shortened artifact link (#9841) is the owner's alone through the hub: the old list never had it.
			if m == http.MethodGet && p == "/api/artifacts/resolve" {
				continue
			}
			// Starring an artifact (#9819) is the owner's alone through the hub: the old list never had it.
			if strings.HasPrefix(p, "/api/artifacts/") && strings.HasSuffix(p, "/star") && (m == http.MethodPut || m == http.MethodDelete) {
				continue
			}
			// Saved for later is the owner's alone since #5753 and #5763 (the list, the whole message of a bookmark, and the changes): the old list never had them.
			if p == "/api/saved" || strings.HasPrefix(p, "/api/saved/") && (m == http.MethodGet && strings.HasSuffix(p, "/message") || m == http.MethodPatch || m == http.MethodDelete) {
				continue // every saved-for-later route (#5763): the list, the whole message, and the changes
			}
			// What agents asked to add to a team, and the Operator's decision on it (#11389), are the owner's alone through the hub: the old list never had them.
			if strings.HasPrefix(p, "/api/board/") && strings.Contains(p, "/proposals") || p == "/api/proposals" {
				continue
			}
			// The activity counts of the Analytics tabs (#11225) are the owner's alone through the hub: the old list never had them.
			if (m == http.MethodGet && (p == "/api/operator-asks" || p == "/api/needs-you" || p == "/api/activity")) || (strings.HasPrefix(p, "/api/board/") && (strings.HasSuffix(p, "/orchestrator-grant") && (m == http.MethodGet || m == http.MethodPut) || strings.HasSuffix(p, "/lifecycle-log") && m == http.MethodGet || strings.HasSuffix(p, "/guide-roster") && (m == http.MethodGet || m == http.MethodPut)) || strings.HasPrefix(p, "/api/artifacts/") && strings.HasSuffix(p, "/private")) { // the owner-only routes of #11417 and #11432: the old list never had them
				continue
			}
			if m == http.MethodGet && p == "/api/analytics/activity" {
				continue
			}
			// The owner's version list and series reads, comment edit, delete and lock, and the change-request send are the owner's alone through the hub (#11354): the old list never had them.
			if strings.HasPrefix(p, "/api/artifacts/") && (strings.HasSuffix(p, "/versions") || strings.Contains(p, "/artifacts/series/") || strings.Contains(p, "/comments/")) {
				continue
			}
			// Approving a for-review artifact, or asking changes of it, is the owner's alone through the hub (#136584, #11354): the old list never had it.
			if m == http.MethodPost && strings.HasPrefix(p, "/api/board/") && strings.HasSuffix(p, "/review") && strings.Contains(p, "/artifacts/") {
				continue
			}
			// Marking a file read (the artifact's tags write, #12742) is the owner's alone through the hub: the old list never had it.
			if m == http.MethodPut && strings.HasPrefix(p, "/api/board/") && strings.HasSuffix(p, "/tags") && strings.Contains(p, "/artifacts/") {
				continue
			}
			// Using a button an agent put on a question (#11643) is the owner's alone through the hub: the old list never had it.
			if m == http.MethodPost && strings.HasPrefix(p, "/api/board/") && strings.Contains(p, "/asks/") && strings.Contains(p, "/buttons/") {
				continue
			}
			// Ignore and Undo of a question in the owner's Needs you table drawn on the Hub (#13446, #13450) are the owner's alone through the hub: the old list never had them.
			if m == http.MethodPost && strings.HasPrefix(p, "/api/board/") && strings.Contains(p, "/asks/") && strings.HasSuffix(p, "/close") {
				continue
			}
			// Sharing a file with an agent as the Operator (#11376) is the owner's alone through the hub: the old list never had it.
			if m == http.MethodPost && strings.HasPrefix(p, "/api/board/") && (strings.HasSuffix(p, "/operator-artifacts") || strings.HasSuffix(p, "/operator-artifacts/message")) {
				continue
			}
			// The Markdown editor's capability read and save (#13757) are the owner's alone through the hub: the old list never had them.
			if strings.HasPrefix(p, "/api/board/") && strings.Contains(p, "/artifacts/") && (strings.HasSuffix(p, "/edit") || strings.HasSuffix(p, "/edit/send")) {
				continue
			}
			// Pausing and resuming Coral's notices to an agent (#11387) are the owner's alone: the old list never had them.
			if m == http.MethodPost && strings.HasPrefix(p, "/api/sessions/live/") && (strings.HasSuffix(p, "/notices/pause") || strings.HasSuffix(p, "/notices/resume")) {
				continue
			}
			// The routes that can start a new board carry the marker (#11627): the old list never had them.
			if (m == http.MethodPost && regexp.MustCompile(`^/api/board/[^/]+/(messages|subscribe|tasks|goals|working-mode/presets)$`).MatchString(p)) || (m == http.MethodPut && regexp.MustCompile(`^/api/board/[^/]+/working-mode$`).MatchString(p)) {
				continue
			}
			// A picture for a new goal's description (#11650) is the owner's alone: the old list never had it.
			if m == http.MethodPost && strings.HasPrefix(p, "/api/board/") && (strings.HasSuffix(p, "/goal-images") || strings.HasSuffix(p, "/goals")) { // and the goal create, which names them
				continue
			}
			// The Operator's change of a goal's driver and its move to another team (#13517) are the owner's alone through the hub: the old list never had them.
			if m == http.MethodPost && regexp.MustCompile(`^/api/board/[^/]+/goals/[^/]+/(driver|move)$`).MatchString(p) {
				continue
			}
			// Asking this computer to check for an update (#13258) is the owner's alone through the hub: the old list never had it.
			if m == http.MethodPost && p == UpdateCheckPath {
				continue
			}
			// Chief's state (#11470) is the owner's alone through the hub: the old list never had it.
			if m == http.MethodGet && p == "/api/chief" {
				continue
			}
			// The owner's comment writes (a comment or reply, a resolve, a reopen) are new (#7052): the old list never had them.
			if m == http.MethodPost && strings.HasPrefix(p, "/api/artifacts/") && (strings.HasSuffix(p, "/comments") || strings.HasSuffix(p, "/resolve") || strings.HasSuffix(p, "/reopen") || strings.HasSuffix(p, "/comment-images")) {
				continue
			}
			// Sending a file for review and taking it out again (#13217) is the owner's alone: the old list never had it.
			if (m == http.MethodPut || m == http.MethodDelete) && strings.HasPrefix(p, "/api/board/") && strings.HasSuffix(p, "/review") {
				continue
			}
			// The one difference of #5610: the table's {id} is any one segment, so a task artifact-content path with a non-number id is stamped too (its handler refuses it).
			if strings.HasPrefix(p, "/api/board/") && strings.HasSuffix(p, "/artifact-content") && m == http.MethodGet {
				continue
			}
			assert.Equal(t, want, got, "%s %s", m, p)
			if got {
				owners++
			}
		}
	}
	assert.Greater(t, compared, 500, "the comparison must not go blind")
	assert.Greater(t, owners, 15, "and must meet the owner routes")
}

func TestEveryOwnerRouteIsInTheTableWithATierAndAMode(t *testing.T) {
	routes := OwnerRoutes()
	require.GreaterOrEqual(t, len(routes), 16, "the owner routes of #5307, #5280, #5575 and #5572")
	seen := map[string]bool{}
	for _, r := range routes {
		key := r.Method + " " + r.Pattern
		assert.False(t, seen[key], "listed twice: %s", key)
		seen[key] = true
		assert.NotEqual(t, TierNever, r.Tier, key)
		assert.True(t, r.Mode.Stamped(), key)
		// the table classifies the route the way it lists it
		p := instances(r.Pattern)[0]
		pattern, mode := OwnerRoute(r.Method, p)
		assert.Equal(t, r.Pattern, pattern, key)
		assert.Equal(t, r.Mode, mode, key)
		assert.Equal(t, r.Tier, Classify(r.Method, p, ""), key)
	}
	// the update status keeps its label optional (the handler decides what a non-owner sees); the relaunch, which installs and restarts a computer, refuses a non-owner before the handler and needs the label (#13258)
	_, m := OwnerRoute(http.MethodGet, UpdateStatusPath)
	assert.Equal(t, OwnerUpdate, m)
	assert.False(t, m.LabelRequired())
	assert.False(t, m.Refuses())
	_, m = OwnerRoute(http.MethodPost, UpdateRelaunchPath)
	assert.Equal(t, OwnerRefuse, m)
	assert.True(t, m.LabelRequired())
	assert.True(t, m.Refuses())
	_, m = OwnerRoute(http.MethodGet, "/api/artifacts")
	assert.True(t, m.LabelRequired())
	assert.True(t, m.Refuses())
	_, m = OwnerRoute(http.MethodGet, "/api/board/team/settings")
	assert.True(t, m.LabelRequired())
	assert.False(t, m.Refuses(), "the handler decides what a non-owner sees of the settings")
}

// Through the real connector: an owner stream gets the marker and the hub user on EVERY owner route of the table, a grantee's stream (with the marker forged on the request) gets none, and a
// route that is not an owner route gets none even for an owner. This is the census that would have caught #5575's artifact routes.
func TestTheRealConnectorStampsEveryOwnerRouteOfTheTableAndNothingElse(t *testing.T) {
	var mu sync.Mutex
	type seen struct{ method, path, role, user string }
	var got []seen
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = append(got, seen{r.Method, r.URL.Path, r.Header.Get(HubRoleHeader), r.Header.Get(HubUserHeader)})
		mu.Unlock()
		w.WriteHeader(200)
	})
	hub := newHub(t, fastCfg())
	launch := func() Mode { return TierLaunch }
	sess, _ := connect(t, hub, local, func(l *LocalHandler) {
		l.MaxMode = launch
		l.AllowPath = nil
		l.AllowRequest = AllowRequest(launch)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	owner := WithHubUser(WithHubRole(WithHubTier(ctx, "launch"), "owner"), "hub-user-1234abcd")
	grantee := WithHubUser(WithHubTier(ctx, "launch"), "hub-user-9999ffff")
	forged := http.Header{"X-Coral-Hub-Role": {"owner"}, "x-coral-hub-role": {"owner"}}
	do := func(c context.Context, method, path string, hdr http.Header) {
		t.Helper()
		req, _ := http.NewRequestWithContext(c, method, "http://x"+path, strings.NewReader("{}"))
		for k, vs := range hdr {
			req.Header[k] = vs
		}
		resp, err := sess.RoundTrip(req)
		require.NoError(t, err, "%s %s", method, path)
		resp.Body.Close()
	}
	routes := OwnerRoutes()
	for _, r := range routes {
		p := instances(r.Pattern)[0]
		do(owner, r.Method, p, nil)
		do(grantee, r.Method, p, forged)
	}
	do(owner, http.MethodGet, "/api/board/team/status", forged) // not an owner route
	do(owner, http.MethodPost, "/api/board/team/tasks/12/complete", forged)
	mu.Lock()
	defer mu.Unlock()
	require.Len(t, got, 2*len(routes)+2)
	for i, r := range routes {
		o, g := got[2*i], got[2*i+1]
		assert.Equal(t, "owner", o.role, "%s %s: an owner stream", r.Method, r.Pattern)
		assert.Equal(t, "hub-user-1234abcd", o.user, "%s %s", r.Method, r.Pattern)
		assert.Empty(t, g.role, "%s %s: a grantee's stream, the forged marker dropped", r.Method, r.Pattern)
	}
	assert.Empty(t, got[len(got)-2].role, "not an owner route")
	assert.Empty(t, got[len(got)-1].role, "a write route that is not an owner route")
}

// #12377 (coral-hub's question): waits_on_this (what an agent's work blocks, #11455) never reached a Hub dashboard because GET /api/sessions/live was not an owner route, so the connector never stamped the owner marker on
// it and the machine could not tell the owner from a viewer. The list is an OwnerSees route: everyone still gets the list (nobody is refused, no owner label is required to read it), the stamped owner also gets the owner-only fields.
func TestTheLiveSessionListIsAnOwnerSeesRouteAndNothingAroundItChanged(t *testing.T) {
	pattern, mode := OwnerRoute(http.MethodGet, "/api/sessions/live")
	assert.Equal(t, "/api/sessions/live", pattern)
	assert.Equal(t, OwnerSees, mode, "stamped, and the handler decides what a non-owner gets")
	assert.True(t, IsOwnerRoute(http.MethodGet, "/api/sessions/live"), "so the connector stamps it")
	assert.False(t, mode.Refuses(), "a viewer or grantee still gets the list")
	assert.False(t, mode.RefusesLocal(), "and so does this computer's own dashboard")
	assert.Equal(t, TierView, Classify(http.MethodGet, "/api/sessions/live", ""), "it is still a view read")
	// the routes beside it are untouched: one agent's pages, its chat and the rest of the list's family are not owner routes
	for _, p := range []string{"/api/sessions/live/claude-x", "/api/sessions/live/claude-x/chat", "/api/sessions/live/claude-x/poll", "/api/sessions/live/claude-x/info", "/api/sessions/live/claude-x/capture"} {
		assert.False(t, IsOwnerRoute(http.MethodGet, p), p)
	}
	// only the read: nothing else on the exact path is an owner route
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		assert.False(t, IsOwnerRoute(m, "/api/sessions/live"), m)
	}
}
