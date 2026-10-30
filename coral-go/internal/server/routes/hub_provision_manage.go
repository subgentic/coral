package routes

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/sshprov"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/hubowner"
)

// Managing a server that was set up over SSH (#11370): upgrade it to this hub's release, stop it, or remove it. It is the same three-step flow as a setup (plan, connect, run) on the same routes: the plan
// names a registered ssh server, and the target is the REGISTRY's, never the request's. Before anything is changed the hub reads the far computer's instance id and compares it with the one recorded at
// setup, so an address that now belongs to another computer is never acted on.

var instanceRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

func manageSteps(kind string) []provisionStep {
	s := func(name, title string) provisionStep {
		return provisionStep{Name: name, Title: title, State: stepPending}
	}
	switch kind {
	case kindUpgrade:
		return []provisionStep{s("connect", "Connect over SSH and check the host key"), s("identity", "Check it is the computer that was set up"), s("detect", "Check the system and tmux"),
			s("install", "Download, verify and install this hub's release"), s("restart", "Restart Coral on the new release"), s("verify", "Check that it answers")}
	case kindStop:
		return []provisionStep{s("connect", "Connect over SSH and check the host key"), s("identity", "Check it is the computer that was set up"), s("stop", "Stop Coral")}
	}
	return []provisionStep{s("connect", "Connect over SSH and check the host key"), s("identity", "Check it is the computer that was set up"), s("stop", "Stop Coral"),
		s("remove", "Delete the installed files"), s("forget", "Remove it from this hub")}
}

// planManage handles a plan for an upgrade, a stop or a remove.
func (pr *Provisioner) planManage(w http.ResponseWriter, r *http.Request, req planRequest) {
	if req.Target != "" || req.Alias != "" || req.Mode != "" || req.Label != "" {
		errBadRequest(w, "a server to manage is named by its id only")
		return
	}
	if req.Action != kindUpgrade && req.Action != kindStop && req.Action != kindRemove {
		errBadRequest(w, "the action is upgrade, stop or remove")
		return
	}
	if req.DeleteData && req.Action != kindRemove {
		errBadRequest(w, "only a remove deletes the data")
		return
	}
	row, err := pr.store.Get(r.Context(), req.ServerID)
	if err != nil {
		remoteErr(w, err)
		return
	}
	if row.Transport != store.RemoteTransportSSH || row.InstanceID == "" {
		errBadRequest(w, "only a server that was set up over SSH can be managed here")
		return
	}
	t, err := sshTargetOf(row.SSHTarget)
	if err != nil {
		errBadRequest(w, "this server's SSH target is not valid")
		return
	}
	p := &provisionPlan{ID: newPlanID(), Target: t, ServerID: row.ID, Label: row.Label, Mode: "tmux", Kind: req.Action, Delete: req.DeleteData, phase: phasePlanned, created: time.Now(), steps: manageSteps(req.Action)}
	pr.mu.Lock()
	pr.expireLocked()
	for _, o := range pr.plans {
		if o.ServerID == row.ID {
			pr.mu.Unlock()
			errConflict(w, "something is already in progress for that server")
			return
		}
	}
	if len(pr.plans) >= provisionMaxPlans {
		pr.mu.Unlock()
		writeError(w, http.StatusTooManyRequests, "", "finish or cancel a setup in progress first")
		return
	}
	pr.plans[p.ID] = p
	pr.mu.Unlock()
	writeJSON(w, http.StatusCreated, p.view())
}

// runPlan is what a run does after the host keys are settled, by the kind of plan.
func (pr *Provisioner) runPlan(ctx context.Context, p *provisionPlan) {
	switch p.kind() {
	case kindSetup:
		pr.detectSteps(ctx, p)
	case kindUpgrade:
		pr.upgradeSteps(ctx, p)
	case kindStop:
		pr.stopSteps(ctx, p)
	case kindRemove:
		pr.removeSteps(ctx, p)
	}
}

func (pr *Provisioner) done(p *provisionPlan) {
	p.mu.Lock()
	p.phase = phaseDone
	p.mu.Unlock()
}

// identity reads the far computer's instance id and compares it with the registry's. On a mismatch, or no id, nothing has been changed and the plan is failed.
func (pr *Provisioner) identity(ctx context.Context, p *provisionPlan, row *store.RemoteServer) bool {
	p.setStep("identity", stepRunning, "")
	res, err := pr.runner.Run(ctx, p.Target, sshprov.CmdReadInstanceID)
	if err != nil {
		pr.fail(p, "identity", "Could not connect.")
		return false
	}
	if id := strings.TrimSpace(res.Stdout); res.ExitCode != 0 || !instanceRe.MatchString(id) || id != row.InstanceID {
		pr.fail(p, "identity", "That is not the computer that was set up, so nothing was changed.")
		return false
	}
	p.setStep("identity", stepOK, "It is the computer that was set up.")
	return true
}

func (pr *Provisioner) stopSteps(ctx context.Context, p *provisionPlan) {
	row, err := pr.store.Get(ctx, p.ServerID)
	if err != nil {
		pr.fail(p, "identity", "That server is no longer registered.")
		return
	}
	if !pr.identity(ctx, p, row) {
		return
	}
	if !pr.stopRemote(ctx, p) {
		return
	}
	pr.done(p)
}

