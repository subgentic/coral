package tracking

// Every event Coral can send is named here. The user-facing telemetry
// disclosure is generated from AllEvents, so an event that is missing from
// this file is an event Coral does not disclose. Adding an emit site without
// adding it here fails TestAllEventsCoversEveryEventConstant.

const (
	// Lifecycle.
	EventInstall   = "install"
	EventUpgrade   = "upgrade"
	EventAppOpened = "app_opened"
	// EventInstallationActiveWeek is the weekly-active-installs signal (#4935).
	EventInstallationActiveWeek = "installation_active_week"

	// Usage.
	EventSessionLaunched = "session_launched"
	EventTeamLaunched    = "team_launched"

	// Conversion.
)

// EventDoc describes one event in terms a user can check against the source.
type EventDoc struct {
	Name string `json:"name"`
	// When says what causes the event, in plain language.
	When string `json:"when"`
	// Extra names properties this event carries beyond the standard four
	// (version, edition, os, arch). Empty when it carries only those.
	Extra string `json:"extra,omitempty"`
}

// StandardProperties are attached to every event without exception.
var StandardProperties = []string{
	"version — the Coral version you are running",
	"edition — the build tier (prod, beta, staging, dev, dropboxers)",
	"os — your operating system (darwin, linux, windows)",
	"arch — your CPU architecture (amd64, arm64)",
	"platform — your client platform (darwin, linux, windows, wsl2)",
	"schema_version — the version of this event format",
	"run_id — a random ID for this run of Coral, new every time it starts (not your install ID)",
	"entrypoint — which Coral program is running (coral, coral-tray, launch-coral)",
}

// NeverCollected is the explicit list of things no event carries. It is stated
// positively in the disclosure because a short, complete list of what is sent
// is only reassuring alongside an equally explicit list of what is not.
var NeverCollected = []string{
	"Your prompts",
	"Your source code",
	"Repository, branch, and file names",
	"Agent output",
	"Your name or email address",
	"Your API keys or passwords",
}

