package server

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #13860: what the dashboard (the shell) does when a route it calls is "never" for a Coral Hub machine.
//
// The tunnel's table (pkg/tunnel/routes.go) refuses a route that is tier never before the computer is asked, and a route that is not in the table is never too. A control whose read is never
// either vanishes or waits for ever through a Hub with no word said (the skills picker, Open in editor and the automation queue were found this way). This census reads every "/api/..." string
// the shell's own scripts (pkg/frontend/static, all folders) call, finds each one's tier in the table, and fails when a never route is called with no listed behaviour for that file.
//
// What it SEES: a string literal (', " or `) that starts with /api/, the method named in the same call (a method: 'X' option, a get/post/put/patch/del helper, or a first argument 'X'), the
// route part of the string ("${x}" stands for one segment). A route in the table that a Hub could still refuse for its QUERY is not seen unless the query is written out.
//
// What it CANNOT see (so this is not a claim of full coverage): a URL built in pieces (base + '/x', a variable, a path read from a server answer or a data attribute), a call whose method is a
// variable, a route reached by a helper the census has no name for, a script the page builds as text, and whether the behaviour the entry names is really what the file does on screen: the
// entry's marker is a text the file must still contain, not a proof that the control works. A new way of calling the server is invisible until a sentence of it is added here.
//
// A behaviour is one of: explains (the shell shows the reason, or the Hub's own refusal, on screen), hidden (the control is not drawn through a Hub), incomplete (the view is marked incomplete),
// local (only reached on this computer's own dashboard; a Hub never gets there), and broken (the worklist: the control vanishes or hangs; the entry names the task that fixes it).

type shellBehaviour string

const (
	bExplains   shellBehaviour = "explains"
	bHidden     shellBehaviour = "hidden"
	bIncomplete shellBehaviour = "incomplete"
	bLocal      shellBehaviour = "local"
	bBroken     shellBehaviour = "broken"
	bUnreviewed shellBehaviour = "unreviewed" // nobody has read what the script does through a Hub yet
)

// shellNever: one line per (script, method and route) the shell calls that is never for a Hub. marker is a regexp the script must still match (the text that carries the behaviour).
type shellNever struct {
	behaviour shellBehaviour
	marker    string
	note      string
	calls     int // file-wide entries: how many never calls the script has; one more is a new call nobody has looked at
}

// shellNeverRoutes: a never route one script calls, with what it does today. The key is "script METHOD route" with {} for a variable segment.
var shellNeverRoutes = map[string]shellNever{
	"launch_skills.js GET /api/skills":                          {bBroken, `requestJson\('GET', '/api/skills\?status=approved'\)`, "the skills picker of a launch is read from the computer that holds them; through a Hub the read is refused, the catch returns, and the row stays hidden with no word (#13860 worklist: say why, or read the skills a Hub may see)", 0},
	"chat_bubbles.js GET /api/system/editors":                   {bBroken, `r\.ok \? r\.json\(\) : \{ editors: \[\] \}`, "Open in editor asks which editors the host has; a refused read is an empty list, so the control vanishes with no word (#13860 worklist)", 0},
	"chat_bubbles.js POST /api/sessions/live/{}/open-in-editor": {bBroken, `open-in-editor`, "never through a Hub; unreachable today because the editors list above is empty, so the refusal text is never shown (#13860 worklist)", 0},
	"automations_queue.js GET /api/resources":                   {bBroken, `fetch\('/api/resources'\)`, "the Queue folder reads with a bare fetch; a refused or wrong-machine read returns silently and the folder stays on 'Reading the queue.' (#13860 worklist)", 0},
	"automations_queue.js POST /api/resources/entries/{}/move":  {bBroken, `/api/resources/entries/`, "no row ever loads through a Hub, so the move cannot be clicked (follows the read above)", 0},
	"automations_queue.js DELETE /api/resources/entries/{}":     {bBroken, `/api/resources/entries/`, "no row ever loads through a Hub, so the remove cannot be clicked (follows the read above)", 0},
	"needs_skills.js GET /api/skills":                           {bHidden, `the Hub's Inbox`, "no pending-skills row from this read through a Hub; the Hub's skill rows come from GET /api/needs-you (kind skill), read-only", 0},
}