func (pr *Provisioner) stopRemote(ctx context.Context, p *provisionPlan) bool {
	p.setStep("stop", stepRunning, "")
	if err := pr.runner.StopAndConfirm(ctx, p.Target); err != nil {
		pr.fail(p, "stop", "Coral on that computer did not stop, or that could not be checked, so nothing was deleted.")
		return false
	}
	p.setStep("stop", stepOK, "Coral is stopped. Its files are still there.")
	return true
}

func (pr *Provisioner) removeSteps(ctx context.Context, p *provisionPlan) {
	row, err := pr.store.Get(ctx, p.ServerID)
	if err != nil {
		pr.fail(p, "identity", "That server is no longer registered.")
		return
	}
	if !pr.identity(ctx, p, row) || !pr.stopRemote(ctx, p) {
		return
	}
	p.setStep("remove", stepRunning, "")
	cmd, detail := sshprov.CmdRemoveInstalls, "The installed releases are deleted. The data and the key are kept."
	if p.Delete {
		cmd, detail = sshprov.CmdRemoveAll, "Everything under ~/"+sshprov.InstallDir+" is deleted, including the data."
	}
	if r, err := pr.runner.Run(ctx, p.Target, cmd); err != nil || r.ExitCode != 0 {
		pr.fail(p, "remove", "Could not delete the files on that computer.")
		return
	}
	p.setStep("remove", stepOK, detail)
	p.setStep("forget", stepRunning, "")
	if err := pr.store.Delete(ctx, p.ServerID); err != nil && !errors.Is(err, store.ErrRemoteNotFound) {
		pr.fail(p, "forget", "The files are gone, but this hub could not remove the server from its list.")
		return
	}
	if pr.onRemoved != nil {
		pr.onRemoved(p.ServerID)
	}
	p.setStep("forget", stepOK, "Removed from this hub.")
	pr.done(p)
}

func (pr *Provisioner) upgradeSteps(ctx context.Context, p *provisionPlan) {
	row, err := pr.store.Get(ctx, p.ServerID)
	if err != nil {
		pr.fail(p, "identity", "That server is no longer registered.")
		return
	}
	key, err := pr.store.DecryptedKey(ctx, p.ServerID)
	if err != nil {
		pr.fail(p, "identity", "This hub cannot read that server's key.")
		return
	}
	if !pr.identity(ctx, p, row) {
		return
	}
	arch, ok := pr.detect(ctx, p)
	if !ok {
		return
	}
	// The running version is read before anything is left alone or replaced: the same version needs nothing.
	want := config.ReportedVersion()
	if h := pr.checkHealth(ctx, row, key); h.Status == store.RemoteStatusOnline && h.Version == want {
		for _, s := range []string{"install", "restart", "verify"} {
			p.setStep(s, stepSkipped, "Already running this hub's release.")
		}
		pr.done(p)
		return
	}
	if err := pr.install(ctx, p, arch); err != nil {
		var ie *sshprov.ErrInstall
		msg := "Could not install Coral on that computer."
		if errors.As(err, &ie) {
			msg = ie.Msg
		}
		pr.fail(p, "install", msg)
		return
	}
	p.setStep("restart", stepRunning, "Stopping Coral and starting the new release.")
	if err := pr.runner.StopAndConfirm(ctx, p.Target); err != nil {
		pr.fail(p, "restart", "The running Coral did not stop, or that could not be checked, so the new release was not started.")
		return
	}
	by := setupAcceptanceLabel()
	if err := pr.runner.AcceptTerms(ctx, p.Target, pr.version, termsPayload(by)); err != nil {
		pr.fail(p, "restart", "Could not record your acceptance of the terms on that computer.")
		return
	}
	if err := pr.runner.StartTmux(ctx, p.Target, pr.version); err != nil {
		pr.fail(p, "restart", "Could not start the new release.")
		return
	}
	p.setStep("restart", stepOK, "Started.")
	p.setStep("verify", stepRunning, "")
	if h := pr.checkHealth(ctx, row, key); h.Status != store.RemoteStatusOnline || h.Version != want {
		slog.Info("[provision] upgrade did not come back", "plan", p.ID)
		pr.fail(p, "verify", "The new release was started, but it did not answer as expected.")
		return
	}
	p.setStep("verify", stepOK, "It answers on the new release."+pr.ensureOwnerSecret(ctx, p, row))
	_ = pr.store.SetStatus(ctx, p.ServerID, store.RemoteStatusOnline, "")
	if pr.notify != nil {
		pr.notify(p.ServerID, store.RemoteStatusOnline)
	}
	pr.done(p)
}

// SetOnRemoved sets who hears the id of a server a remove took out of the registry (what is kept for it in memory goes too).
func (pr *Provisioner) SetOnRemoved(f func(id string)) { pr.onRemoved = f }

// ensureOwnerSecret gives a computer set up before the owner stamp existed (#11378) its secret, once: a computer this hub already holds one for keeps it (a rotation is a person's act, not an upgrade's).
// It returns the words to add to the step, empty when nothing needs saying.
func (pr *Provisioner) ensureOwnerSecret(ctx context.Context, p *provisionPlan, row *store.RemoteServer) string {
	if row.OwnerStamp {
		return ""
	}
	secret, err := hubowner.NewSecret()
	if err != nil || pr.installOwner(ctx, p, secret) != nil || pr.store.SetOwnerSecret(ctx, p.ServerID, secret) != nil {
		return " Approve and Request changes through this hub are not set up for it."
	}
	return " Approve and Request changes now work through this hub."
}
