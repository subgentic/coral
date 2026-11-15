package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/subgentic/coral/internal/clihelp"
	"github.com/subgentic/coral/internal/machineprobe"
)

// resourceSetupUsage is the help of resource setup (#17588).
const resourceSetupUsage = `Usage: coral-board resource setup <box>... [--pool NAME] [--slots N] [--description "..."] [--dry-run]

Tell Coral the computers once. For each box: read what it is over ssh (OS, cores, memory, and whether Go, node and Chrome are there), run one tiny Go test on it, then define its resource with slots sized to it,
its facts and weight, and a description. Run it again to update a box (Go upgraded, a box back up): facts and weight follow the box; the slots, the lease, who may claim it and a description a person set are kept unless --slots or --description is given.
A box is <alias> (an ssh alias, also the resource's name), <name>=<alias>, or here (this machine: the resource is named after it, or use <name>=here). A box that cannot be read, or whose check fails, is left as it was and the command exits 1.
--pool NAME adds each box to that pool (made first with resource define NAME --pool ...). --slots N sets the slots instead of sizing them. --dry-run reads and checks, and defines nothing.
Windows over ssh is not set up this way yet: define it with resource define.`

var (
	boxAliasRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@-]{0,100}$`)
	boxNameRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)
)

// boxRun runs a fixed script on a box and answers what it printed: here with sh, or on the ssh alias through "sh -s" (the script goes in on stdin, so the remote login shell never parses it). A test replaces it.
var boxRun = func(alias string, here bool, script string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var cmd *exec.Cmd
	if here {
		cmd = exec.CommandContext(ctx, "sh", "-s")
	} else {
		cmd = exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", "--", alias, "sh -s")
	}
	cmd.Stdin = strings.NewReader(script)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	if ctx.Err() != nil {
		return out.String(), fmt.Errorf("no answer in %s", timeout)
	}
	if err != nil {
		return out.String(), fmt.Errorf("%v: %s", err, strings.TrimSpace(lastLine(errb.String())))
	}
	return out.String(), nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}

// plainLine is what a box said, made safe to print: control characters (escape sequences, bell, NUL), format and line-separator characters are dropped, so a hostile box cannot write into the terminal (Security, #17894).
func plainLine(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			return ' '
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp):
			return -1
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

// checkPassed: the check test printed its own "ok" line and reached the end, with no FAIL: a missing toolchain or a build error prints neither and is not a pass (Security, #17894).
func checkPassed(out string) bool {
	if !strings.Contains(out, "check-end") {
		return false
	}
	ok := false
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(l)
		switch {
		case strings.Contains(l, "FAIL"):
			return false
		case strings.HasPrefix(l, "ok ") || strings.HasPrefix(l, "ok\t"):
			ok = true
		}
	}
	return ok
}

type setupBox struct {
	name, alias string
	here        bool
}

func parseBoxes(args []string) ([]setupBox, error) {
	var boxes []setupBox
	seen := map[string]bool{}
	for _, a := range args {
		name, target, named := strings.Cut(a, "=")
		if !named {
			target, name = a, ""
		}
		b := setupBox{alias: target, name: name}
		if target == "here" {
			b.here = true
			if name == "" {
				h, _ := os.Hostname()
				b.name = strings.ToLower(strings.TrimSuffix(strings.SplitN(h, ".", 2)[0], "-local"))
			}
		} else {
			if !boxAliasRe.MatchString(target) {
				return nil, fmt.Errorf("%q is not an ssh alias (letters, digits, dot, dash, underscore, @)", target)
			}
			if b.name == "" {
				b.name = target
			}
		}
		if !boxNameRe.MatchString(b.name) {
			return nil, fmt.Errorf("%q is not a resource name (letters, digits, dot, dash, underscore); give one: name=%s", b.name, target)
		}
		if seen[b.name] {
			return nil, fmt.Errorf("%s is given twice", b.name)
		}
		seen[b.name] = true
		boxes = append(boxes, b)
	}
	return boxes, nil
}

// resView is the part of a resource's definition setup carries over when it redefines it.
type setupView struct {
	Slots       int      `json:"slots"`
	Machine     string   `json:"machine"`
	Where       string   `json:"where"`
	MaxLease    int      `json:"max_lease_seconds"`
	Members     []string `json:"members"`
	Allowed     []string `json:"allowed"`
	Match       []string `json:"match"`
	Description string   `json:"description"`
}

func getSetupView(name string) (*setupView, error) {
	data, status, err := resourceCall("GET", "/"+name, nil)
	if err == nil && status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil || status != http.StatusOK {
		return nil, fmt.Errorf("could not read %s: %v (%d)", name, err, status)
	}
	var v setupView
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, err
	}
	return &v, nil
}

// carry puts back what a person set on an existing resource, which a PUT would otherwise clear.
func (v *setupView) carry(body map[string]any) {
	if v == nil {
		return
	}
	if v.MaxLease > 0 {
		body["max_lease_seconds"] = v.MaxLease
	}
	if len(v.Allowed) > 0 {
		body["allowed"] = v.Allowed
	}
	if len(v.Match) > 0 {
		body["match"] = v.Match
	}
}

func resourceSetup(rest []string) {
	fs := flag.NewFlagSet("resource-setup", flag.ContinueOnError)
	pool := fs.String("pool", "", "add each box to this pool")
	slots := fs.Int("slots", 0, "slots for each box, instead of sizing them")
	desc := fs.String("description", "", "replace the description (default: kept; a new resource gets one made from what the box is)")
	dry := fs.Bool("dry-run", false, "read and check the boxes, define nothing")
	// the boxes and the flags may come in any order: parse, take one box, parse the rest
	var boxArgs []string
	for args := rest; ; {
		clihelp.ParseFlags(fs, args, func() string { return resourceSetupUsage })
		a := fs.Args()
		if len(a) == 0 {
			break
		}
		boxArgs = append(boxArgs, a[0])
		args = a[1:]
	}
	boxes, err := parseBoxes(boxArgs)
	if err != nil || len(boxes) == 0 {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
		fmt.Fprintln(os.Stderr, resourceSetupUsage)
		exitFn(1)
		return
	}
	// who may not define reaches no ssh: ask the server before any box is read (Security, #17894)
	if err := mayDefine(boxes[0].name); err != nil {
		fmt.Fprintln(os.Stderr, "resource setup: "+err.Error())
		exitFn(1)
		return
	}
	failed := 0
	var added []string
	for _, b := range boxes {
		ok := setupOne(b, *slots, *desc, *dry)
		if !ok {
			failed++
			continue
		}
		added = append(added, b.name)
	}
	if *pool != "" && !*dry && len(added) > 0 {
		if err := addToPool(*pool, added); err != nil {
			fmt.Fprintln(os.Stderr, "Could not add to pool "+*pool+": "+err.Error())
			failed++
		} else {
			fmt.Printf("Pool %s: %s.\n", *pool, strings.Join(added, ", "))
		}
	}
	if failed > 0 {
		exitFn(1)
	}
}

// mayDefine asks the server whether the caller may define resources, defining nothing (PUT ?check=1 with a body an older server refuses as not a definition).
func mayDefine(name string) error {
	data, status, err := resourceCall("PUT", "/"+name+"?check=1", map[string]any{"slots": -1})
	if err != nil {
		return fmt.Errorf("could not ask the server whether you may define resources: %v", err)
	}
	if status != http.StatusOK {
		why := plainLine(string(data))
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &e) == nil && e.Error != "" {
			why = plainLine(e.Error)
		}
		return fmt.Errorf("not set up, no box was read: %s (%d)", why, status)
	}
	return nil
}

func setupOne(b setupBox, slotsFlag int, desc string, dry bool) bool {
	fail := func(why string) bool {
		fmt.Fprintf(os.Stderr, "%s: not set up (left as it was): %s\n", b.name, why)
		return false
	}
	old, err := getSetupView(b.name)
	if err != nil && !dry {
		return fail(err.Error())
	}
	if old != nil && len(old.Members) > 0 {
		return fail(b.name + " is a pool with members; setup defines a single box and would replace the pool (use --pool " + b.name + " to add boxes to it)")
	}
	out, err := boxRun(b.alias, b.here, machineprobe.Script, 30*time.Second)
	if err != nil {
		return fail("could not read the machine over ssh: " + plainLine(err.Error()))
	}
	p, err := machineprobe.Parse(out)
	if err != nil {
		return fail(plainLine(err.Error()))
	}
	check := "no Go on it, so no test was run"
	if p.Go != "" {
		start := time.Now()
		cout, err := boxRun(b.alias, b.here, machineprobe.CheckScript, 3*time.Minute)
		if err != nil || !checkPassed(cout) {
			return fail("the check test did not pass: " + plainLine(lastLine(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(cout), "check-end"))+" "+errString(err))))
		}
		check = fmt.Sprintf("check test passed (%.1fs)", time.Since(start).Seconds())
	}
	n, kept := p.Slots(), ""
	switch {
	case slotsFlag > 0:
		n = slotsFlag
	case old != nil && old.Slots > 0:
		n, kept = old.Slots, " (kept: a person set them; --slots N changes it)" // slots are a limit on how hard the box is worked: only a person raises it
	}
	summary := fmt.Sprintf("%s %s, %d cores, %d GB; %d slot(s)%s, weight %d; %s", p.OS, p.Arch, p.Cores, p.MemGB(), n, kept, p.Weight(), check)
	if dry {
		fmt.Printf("%s: would define: %s\n", b.name, summary)
		return true
	}
	body := map[string]any{"slots": n, "machine": b.name, "facts": p.Facts(), "weight": p.Weight()}
	body["where"] = "remote"
	if b.here {
		body["where"] = "here"
	}
	old.carry(body)
	switch {
	case desc != "":
		body["description"] = desc
	case old == nil || old.Description == "":
		body["description"] = p.Description(b.alias, b.here)
	}
	data, status, err := resourceCall("PUT", "/"+b.name, body)
	if err != nil || status != http.StatusOK {
		return fail("the server refused it: " + errString(err) + " " + strings.TrimSpace(string(data)))
	}
	verb := "defined"
	if old != nil {
		verb = "updated"
	}
	fmt.Printf("%s: %s: %s\n", b.name, verb, summary)
	return true
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// addToPool puts boxes into a pool that already exists, keeping what the pool already has.
func addToPool(name string, boxes []string) error {
	v, err := getSetupView(name)
	if err != nil {
		return err
	}
	if v == nil || len(v.Members) == 0 {
		return fmt.Errorf("%s is not a pool: make it first with resource define %s --pool a,b", name, name)
	}
	members := v.Members
	have := map[string]bool{}
	for _, m := range members {
		have[m] = true
	}
	for _, b := range boxes {
		if !have[b] {
			members = append(members, b)
		}
	}
	body := map[string]any{"slots": 0, "members": members, "machine": v.Machine}
	v.carry(body)
	data, status, err := resourceCall("PUT", "/"+name, body)
	if err != nil || status != http.StatusOK {
		return fmt.Errorf("%s %s", errString(err), strings.TrimSpace(string(data)))
	}
	return nil
}
