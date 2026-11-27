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
	"second_hub_join.js POST /api/servers/join":                            {bLocal, `await call\('POST', '/api/servers/join'`, "Add computer's second-Hub join is the self-hosted Hub's own page: registered_server_view.js draws it only on a Hub's Servers tab, the routes are that Hub's own and never go through another; a refused start (SSH unreachable, a key refused) is said on the same panel with the server's reason and the fields kept (#21221)", 0},
	"second_hub_join.js GET /api/servers/join/{}":                          {bLocal, `await call\('GET', ` + "`" + `/api/servers/join/`, "the poll of the join the panel started, on the Hub's own page: allowed moves on to the code, denied and expired say so with Ask again, any other answer keeps waiting (#21221)", 0},
	"second_hub_join.js POST /api/servers/join/{}/code":                    {bLocal, `await call\('POST', ` + "`" + `/api/servers/join/`, "the 8-digit code the panel sends, on the Hub's own page: a wrong code counts the tries left on the panel, an ended join says so with Ask again, any other refusal shows the server's words (#21221)", 0},
	"cloud_enrollment_qr.js GET /api/cloud/enroll-qr":                      {bHidden, `image\.onerror = .*clear\(\)`, "the enrollment QR is hidden until its local-human-only image answers; an image error removes it, preserving the link and code fallback. The route is never tunneled (#21881)", 0},
	"live_controller.js GET /api/cloud/links":                              {bLocal, `if \(!answeredLocally\(team\)`, "mountLiveControls returns before drawing controls or fetching active Hub links on a Hub-served page or for a remote team; answeredLocally requires a local dashboard and local server (#21128)", 0},
	"live_controller.js GET /api/live/links":                               {bLocal, `if \(!answeredLocally\(team\)`, "the census sees the API root as GET; controller requests are reachable only after mountLiveControls refuses Hub-served pages and remote teams, while its exported list read delegates to live_links.js's own local guard (#21128)", 0},
	"live_links.js GET /api/live/links":                                    {bLocal, `if \(!answeredLocally\(team\)`, "localLiveLinks returns null before fetch on a Hub-served page or for a remote team; answeredLocally requires a local dashboard and local server (#21128)", 0},
	"live_needs.js POST /api/live/links/{}/stop":                           {bLocal, `if \(!answeredLocally\(''\)\) return`, "mount and refresh refuse Hub-served pages so no Live card is drawn there; the Stop click handler repeats the local guard before posting, even if a card already existed (#21128)", 0},
	"relayed_grant_notices.js GET /api/relayed-grant-notices":              {bLocal, `if \(!local\(\)\)`, "the grant-notice feed is this computer's own human-only list: the script asks nothing through a Hub or of another computer (local() is false there and it draws no card), and the server refuses a tunneled caller (#20909)", 0},
	"relayed_grant_notices.js POST /api/relayed-grant-notices/{}/revoke":   {bLocal, `if \(!local\(\)\)`, "revoking a member grant is this computer's own human-only action: never offered through a Hub or for another computer, and the server refuses a tunneled caller (#20909)", 0},
	"field_pictures.js GET /api/board/{}/field-images":                     {bExplains, `Picture not uploaded \(HTTP`, "the census infers GET from the board-path literal assigned before fetch; the script actually POSTs pictures to this path. Through a Hub the refused upload throws the server's error/message or an HTTP failure; artifact_comment_images renders it on the retained failed picture with Retry and Remove, and the field blocks saving until retried or removed (#20851)", 0},
	"field_pictures.js POST /api/field-images":                             {bExplains, `Picture not uploaded \(HTTP`, "the no-team picture upload is attempted through a Hub; a refusal throws the server's error/message or an HTTP failure, which artifact_comment_images renders on the retained failed picture with Retry and Remove. The field blocks saving until retried or removed; this is an explained failure, not a local-only control (#20851)", 0},
	"artifact_reads.js GET /api/tracking/event":                            {bHidden, `!url\.pathname\.endsWith\('/api/tracking/event'\)`, "the census reads the telemetry exclusion literal as GET, but this module sends no GET to it: the wrapper forwards the original request unchanged and exempts telemetry from artifact-cache invalidation; the actual tracking route is POST and never in cloud_routes.golden, not a computer read through the Hub (#20457)", 0},
	"auth_status_read.js GET /api/system/auth-status":                      {bHidden, `then\(r => r\.ok \? r\.json\(\) : null\)`, "the shared browser-identity read is same-origin, not a computer proxy read; through a Hub a refused or failed read returns null and retains no error, so its password prompt and local-auth/Hub-offer consumers draw no notice from that answer; the machine route is GET never in cloud_routes.golden (#20457)", 0},
	"permission_flags_line.js POST /api/launch/permission-args":            {bHidden, `if \(!answer\) return \[\]`, "the flags line (New agent's recap, Restart, Resume) asks this computer for the permission flags a launch would add; where that is refused through a Hub it draws no line and the mode sentence above it stays: a hidden line, not a wrong one (#15719)", 0},
	"setup_agent.js PUT /api/settings":                                     {bHidden, `default_agent_type: pick`, "the setup card remembers the agent type the person picked as the default; the write is a bare fetch whose failure is swallowed (.catch(() => {})), so where a Hub refuses it nothing is shown and the choice is simply not saved: a hidden failure, not a break", 0},
	"analytics_waste.js GET /api/analytics/waste":                          {bHidden, `if \(isCloud\(\)\) \{ if \(section\) section\.hidden = true; return; \}`, "the Cost page's Waste card reads this computer's own transcripts and usage, never through a Hub; at a Hub the card's whole section is hidden before any read is made, so nothing is asked and no error is shown (#21127)", 0},
	"analytics_limit_waits.js GET /api/analytics/limit-waits":              {bHidden, `if \(isCloud\(\)\) \{ if \(section\) section\.hidden = true; return; \}`, "the Cost page's Limit waits card reads this computer's own record, which is never through a Hub; at a Hub the card's whole section is hidden before any read is made, so nothing is asked and no error is shown (#21020)", 0},
	"team_uncommitted.js POST /api/teams/detail/{}/commit":                 {bExplains, `The commit did not happen`, "Commit stays never through the Hub; a refused commit says it did not happen, with git's output when git said something, and nothing was committed (#17203)", 0},
	"launch_disclosure.js POST /api/launch-disclosure/ack":                 {bExplains, `Could not record that you have read this`, "acknowledgement stays never through the Hub; a refused acknowledgement says it could not be recorded and nothing was launched, with no retry; the Computers notice is information only (#14501)", 0},
	"check_approval.js GET /api/board/{}/health/checks":                    {bExplains, `The script could not be loaded`, "the script text beside a custom check's approval comes from this computer: the approval is never through a Coral Hub (#20139), so the row does not exist there; a failed read says it could not be loaded and approving still works from the words on the row (#20220)", 0},
	"team_form.js GET /api/filesystem/trust-probe":                         {bLocal, `isHub\(\) \|\| d\.dataset\.dirServer`, "only this computer’s folder choice is probed; Hub/remote inputs never request the default and the server rejects tunneled callers (#14090)", 0},
	"info_tab.js GET /api/sessions/live/{}/mcp-servers":                    {bHidden, `if \(!lines\.length\) return`, "the Info tab asks the agent's own computer for its MCP servers; where that read is refused through a Hub (or is empty) no row is drawn and nothing says why: a hidden row, not a wrong one (#13917)", 0},
	"team_reminders.js GET /api/reminders/agents":                          {bHidden, `if \(!r \|\| !r\.ok\) return null`, "the Agent reminders group of Team settings reads each agent's reminder count from this computer; where that is refused through a Hub the read gives nothing and the group is not drawn: a hidden group, not a wrong one (#19288)", 0},
	"team_reminders.js POST /api/reminders/agents/{}/switch":               {bExplains, `Could not turn \$\{a\.name\}`, "the per-agent reminders switch is this computer only: where it is refused the switch goes back and the page says it could not turn the reminders on or off, and nothing changed (#19288)", 0},
	"launch_reminders.js POST /api/reminders":                              {bHidden, `if \(isCloud\(\)\) \{ host\.hidden = true;`, "New agent's Reminders tab is hidden through a Hub before its drafts can be added; the POST saves drafts for a newly launched agent only outside the Hub (#21169, #21227)", 0},
	"team_agents_page.js POST /api/reminders":                              {bHidden, `custom: !isCloud\(\)`, "the Remind dialog offers Custom (cron) only outside a Hub, so the cron reminder POST is never sent through one (#21330)", 0},
	"agent_reminders.js GET /api/reminders":                                {bHidden, `if \(!r \|\| !r\.ok\) return null`, "an agent page's Reminders section reads this agent's reminders from this computer; where that is refused through a Hub the read gives nothing and the section is not drawn: a hidden section, not a wrong one (#19350)", 0},
	"chat_file_menu.js GET /api/system/editors":                            {bExplains, `editorsClosed\(\)`, "no request is sent through a Hub or for another computer's agent: the menu shows Open in editor dimmed, with the reason beside it (#13871)", 0},
	"chat_file_menu.js POST /api/sessions/live/{}/open-in-browser":         {bExplains, `data-hub-closed`, "browser launch is local only; the disabled menu item explains why", 0},
	"chat_file_menu.js POST /api/sessions/live/{}/open-in-editor":          {bExplains, `data-hub-closed`, "never through a Hub; the control is not offered there, and the dimmed Open in editor item says why (#13871)", 0},
	"automations_queue.js POST /api/resources/entries/{}/move":             {bExplains, `The queue is kept by each computer`, "no row loads through a Hub, and the folder says why (#13871)", 0},
	"automations_queue.js DELETE /api/resources/entries/{}":                {bExplains, `The queue is kept by each computer`, "no row loads through a Hub, and the folder says why (#13871)", 0},
	"artifact_source.js GET /api/servers":                                  {bExplains, `The computer list could not be loaded`, "the viewer reads the computer list from this page's own Coral (LOCAL_SERVER) once at startup; where that read is refused or is not a list, opening a file says 'The computer list could not be loaded. Please try opening the file again.' (#13838)", 0},
	"dropbox_connected.js GET /api/dropbox/status":                         {bHidden, `only for this computer's own file or board, outside Coral Hub`, "Share via Dropbox (#14944): the status read behind the viewer's item and the two board chats' buttons, each asked for only for this computer's own file or board outside Coral Hub; through a Hub nothing is offered and the status is not read", 0},
	"gdoc_share.js GET /api/gdoc/status":                                   {bHidden, `r\.body\.enabled === true`, "Share to Google Docs (#19996): the status read behind the viewer's menu item, asked for only for this computer's own Markdown file; through a Hub it is refused and the item stays hidden, nothing is offered", 0},
	"gdoc_share.js POST /api/artifacts/{}/gdoc/sync":                       {bExplains, `Not changed\. Try again`, "Share to Google Docs (#20010): Pause and Resume syncing in the same dialog; a refused change says it was not changed, with the server's own words when it gave any", 0},
	"gdoc_share.js DELETE /api/artifacts/{}/gdoc/share":                    {bExplains, `Not stopped\. Try again`, "Share to Google Docs (#20010): Stop sharing in the same dialog; a refused stop says it was not stopped, with the server's own words when it gave any", 0},
	"gdoc_share.js POST /api/artifacts/{}/gdoc/share":                      {bExplains, `Not shared`, "Share to Google Docs (#19996): the button is in the viewer's Details, which a Hub shows only for a file it asks this computer for; a refused share says it was not shared, with the server's own words when it gave any", 0},
	"dropbox_share.js GET /api/dropbox/share-contacts":                     {bHidden, `not offered through Coral Hub`, "address suggestions (#16170): the dialog opens only from the viewer's item, which is never offered through a Hub, and the server refuses a Hub caller; a refused or failed read shows no suggestions", 0},
	"dropbox_share.js POST /api/dropbox/connect":                           {bHidden, `not offered through Coral Hub`, "Share via Dropbox (#14944): the dialog's Sign in again; the dialog opens only from the viewer's item, which is never offered through a Hub", 0},
	"team_knowledge_note.js POST /api/teams/detail/{}/knowledge":           {bExplains, `Could not save:`, "Add note stays never through the Hub like the PUT that edits an agent's notes; a refused save says it could not be saved with the reason, keeps the typed title and text, and writes nothing (#17485)", 0},
	"team_linked_teams.js GET /api/cloud/status":                           {bHidden, `isCloud\(\) \|\| \(server && server !== 'local'\)`, "the team page's Linked teams section (#16011) asks this computer whether it is linked to a Coral Hub; through a Hub, or for a team on another computer, it sends nothing and draws nothing: a hidden section, not a wrong one", 0},
	"launch_provider_cards.js POST /api/system/cli-signin":                 {bHidden, `isLocalServer\(server\) && !isCloud\(\) && signinCommandIsSafe`, "the OpenCode card's Sign in button is drawn only for this computer's own Coral, outside a Hub and with the exact command shape; through a Hub the card says to sign in on the computer (#16716)", 0},
	"launch_where.js POST /api/system/cli-signin":                          {bHidden, `isLocalServer\(server\) && !isCloud\(\)`, "the Where step's Sign in on <computer> button is drawn only for this computer's own Coral, outside a Hub; through a Hub or for another computer the problem line says to sign in on that computer and check again (#20388)", 0},
	"settings_fields.js POST /api/system/cli-signin":                       {bHidden, `signIn\.hidden = cloud`, "the Sign in button is hidden through a Hub (cloud || !canSignIn); the POST is never sent and the text says to sign in on the computer (#16714)", 0},
	"agent_instructions_actions.js PUT /api/sessions/live/{}/instructions": {bExplains, `Could not save the instructions \(\$\{resp\.status\}\)`, "saving an agent's saved instructions is never through a Hub: the editor opens (the info read works) and Save is refused; the dialog stays open and shows the server's own words, or 'Could not save the instructions (<status>).' when it gave none, and nothing is saved (#20844)", 0},
	"run_signin.js POST /api/system/cli-signin":                            {bExplains, `Sign in on the computer that runs Coral`, "through a Hub the POST is never sent: the notice says to sign in on the computer that runs Coral, then press Retry (#16715)", 0},
}