// shellNeverFiles: every other never call of a script that nobody has read yet for what it does through a Hub. This is the starting list of #13860 ("what is true today"): it is a worklist, and
// it may only shrink (shellUnreviewedMax). Move a script out by giving its calls a behaviour in shellNeverRoutes, or a file-wide one here.
var shellNeverFiles = map[string]shellNever{
	"account_info.js":           {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"analytics_efficiency.js":   {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"analytics_tabs.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"artifact_star.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"automation_runs.js":        {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"board_launches.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"changed_files.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"chat_import.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"chief_checks_api.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 6},
	"chief_setup.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"cloud.js":                  {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"cloud/enroll.js":           {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"cloud_connect.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 12},
	"cloud_server_view.js":      {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"controls.js":               {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"custom_views.js":           {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"dashboard_analytics.js":    {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"default_prompts_dialog.js": {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"docs.js":                   {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"editions.js":               {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"folder_tags.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"goal_done.js":              {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"goal_write.js":             {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"hub_indicator.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"hub_mode_setting.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"hub_notice.js":             {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 4},
	"hub_pending.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"inbox_sidebar.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"info_dialog.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"job_form.js":               {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"launch_dialog.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"launch_models.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"list_display_settings.js":  {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"list_order.js":             {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"local_auth_banner.js":      {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"mailbox_chats.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"mobile_connect.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 6},
	"notes.js":                  {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"notice_pause.js":           {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"password_ui.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"received_cap_notice.js":    {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"registered_server_view.js": {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 6},
	"scheduler.js":              {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 3},
	"search_access.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"security_settings.js":      {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 9},
	"server_access.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"server_base.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"server_controller.js":      {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"server_owner_secret.js":    {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"server_ssh_setup.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 7},
	"sessions.js":               {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"settings_codex_hooks.js":   {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"settings_core.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 3},
	"settings_dialog.js":        {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"settings_fill.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 3},
	"settings_lists.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"settings_machine.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 3},
	"settings_save.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"settings_storage.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 11},
	"setup_code_setting.js":     {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"shared_images.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"signed_out.js":             {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"skill_mention.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"skills_tab.js":             {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 6},
	"startup_status.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"system_status.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"tags.js":                   {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"task_detail.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"team_artifacts_page.js":    {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 3},
	"team_cross_team_fields.js": {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"team_dialogs.js":           {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"team_link_dialog.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 6},
	"team_link_flag.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"team_settings_page.js":     {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"team_wizard.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"template_browser.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"terminal_backend.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 8},
	"theme_config.js":           {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 5},
	"update_api.js":             {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 8},
	"update_check.js":           {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"view_sandbox.js":           {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 3},
	"waiting.js":                {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"welcome_items.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"workflow_agent.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"workflows.js":              {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"worktrees_panel.js":        {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"xterm_renderer.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
}

const shellUnreviewedMax = 87

type shellCall struct {
	file, method, route, raw string
	bare                     bool // fetch( straight onto the literal: no serverUrl, serverFetch or helper names the machine
}

var (
	apiLiteralRe = regexp.MustCompile("(?s)(?:'(/api/[^'\\n]*)'|\"(/api/[^\"\\n]*)\"|`(/api/[^`\\n]*)`)")
	tmplExprRe   = regexp.MustCompile(`\$\{(?:[^{}]|\{[^{}]*\})*\}`)
	methodOptRe  = regexp.MustCompile(`method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]`)
	methodArgRe  = regexp.MustCompile(`['"](GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*$`)
	bareFetchRe  = regexp.MustCompile(`\bfetch\(\s*$`)
	helperRe     = regexp.MustCompile(`\b(post|postJson|put|putJson|patch|patchJson|del|delJson|deleteJson)\(\s*$`)
)

var helperMethod = map[string]string{"post": "POST", "postJson": "POST", "put": "PUT", "putJson": "PUT", "patch": "PATCH", "patchJson": "PATCH", "del": "DELETE", "delJson": "DELETE", "deleteJson": "DELETE"}

// shellCalls is every /api/ literal in the shell's scripts with the method found around it. Prefix tests ("startsWith('/api/')") and a bare "/api/" are not calls.
func shellCalls(t *testing.T) (calls []shellCall, unsure int) {
	t.Helper()
	root := "../../pkg/frontend/static"
	require.NoError(t, filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".js") {
			return err
		}
		b, rerr := os.ReadFile(p)
		require.NoError(t, rerr)
		src := string(b)
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		for _, m := range apiLiteralRe.FindAllStringSubmatchIndex(src, -1) {
			raw := ""
			for g := 1; g <= 3; g++ {
				if m[2*g] >= 0 {
					raw = src[m[2*g]:m[2*g+1]]
				}
			}
			route := tmplExprRe.ReplaceAllString(raw, placeholder)
			if i := strings.IndexAny(route, "?#"); i >= 0 {
				route = route[:i]
			}
			if strings.Contains(route, "...") || strings.ContainsAny(route, "{}") || strings.Contains(route, "${") {
				unsure++ // a pattern written in a comment or a string, or a path built in pieces
				continue
			}
			if partSegment(route) {
				unsure++ // a segment that is partly a variable ("notes${suffix}"): the route cannot be told
				continue
			}
			if strings.Contains(route, placeholder+"/"+placeholder) || strings.HasSuffix(route, "/"+placeholder) && strings.Count(route, placeholder) > 1 {
				unsure++ // the route word itself is a variable ("live/${name}/${action}")
				continue
			}
			if route == "/api/" || strings.HasSuffix(route, "/") && !strings.Contains(raw, "${") {
				continue // a prefix test or a directory, not a call
			}
			before := src[max(0, m[0]-40):m[0]]
			after := src[m[1]:min(len(src), m[1]+260)]
			if i := strings.Index(after, "/api/"); i >= 0 {
				after = after[:i] // the next call's own options
			}
			method := "GET"
			switch {
			case methodArgRe.MatchString(before):
				method = methodArgRe.FindStringSubmatch(before)[1]
			case helperRe.MatchString(before):
				method = helperMethod[helperRe.FindStringSubmatch(before)[1]]
			case methodOptRe.MatchString(after):
				method = methodOptRe.FindStringSubmatch(after)[1]
			case regexp.MustCompile(`method\s*:\s*[^'"\s]`).MatchString(after[:min(len(after), 120)]):
				unsure++
			}
			calls = append(calls, shellCall{rel, method, route, raw, bareFetchRe.MatchString(before)})
		}
		return nil
	}))
	return calls, unsure
}

// partSegment: a path segment that holds the placeholder among other characters.
func partSegment(route string) bool {
	for _, seg := range strings.Split(route, "/") {
		if seg != placeholder && strings.Contains(seg, placeholder) {
			return true
		}
	}
	return false
}

const placeholder = "__V__"

// hubPath turns a route found in a script into a path the table can be asked about (an artifact is named by a full content digest).
func hubPath(route string) string {
	route = strings.ReplaceAll(route, placeholder, "x")
	if strings.HasPrefix(route, "/api/artifacts/x") {
		return strings.Replace(route, "/api/artifacts/x", "/api/artifacts/"+strings.Repeat("a", 64), 1)
	}
	return route
}

func neverKey(c shellCall) string {
	return c.file + " " + c.method + " " + strings.ReplaceAll(c.route, placeholder, "{}")
}

func readShell(t *testing.T, file string) string {
	t.Helper()
	b, err := os.ReadFile("../../pkg/frontend/static/" + file)
	require.NoError(t, err)
	return string(b)
}

func TestEveryNeverRouteTheShellCallsHasAListedBehaviour(t *testing.T) {
	calls, unsure := shellCalls(t)
	require.Greater(t, len(calls), 300, "the census found too few calls: the reading is broken")
	seen := map[string]bool{}
	var unlisted, never []string
	routeUsed, fileUsed := map[string]bool{}, map[string]int{}
	for _, c := range calls {
		_, tier, ok := tunnel.RuleFor(c.method, hubPath(c.route))
		if ok && tier != tunnel.TierNever {
			continue
		}
		key := neverKey(c)
		if seen[key] {
			continue
		}
		seen[key] = true
		never = append(never, key)
		if _, listed := shellNeverRoutes[key]; listed {
			routeUsed[key] = true
		} else if _, listed := shellNeverFiles[c.file]; listed {
			fileUsed[c.file]++
		} else {
			unlisted = append(unlisted, key)
		}
	}
	sort.Strings(never)
	t.Logf("%d calls read, %d more not readable (a route built in pieces, a method held in a variable), %d never calls:\n%s", len(calls), unsure, len(never), strings.Join(never, "\n"))
	sort.Strings(unlisted)
	require.Empty(t, unlisted, "the shell calls a route that is never through a Coral Hub, and no behaviour is listed for it. Add it to shellNeverRoutes with what the script does (explains, hidden, incomplete, local) or, if it vanishes or hangs, as broken with the task that fixes it")
	for key, e := range shellNeverRoutes {
		require.True(t, routeUsed[key], "%s is listed but the shell no longer calls it as never: delete the entry", key)
		file, _, _ := strings.Cut(key, " ")
		require.Regexp(t, e.marker, readShell(t, file), "%s: the text that carries its behaviour (%s) is gone", key, e.behaviour)
		require.NotEmpty(t, e.note, key)
	}
	unreviewed := 0
	var countOff []string
	for file, e := range shellNeverFiles {
		require.NotZero(t, fileUsed[file], "%s is listed but has no never call any more: delete the entry", file)
		if e.calls != fileUsed[file] {
			countOff = append(countOff, fmt.Sprintf("%s: listed %d, found %d", file, e.calls, fileUsed[file]))
		}
		require.NotEmpty(t, e.note, file)
		if e.behaviour == bUnreviewed {
			unreviewed++
		} else {
			require.Regexp(t, e.marker, readShell(t, file), "%s: the text that carries its behaviour (%s) is gone", file, e.behaviour)
		}
	}
	sort.Strings(countOff)
	require.Empty(t, countOff, "a script has a different number of never calls than listed: a new one nobody has looked at, or one fixed (lower the count, and the unreviewed ceiling if it is now clean)")
	require.LessOrEqual(t, unreviewed, shellUnreviewedMax, "the unreviewed list grew: a script that calls a never route needs a behaviour, not a place on the worklist")
}

// A bare fetch('/api/...') asks the page's own origin. Through a Hub that is the Hub, not the machine the Operator is looking at, so a route that belongs to one computer (its agents, boards, queue)
// is wrong or refused there (the Wake chip, the Queue folder). serverUrl or serverFetch names the machine. Today's bare calls to such a route are listed; the list may only shrink.
var perComputerPrefixes = []string{"/api/sessions/live", "/api/sessions/launch", "/api/board/", "/api/resources", "/api/teams", "/api/tasks", "/api/scheduled", "/api/workflows"}

var shellBareFetches = map[string]string{
	"automations_queue.js GET /api/resources":                      "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"board_export.js GET /api/sessions/live":                       "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"board_fetch.js GET /api/board/projects":                       "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"cost_dashboard.js GET /api/board/tasks":                       "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"guide_names.js GET /api/board/{}/guide-roster":                "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"job_form.js GET /api/scheduled/jobs/{}":                       "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"job_form.js GET /api/workflows":                               "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"job_form.js POST /api/scheduled/jobs/init-repo":               "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"job_form.js POST /api/scheduled/validate-cron":                "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"operator_asks.js GET /api/board/{}/subscribers":               "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"operator_asks.js POST /api/sessions/live/{}/wake":             "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"resume_dialog.js POST /api/sessions/launch":                   "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"scheduler.js DELETE /api/scheduled/jobs/{}":                   "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"scheduler.js GET /api/scheduled/jobs":                         "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"scheduler.js GET /api/scheduled/jobs/{}/runs":                 "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"scheduler.js GET /api/workflows":                              "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"scheduler.js GET /api/workflows/{}/runs":                      "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"scheduler.js POST /api/scheduled/jobs/{}/run":                 "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"scheduler.js POST /api/scheduled/jobs/{}/toggle":              "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"team_wizard.js GET /api/teams/generate/{}":                    "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"team_wizard.js POST /api/teams/generate":                      "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"terminal_backend.js POST /api/sessions/live/{}/refresh-hooks": "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"terminal_backend.js POST /api/sessions/live/{}/wake":          "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"view_sandbox.js GET /api/sessions/live":                       "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"workflow_agent.js POST /api/sessions/launch":                  "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
}

const shellBareFetchesMax = 25

func TestBareFetchesToAComputersRoutesAreListed(t *testing.T) {
	calls, _ := shellCalls(t)
	got := map[string]bool{}
	for _, c := range calls {
		if !c.bare {
			continue
		}
		for _, p := range perComputerPrefixes {
			if strings.HasPrefix(c.route, p) {
				got[neverKey(c)] = true
			}
		}
	}
	var keys, unlisted []string
	for k := range got {
		keys = append(keys, k)
		if _, ok := shellBareFetches[k]; !ok {
			unlisted = append(unlisted, k)
		}
	}
	sort.Strings(keys)
	sort.Strings(unlisted)
	t.Logf("%d bare fetches of a computer's routes:\n%s", len(keys), strings.Join(keys, "\n"))
	require.Empty(t, unlisted, "a bare fetch of a route that belongs to one computer: use serverUrl or serverFetch with the machine, or list it in shellBareFetches with why it is this computer only")
	require.LessOrEqual(t, len(shellBareFetches), shellBareFetchesMax, "the list of bare fetches grew")
	for k := range shellBareFetches {
		require.True(t, got[k], "%s is listed but is no longer a bare fetch: delete the entry", k)
	}
}
