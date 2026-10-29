//go:build unix

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/machinelaunch"
)

// #10918: coral machine list, delete and prune, against a stub provider. No real call is made and no secret is printed.

type manageProvider struct {
	*machineStubProvider
	drops []machinelaunch.Instance
	vpcs  []machinelaunch.VPC
	fws   []machinelaunch.Firewall
	log   []string
}

func (m *manageProvider) List(context.Context) ([]machinelaunch.Instance, error) { return m.drops, nil }
func (m *manageProvider) ListVPCs(context.Context) ([]machinelaunch.VPC, error)  { return m.vpcs, nil }
func (m *manageProvider) ListFirewalls(context.Context) ([]machinelaunch.Firewall, error) {
	return m.fws, nil
}
func (m *manageProvider) Delete(_ context.Context, id string) error {
	m.log = append(m.log, "delete:"+id)
	return nil
}
func (m *manageProvider) DeleteFirewall(_ context.Context, id string) error {
	m.log = append(m.log, "firewall:"+id)
	return nil
}
func (m *manageProvider) DeleteVPC(_ context.Context, id string) error {
	m.log = append(m.log, "vpc:"+id)
	return nil
}

type manageRevoker struct {
	log *[]string
	key string
	ids []string
	err error
}

func (r *manageRevoker) Revoke(_ context.Context, id string) error {
	r.ids = append(r.ids, id)
	*r.log = append(*r.log, "revoke:"+id)
	return r.err
}

const (
	manageCred = "5b6c0f2e-0000-4000-8000-000000000001"
	manageChd  = "chd_COMMANDDESTROY0123456789"
)