// shellNeverFiles: every other never call of a script that nobody has read yet for what it does through a Hub. This is the starting list of #13860 ("what is true today"): it is a worklist, and
// it may only shrink (shellUnreviewedMax). Move a script out by giving its calls a behaviour in shellNeverRoutes, or a file-wide one here.
var shellNeverFiles = map[string]shellNever{
	"account_info.js":           {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"artifact_star.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"automation_runs.js":        {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"board_launches.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"changed_files.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"chat_import.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"chief_checks_api.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 6},
	"chief_setup.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"cloud.js":                  {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"cloud/enroll.js":           {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"dropbox_settings.js":       {bExplains, `set up on the computer itself, not through Coral Hub`, "Dropbox backup is set up on this computer's own dashboard: through a Hub every Dropbox route is never, the status read is refused and the block says where it is done, with no buttons (#14609); the removals list and its two routes are read only once connected (#14814); the auto-sync switch's route (#14714); Free up space's route (#14845); the shared-files list, its Stop sharing and Stop all (#14944), read only once connected; the \"Share through Coral Hub\" switch's route (#16109), set only on this computer's own dashboard, so never through a Hub", 16},
	"google_settings.js":        {bExplains, `set up on the computer itself, not through Coral Hub`, "Google sign-in (#20022) is set up on this computer's own dashboard: through a Hub its three routes (status, connect, disconnect) are never, the status read is refused and the block says where it is done, with no buttons; the status carries no account id and the page never shows one", 3},
	"cloud_connect.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 13},
	"cloud_server_view.js":      {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"controls.js":               {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"custom_views.js":           {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"dashboard_analytics.js":    {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"default_prompts_dialog.js": {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"docs.js":                   {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"editions.js":               {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"folder_tags.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"goal_write.js":             {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"hub_indicator.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"hub_mode_setting.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"hub_notice.js":             {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 3},
	"hub_pending.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"inbox_sidebar.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"job_form.js":               {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"launch_dialog.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"launch_models.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"list_display_settings.js":  {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"list_order.js":             {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"mailbox_chats.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"mobile_connect.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 6},
	"notes.js":                  {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"notice_pause.js":           {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"password_ui.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"received_cap_notice.js":    {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"registered_server_view.js": {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 7}, // 7: Reconnect (POST /api/servers/{id}/reconnect, a route that never goes through a Hub)
	"scheduler.js":              {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 3},
	"search_access.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"security_settings.js":      {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 9},
	"server_access.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"server_base.js":            {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"server_controller.js":      {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"server_owner_secret.js":    {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"server_ssh_setup.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 8},
	"settings_codex_hooks.js":   {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"settings_core.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 3},
	"settings_dialog.js":        {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"settings_fill.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 3},
	"settings_lists.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"settings_machine.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 3},
	"settings_save.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 2},
	"settings_storage.js":       {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 12},
	"setup_code_setting.js":     {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"shared_images.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"signed_out.js":             {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"skills_tab.js":             {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist); its list and page reads are View since #19627, its writes stay never", 5},
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
	"welcome_items.js":          {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"workflow_agent.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"workflows.js":              {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"worktrees_panel.js":        {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
	"xterm_renderer.js":         {bUnreviewed, "", "unreviewed: nobody has read what this script does through a Hub (#13860 worklist)", 1},
}

const shellUnreviewedMax = 84

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

var blockCommentRe = regexp.MustCompile("(?s)(^|[^'\"`\\w/])(/\\*.*?\\*/)")

// blankComments is src with block comments and the rest of any line after a // comment turned to spaces (line ends and offsets kept), so a doc comment that names a route is not a call. A // that
// follows a colon (a URL) or sits inside a quote on its line is left alone.
func blankComments(src string) string {
	blank := func(s string) string {
		return strings.Map(func(r rune) rune {
			if r == '\n' {
				return r
			}
			return ' '
		}, s)
	}
	src = blockCommentRe.ReplaceAllStringFunc(src, func(m string) string {
		i := strings.Index(m, "/*")
		return m[:i] + blank(m[i:])
	})
	lines := strings.Split(src, "\n")
	for n, l := range lines {
		for i := 0; i+1 < len(l); i++ {
			if l[i] == '/' && l[i+1] == '/' && (i == 0 || l[i-1] != ':') && strings.Count(l[:i], "'")%2 == 0 && strings.Count(l[:i], "\"")%2 == 0 && strings.Count(l[:i], "`")%2 == 0 {
				lines[n] = l[:i] + blank(l[i:])
				break
			}
		}
	}
	return strings.Join(lines, "\n")
}

func TestBlankCommentsHidesCommentedRoutesOnly(t *testing.T) {
	src := "a('/api/real');\n// fetch('/api/in-line-comment')\n/* fetch('/api/in-block')\n * more */\nb('/api/after'); // fetch('/api/trailing')\nu = 'https://x.dev/api/y'; c('/api/a//b');\n"
	got := blankComments(src)
	require.Equal(t, len(src), len(got))
	require.Equal(t, strings.Count(src, "\n"), strings.Count(got, "\n"))
	for _, keep := range []string{"/api/real", "/api/after", "https://x.dev/api/y", "/api/a//b"} {
		require.Contains(t, got, keep)
	}
	for _, gone := range []string{"in-line-comment", "in-block", "trailing"} {
		require.NotContains(t, got, gone)
	}
}

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
		src := blankComments(string(b))
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
	"check_approval.js GET /api/board/{}/health/checks":            "this computer only: a custom check's approval is refused through a Hub (#20139), so the row, and this read of the script text, exist only on the computer it runs on (#20220)",
	"automations_queue.js GET /api/resources":                      "this computer only: through a Hub the read is not sent (isCloud returns first, #13871)",
	"board_export.js GET /api/sessions/live":                       "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"board_bulk_reads.js GET /api/board/projects":                  "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"job_form.js GET /api/scheduled/jobs/{}":                       "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"job_form.js GET /api/workflows":                               "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"job_form.js POST /api/scheduled/jobs/init-repo":               "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
	"job_form.js POST /api/scheduled/validate-cron":                "unreviewed: a bare fetch asks the page's own origin, which through a Hub is the Hub (#13860 worklist)",
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
