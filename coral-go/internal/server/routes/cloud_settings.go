package routes

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/subgentic/coral/internal/secrets"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/redact"
	"github.com/subgentic/coral/pkg/tunnel"
)

// MaxModeSetting is the user setting holding this server's maximum cloud access mode:
// "view" (default), "interact" or "launch". It is local: the connector reads it on every
// request, so neither the hub nor a tunneled request can change it (the /api/cloud
// routes are not in the tunnel route table).
const MaxModeSetting = "cloud_max_mode"

// AllowHubAutoAcceptSetting is the local owner switch "Coral Hub can turn on
// auto-accept" (#3182): auto-accept from the hub, and a hub launch, team launch,
// restart or task run that skips permission prompts (#126 F4). It is ON unless the
// owner turned it off (the Operator's decision, #5840: Coral Hub is the primary source
// for a connected computer; an explicit off stays off): Launch lets the hub start agents,
// this lets them act without asking. The owner of this computer sets it here (Settings >
// Network and Hub, PUT /api/cloud/allow-auto-accept, local only), and the Coral Hub OWNER
// (the account this computer is linked to) through POST /api/hub-auto-accept {"allow": bool}; turning it off ends every enable that came from the hub.
const AllowHubAutoAcceptSetting = "cloud_allow_hub_auto_accept"

// HubRelaunchSetting is the local switch "Let Coral Hub relaunch this Coral to install updates" (#5280). Off unless set to "true" (#6290),
// read from the settings store on every relaunch request, and never reachable through the tunnel: its write has its own route, and
// PUT /api/settings refuses it like the mode cap.
const HubRelaunchSetting = "hub_relaunch_updates"

// UpdateAutoSetting is "check for updates automatically" (#5280 step 3 B): the background check and staging. Installing one needs a person (the relaunch with its acknowledgement) unless update_auto_install is on: then Coral installs it once idle (#11170).
const UpdateAutoSetting = "update_auto"

// UpdateAutoOn: on unless the owner turned it off.
func UpdateAutoOn(settings map[string]string) bool { return setreg.Bool(settings, UpdateAutoSetting) }

// HubCrossTeamSetting is the local lock "Let Coral Hub change cross-team settings" (#5572). On unless set to "false" (the default is the settings registry's, written by code); when it is off the Coral Hub
// owner's dedicated routes refuse both directions. Written only by PUT /api/cloud/hub-cross-team, never through the tunnel: its write has its own route, and PUT /api/settings refuses it like the mode cap.
const HubCrossTeamSetting = "hub_cross_team_settings"

// HubCrossTeamAllowed reads the lock (default on).
func HubCrossTeamAllowed(settings map[string]string) bool {
	return setreg.Bool(settings, HubCrossTeamSetting)
}

// HubRelaunchAllowed reads the switch: on only for the word true, so a person who never touched it (nothing stored, or any other word) is off (#6290).
func HubRelaunchAllowed(settings map[string]string) bool {
	return setreg.Bool(settings, HubRelaunchSetting)
}

// RedactTokensSetting is the local switch "hide tokens from Coral Hub viewers" (#3560): the
// connector replaces well-known credential formats and private keys in View replies before
// they leave this computer. On unless set to "false"; local only, like the mode cap.
const RedactTokensSetting = "hub_redact_tokens"

// HubRedactTokens reads the switch (default on).
func HubRedactTokens(settings map[string]string) bool {
	return setreg.Bool(settings, RedactTokensSetting)
}

// RedactTokensFromSettings reads the switch for each redacted reply, from the settings at most
// a second old (a change applies within a second); an unreadable store means on.
func RedactTokensFromSettings(ss *store.SessionStore) func() bool {
	var mu sync.Mutex
	var at time.Time
	on := true
	return func() bool {
		mu.Lock()
		defer mu.Unlock()
		if time.Since(at) < time.Second {
			return on
		}
		s, err := ss.GetSettings(context.Background())
		on, at = err != nil || HubRedactTokens(s), time.Now()
		return on
	}
}

// RedactKeywordsSetting is the local switch for the keyword rules of the connector's redactor (#5141): the value after a name such as
// api_key, token or password is replaced in what goes to Coral Hub whatever it looks like. On unless set off; written only through
// PUT /api/settings, which the tunnel never reaches, so the hub cannot change it. The environment variable CORAL_REDACT_KEYWORDS=off turns them off too.
const RedactKeywordsSetting = "hub_redact_keywords"

// RedactKeywordsFromSettings reads the switch for each redacted reply, from the settings at most a second old; an unreadable store means on.
func RedactKeywordsFromSettings(ss *store.SessionStore) func() bool {
	var mu sync.Mutex
	var at time.Time
	on := true
	return func() bool {
		mu.Lock()
		defer mu.Unlock()
		if time.Since(at) < time.Second {
			return on
		}
		s, err := ss.GetSettings(context.Background())
		on, at = err != nil || setreg.Bool(s, RedactKeywordsSetting), time.Now()
		return on
	}
}

// keywordSwitch is the keyword rules' switch for the hub-bound paths of this package (chat_trim, saved, the scans of what is sent to another Coral):
// set once at startup (SetKeywordSwitch) from the same reader the cloud connector's redactor has; nil is on. Read on each use.
var keywordSwitch atomic.Pointer[func() bool]

// SetKeywordSwitch sets keywordSwitch.
func SetKeywordSwitch(on func() bool) { keywordSwitch.Store(&on) }

func keywordsOn() bool {
	if f := keywordSwitch.Load(); f != nil && *f != nil {
		return (*f)()
	}
	return true
}

// requestRedactor is the redactor for text a request will show: Coral Hub's (the keyword rules too) when the request came through the tunnel,
// otherwise the local one. The reply is redacted again on its way out, but a field cut or kept first (chat_trim, saved) must be redacted
// before it is cut, or a fragment of a value the keyword rules would take can pass (#5172).
func requestRedactor(r *http.Request) redact.Redactor {
	if r != nil && viaTunnel(r) {
		return secrets.HubRedactor(keywordsOn)
	}
	return secrets.Redactor()
}

// HubAutoAcceptAllowed reads the switch (default on, #5840).
func HubAutoAcceptAllowed(settings map[string]string) bool {
	return setreg.Bool(settings, AllowHubAutoAcceptSetting)
}

// MaxModeFromSettings reads the local maximum mode. Anything missing or unrecognised is view.
func MaxModeFromSettings(ss *store.SessionStore) func() tunnel.Mode {
	return func() tunnel.Mode {
		s, err := ss.GetSettings(context.Background())
		if err != nil {
			return tunnel.TierView
		}
		if m, ok := tunnel.ParseMode(setreg.Raw(s, MaxModeSetting)); ok {
			return m
		}
		return tunnel.TierView
	}
}

// HubModeSetting is Settings > Run as a hub (#3460): "true" starts this Coral as a
// multi-server hub, like --hub. It applies at the next start.
const HubModeSetting = "hub_mode"