// manageFixture is a token file, a destroy file, a state file with one machine in it and a provider that holds it.
func manageFixture(t *testing.T) (args []string, p *manageProvider, rev *manageRevoker, statePath, destroyFile string) {
	t.Helper()
	tf, _, base, _ := machineFixture(t)
	p = &manageProvider{machineStubProvider: base}
	dir := t.TempDir()
	statePath = filepath.Join(dir, "machines.json")
	state := `{"version":1,"machines":[{"name":"m1","provider":"stubcloud","region":"nyc3","launch_tag":"coral-launch-0123456789ab","droplet_id":"77","vpc_id":"vpc-1","firewall_id":"fw-2","credential_id":"` + manageCred + `","created":"2026-10-29T10:00:00Z"}]}`
	if err := os.WriteFile(statePath, []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	destroyFile = filepath.Join(dir, "destroy")
	if err := os.WriteFile(destroyFile, []byte(manageChd+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	p.drops = []machinelaunch.Instance{{ID: "77", Name: "m1", Tags: []string{machinelaunch.Tag}, Region: "nyc3", Size: "s-2vcpu-4gb", Status: machinelaunch.StatusRunning, Created: time.Now().Add(-26 * time.Hour)}}
	newMachineProvider = func(name, token string) (machinelaunch.Provider, error) {
		if name != "digitalocean" {
			return nil, errors.New("unknown provider")
		}
		base.token = token
		return p, nil
	}
	rev = &manageRevoker{log: &p.log}
	oldR := newMachineRevoker
	newMachineRevoker = func(baseURL, destroyKey string) machinelaunch.IdentityRevoker { rev.key = destroyKey; return rev }
	t.Cleanup(func() { newMachineRevoker = oldR })
	return []string{"--provider", "digitalocean", "--token-file", tf, "--state-file", statePath}, p, rev, statePath, destroyFile
}

func runManage(args ...string) (int, string, string) {
	var out, errb bytes.Buffer
	code := runMachine(args, strings.NewReader(""), &out, &errb)
	return code, out.String(), errb.String()
}

func TestMachineListJoinsTheProviderAndTheStateFile(t *testing.T) {
	args, p, _, _, _ := manageFixture(t)
	p.drops = append(p.drops, machinelaunch.Instance{ID: "88", Name: "stray", Tags: []string{machinelaunch.Tag}, Region: "nyc3", Size: "s-1vcpu-1gb", Created: time.Now().Add(-3 * time.Hour)})
	code, out, errb := runManage(append([]string{"list"}, args...)...)
	if code != 0 {
		t.Fatalf("exit %d: %s %s", code, out, errb)
	}
	for _, want := range []string{"NAME", "m1", "stray", "ids kept", "no state file entry", "$/HOUR"} {
		if !strings.Contains(out, want) {
			t.Errorf("list output lacks %q:\n%s", want, out)
		}
	}
	for _, secret := range []string{"dop_v1_COMMANDTOKEN", manageChd} {
		if strings.Contains(out+errb, secret) {
			t.Errorf("a secret is in the output: %s", secret)
		}
	}
}

func TestMachineDeleteRevokesWithTheDestroyFileThenDestroysAndDropsTheRecord(t *testing.T) {
	args, p, rev, statePath, destroy := manageFixture(t)
	code, out, errb := runManage(append([]string{"delete", "m1", "--yes", "--hub-destroy-file", destroy, "--hub-url", "https://hub.example"}, args...)...)
	if code != 0 {
		t.Fatalf("exit %d: %s %s", code, out, errb)
	}
	if got := strings.Join(p.log, ","); got != "revoke:"+manageCred+",delete:77,firewall:fw-2,vpc:vpc-1" {
		t.Fatalf("the Hub identity is revoked first, then the instance, the firewall and the VPC: %s", got)
	}
	if rev.key != manageChd {
		t.Fatalf("the destroy credential from the file reached the Hub client: %q", rev.key)
	}
	b, _ := os.ReadFile(statePath)
	if strings.Contains(string(b), `"m1"`) {
		t.Fatalf("the record is gone: %s", b)
	}
	if strings.Contains(out+errb, manageChd) || strings.Contains(out+errb, "dop_v1_COMMANDTOKEN") {
		t.Fatalf("a secret is in the output: %s %s", out, errb)
	}
	if !strings.Contains(out, "Deleted m1") {
		t.Fatalf("output: %s", out)
	}
}

func TestMachineDeleteNeedsAnAnswerAndStopsWhenTheRevokeFails(t *testing.T) {
	args, p, rev, _, destroy := manageFixture(t)
	if code, _, errb := runManage(append([]string{"delete", "m1", "--hub-destroy-file", destroy}, args...)...); code != 2 || !strings.Contains(errb, "pass --yes") {
		t.Fatalf("no terminal and no --yes: exit %d %s", code, errb)
	}
	if len(p.log) != 0 {
		t.Fatalf("nothing was done: %v", p.log)
	}

	rev.err = &machinelaunch.IdentityRevokeError{Kind: machinelaunch.RevokeNotConfigured, Status: 503}
	code, _, errb := runManage(append([]string{"delete", "m1", "--yes", "--hub-destroy-file", destroy}, args...)...)
	if code != 1 || !strings.Contains(errb, "NOT revoked") || !strings.Contains(errb, "nothing was destroyed") {
		t.Fatalf("a failed revoke stops the delete: exit %d %s", code, errb)
	}
	for _, c := range p.log {
		if strings.HasPrefix(c, "delete:") {
			t.Fatalf("something was destroyed: %v", p.log)
		}
	}
	code, out, errb := runManage(append([]string{"delete", "m1", "--yes", "--hub-destroy-file", destroy, "--continue-if-revoke-fails"}, args...)...)
	if code != 0 || !strings.Contains(out, "Note:") || !strings.Contains(out, "NOT revoked") {
		t.Fatalf("on request it goes on and says so: exit %d %s %s", code, out, errb)
	}
}

func TestMachineDeleteWithoutADestroyFileSaysTheIdentityIsNotRevoked(t *testing.T) {
	args, _, rev, _, _ := manageFixture(t)
	code, out, errb := runManage(append([]string{"delete", "--yes", "m1"}, args...)...)
	if code != 0 {
		t.Fatalf("exit %d: %s %s", code, out, errb)
	}
	if len(rev.ids) != 0 || !strings.Contains(out, "--hub-destroy-file") {
		t.Fatalf("no revoke, and it says why: %v %s", rev.ids, out)
	}
}

func TestMachinePruneNeedsAnAgeAndRemovesOrphansAfterConfirmation(t *testing.T) {
	args, p, _, _, _ := manageFixture(t)
	p.drops = append(p.drops, machinelaunch.Instance{ID: "90", Name: "orphan", Tags: []string{machinelaunch.Tag}, Created: time.Now().Add(-100 * time.Hour)})
	if code, _, errb := runManage(append([]string{"prune", "--yes"}, args...)...); code != 2 || !strings.Contains(errb, "--older-than") {
		t.Fatalf("an age is needed: %d %s", code, errb)
	}
	if code, _, errb := runManage(append([]string{"prune", "--older-than", "soon", "--yes"}, args...)...); code != 2 || !strings.Contains(errb, "not a duration") {
		t.Fatalf("a bad age: %d %s", code, errb)
	}
	if code, _, _ := runManage(append([]string{"prune", "--older-than", "24h"}, args...)...); code != 2 {
		t.Fatalf("no terminal and no --yes: nothing is removed")
	}
	if len(p.log) != 0 {
		t.Fatalf("nothing was removed yet: %v", p.log)
	}
	code, out, errb := runManage(append([]string{"prune", "--older-than", "2d", "--yes"}, args...)...)
	got := strings.Join(p.log, ",")
	if code != 0 || got != "delete:90" || !strings.Contains(out, "Removed: orphan") {
		t.Fatalf("only the old orphan, not the machine in the state file: exit %d log %s out %s %s", code, got, out, errb)
	}
}

func TestMachineManageRefusesUnsafeFilesAndUnknownProviders(t *testing.T) {
	args, _, _, statePath, destroy := manageFixture(t)
	if err := os.Chmod(statePath, 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _, errb := runManage(append([]string{"list"}, args...)...); code != 2 || !strings.Contains(errb, "readable by others") {
		t.Fatalf("a state file others can read: %d %s", code, errb)
	}
	_ = os.Chmod(statePath, 0o600)
	if err := os.Chmod(destroy, 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _, errb := runManage(append([]string{"delete", "m1", "--yes", "--hub-destroy-file", destroy}, args...)...); code != 2 || !strings.Contains(errb, "destroy credential") || strings.Contains(errb, manageChd) {
		t.Fatalf("a destroy file others can read: %d %s", code, errb)
	}
	if code, _, errb := runManage("list", "--provider", "nope", "--token-file", args[3], "--state-file", statePath); code != 2 {
		t.Fatalf("an unknown provider: %d %s", code, errb)
	}
	if code, _, _ := runManage("delete"); code != 2 {
		t.Fatalf("usage")
	}
}

// coral machine egress-files writes the three files as the user-data puts them, with their modes, and needs no provider and no secret.
func TestMachineEgressFilesWritesTheBlocksFiles(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "egress")
	code, out, errb := runManage("egress-files", "--dir", dir)
	if code != 0 {
		t.Fatalf("exit %d: %s %s", code, out, errb)
	}
	for _, f := range machinelaunch.EgressFiles() {
		b, err := os.ReadFile(filepath.Join(dir, filepath.Base(f.Path)))
		if err != nil || string(b) != f.Content {
			t.Fatalf("%s: %v", f.Path, err)
		}
		if fi, _ := os.Stat(filepath.Join(dir, filepath.Base(f.Path))); fi.Mode().Perm() != map[string]os.FileMode{"0600": 0o600, "0644": 0o644, "0700": 0o700}[f.Mode] {
			t.Fatalf("%s has mode %v, want %s", f.Path, fi.Mode().Perm(), f.Mode)
		}
		if !strings.Contains(out, f.Path) {
			t.Fatalf("the output says where each goes: %s", out)
		}
	}
	if code, _, _ := runManage("egress-files"); code != 2 {
		t.Fatalf("a folder is needed")
	}
}