// AllEvents is the complete, ordered list of every event Coral can send.
var AllEvents = []EventDoc{
	{Name: EventInstall, When: "The first time Coral runs on this machine."},
	{Name: EventUpgrade, When: "The first run after Coral's version changes.", Extra: "from_version — the version that last ran on this install (a release number only; left out when it is not one)"},
	{Name: EventAppOpened, When: "Every time Coral starts: the server sends it when you run coral, and the tray sends it, not the server, when you run the Coral app (coral-tray)."},
	{Name: EventInstallationActiveWeek, When: "At most once per ISO week (UTC) that Coral runs: sent when Coral starts, and again the first time that week you open the dashboard, launch an agent or team, or complete a task, so a long-running Coral still counts every week it is used."},
	{Name: EventSessionLaunched, When: "Every time you launch a single agent."},
	{Name: EventTeamLaunched, When: "Every time a team launch starts at least one agent.", Extra: "agent_count — how many agents started; requested_agents, started_agents, failed_agents"},
	{Name: EventFirstAgentLaunched, When: "Once ever: the first agent you launch."},
	{Name: EventFirstTeamLaunched, When: "Once ever: the first team you launch.", Extra: "agent_count — how many agents started"},
	{Name: EventFirstTaskCompleted, When: "Once ever: the first message-board task marked complete, whether it succeeded or failed.", Extra: "outcome — success or failed"},
	{Name: EventFirstTaskSucceeded, When: "Once ever: the first message-board task completed successfully."},
	{Name: EventTaskCompleted, When: "Every time a message-board task is marked complete.", Extra: "outcome — success or failed"},
	{Name: EventLaunchRequested, When: "Every time you start launching an agent or a team.", Extra: "kind, attempt_id (random per launch), provider (claude, codex, gemini, other, mixed), backend (tmux, pty), requested_agents, resume"},
	{Name: EventLaunchResult, When: "When that launch finishes.", Extra: "the launch_requested properties plus outcome (success, failure, partial), failure_category (a fixed list such as limit_reached or spawn_failed — never the error text), duration_ms, started_agents, failed_agents"},
	{Name: EventDashboardReady, When: "Each time the dashboard page finishes loading and shows your agents.", Extra: "page_id — a random ID for that page load"},
	{Name: EventDashboardActiveDay, When: "At most once per UTC day that you have the dashboard open."},
	{Name: EventDashboardFailed, When: "When the dashboard cannot load its agent list or status at startup.", Extra: "code — a fixed code such as sessions_fetch_http or init_failed"},
	{Name: EventPrerequisiteCheck, When: "When Coral checks whether tmux, the Claude CLI or the Codex CLI is available: at most once per run for each result and each place that checked. Coral does not install anything, so a missing tool is not an installation failure.", Extra: "tool (tmux, claude, codex), status (available, missing, probe_failed, timeout), source (system_status, cli_check, cli_recheck, settings_check) — never a path or a version"},
	{Name: EventPromptSubmitRequested, When: "Once ever: the first time you send a prompt from the dashboard composer.", Extra: "source — dashboard_composer; never the prompt"},
	{Name: EventFirstPromptSubmitted, When: "Once ever: the first time you send a message to an agent, by whichever way (the dashboard composer, typing in the terminal view, or the prompt of a launch). It says a message went; never what it said.", Extra: "source — composer_http, composer_ws, terminal or launch_prompt; never the prompt"},
	{Name: EventEULAAccepted, When: "Once ever: when Coral starts after you accept the Terms of Service (in Coral's terms dialog in the app or in a terminal, by the Windows installer, or when the Coral Hub confirms them as the machine enrolls), and only if usage analytics are on: Coral reads your saved choice first. Nothing is sent before you accept, or if you have opted out.", Extra: "source — dialog, legacy or hub"},
	{Name: EventDashboardSignedIn, When: "Once ever: the first time the dashboard signs in on this computer.", Extra: "via — app, link, key or password: which kind of sign-in it used, never the credential"},
	{Name: EventFirstMessageSent, When: "Once ever: the first time you send a message to an agent, from the dashboard composer, by typing in the terminal view, or as the prompt of a launch. It says a message went; never what it said.", Extra: "via — composer_http, composer_ws, terminal or launch_prompt"},
	{Name: EventFirstAgentReply, When: "Once ever for a turn that ended normally: the first time an agent's turn ends after a message you sent (and once for a turn that ended in an error, if that happened before any ended normally). It says a turn ended and how long it took; never what the agent wrote.", Extra: "provider — claude, codex, gemini or other; seconds_to_reply — whole seconds from your message to the end of the turn (0 to 3600); outcome — ok or error"},
	{Name: EventReturned24h, When: "Once ever: the first time you open Coral more than 24 hours after your first open."},
	{Name: EventUpdateNoticeShown, When: "The first time, per release and per place, that the dashboard or the tray tells you a newer Coral release exists. It says the notice was shown, not that you updated: Coral does not install updates itself.", Extra: "to_version — the newer release number; source — dashboard or tray; channel — approved or agentic (the update channel you chose)"},
	{Name: EventUpdateOfferOpened, When: "The first time, per release and per place, that you open the release page the update notice offers (the toast's Download link, or the tray's Check for Updates). It says you opened a page, not that you installed anything.", Extra: "to_version, source and channel as above; method — download_link"},
	// The Inbox (#7512): counts and closed values only; at most 50 per kind and action and 200 in all per install per UTC day (counted but not sent past that).
	{Name: EventInboxOpened, When: "At most once per UTC day: you opened the Inbox. The dashboard names the event and nothing else; Coral counts what is waiting itself.", Extra: "waiting — how many items wait for you, as 0, 1-2, 3-5 or 6+"},
	{Name: EventInboxWaiting, When: "With inbox_opened: one event per kind of item that was waiting.", Extra: "kind — agent_wait, review, run, proposal, goal_done, skill, ask, wait or unrecorded; waiting — 0, 1-2, 3-5 or 6+"},
	{Name: EventInboxItemActioned, When: "When you act on an Inbox item (answer, approve, dismiss, and so on). Only a person's own action counts, never an agent's or a script's. Never the item's id, title or text, nor an agent, board, task or file name.", Extra: "kind (as above); sub_kind — for an agent's wait: permission, question, plan, login or other; action — answer, dismiss, approve, changes, deny, ignore, save, unsave, seen, reject, close, hide, button or record; surface — inbox, chat or other; secs_to_action — whole seconds from when the item began (0 to 7 days; left out when unknown)"},
	// The step-by-step new-user funnel (#7455): each step at most once per install. Every step also carries backend (pty, tmux or unknown) and secs_since_install (whole seconds since Coral first opened on this install, up to 30 days).
	{Name: EventFunnelAppStarted, When: "Once ever: the first start of a Coral program on this install. Recorded on this computer and sent only after you accept the Terms, with usage analytics on; deleted if analytics is off then.", Extra: "source — cli, tray, launcher or installer_launch; backend, secs_since_install"},
	{Name: EventFunnelStartupFailed, When: "Once ever: the first start that failed. Recorded on this computer and sent at a later start, only after you accept the Terms, with usage analytics on.", Extra: "class — port_in_use, permission_denied or other (never the error text); backend, secs_since_install"},
	{Name: EventFunnelEULAShown, When: "Once ever: the Terms of Service were shown. Recorded on this computer and sent only after you accept them, with usage analytics on.", Extra: "surface — app_dialog or terminal; backend, secs_since_install"},
	{Name: EventFunnelEULADeclined, When: "Once ever: the Terms of Service were declined. Sent only if you accept them later, with usage analytics on; a decline that is never followed by acceptance is never sent.", Extra: "surface — app_dialog or terminal; backend, secs_since_install"},
	{Name: EventFunnelDashboardOpen, When: "Once ever: what the first start did about opening the dashboard.", Extra: "result — opened, native_window, native_window_fallback_browser, printed_no_display, skipped_no_browser_flag, background_start or server_not_running; backend, secs_since_install"},
	{Name: EventFunnelSigninPageShown, When: "Once ever: the sign-in page was served to a browser that was not signed in. Any request for the sign-in page counts, a program on this computer or a scan from the network included, so it says that someone reached the page, not who.", Extra: "page — setup, create or signin; nothing of the request; backend, secs_since_install"},
	{Name: EventFunnelSigninLinkRefused, When: "Once ever: a sign-in link was refused.", Extra: "class — used_or_expired or other_user; never the link; backend, secs_since_install"},
	{Name: EventFunnelDashboardLoaded, When: "Once ever: the first dashboard page finished loading.", Extra: "backend, secs_since_install"},
	{Name: EventFunnelDashboardLoadFailed, When: "Once ever: the first dashboard page that could not load its agents or status.", Extra: "code — one of the dashboard_failed codes, or other; never the error text; backend, secs_since_install"},
	{Name: EventFunnelWelcomeShown, When: "Once ever: the new-install welcome items were on when the dashboard first loaded.", Extra: "backend, secs_since_install"},
	{Name: EventFunnelWelcomeDone, When: "Once per welcome item: an item was done, read or dismissed, or all of them were closed (done or hidden).", Extra: "step — welcome, agent, team, connect, asks or all_closed; backend, secs_since_install"},
	{Name: EventFunnelCLIDetected, When: "Once per agent tool: which agent tools this computer has installed, found by Coral's own lookup when the dashboard first loads.", Extra: "tool — claude, codex, gemini or pi; status — found, not_found or unrunnable; never a path or a version; backend, secs_since_install"},
	{Name: EventFunnelLaunchDialogOpened, When: "Once ever: the launch dialog was opened.", Extra: "backend, secs_since_install"},
	{Name: EventFunnelLaunchClicked, When: "Once ever: the first launch of an agent or a team was asked for.", Extra: "kind — agent or team; provider; backend, secs_since_install"},
	{Name: EventFunnelLaunchFailed, When: "Once ever: the first launch that failed.", Extra: "kind, provider, failure_category (the launch_result list, never the error text); backend, secs_since_install"},
	{Name: EventFunnelAgentFirstOutput, When: "Once ever: an agent's terminal was first seen to have written something.", Extra: "provider — claude, codex, gemini, pi or other; secs_since_launch (0 to 3600); never anything it wrote; backend, secs_since_install"},
	{Name: EventFunnelAgentReady, When: "Once per state: what a new agent was first seen doing, ready for a message or held by a question its tool asks at launch.", Extra: "provider; state — ready, waiting_trust, waiting_signin, waiting_other_prompt, not_started or exited_early; secs_since_launch; never anything on its screen; backend, secs_since_install"},
}

// Enabled reports whether this build can send anything at all. Builds compiled
// from source carry no analytics key and send nothing.
func Enabled() bool { return posthogKeyPresent() }
