package machinelaunch

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"time"
	"unicode/utf8"
)

// Options is what one launch is asked to make.
type Options struct {
	Name    string   // the machine's name (a host name); it is also the credential's label, so the person recognises the machine in Coral Hub
	Region  string   // the provider's region slug
	Size    string   // the provider's size slug
	Image   string   // "" is the provider's default
	SSHKeys []string // provider ids or fingerprints; none by default
	Yes     bool     // skip the confirm prompt (and only that)
	HubURL  string   // the Hub's origin, printed as the place to approve the machine
	SSHFrom string   // the address SSH is open to on the machine (shown in the confirm); the user-data builder is given the same one
	// SSHFromLookup is where SSHFrom was looked up when the person did not give it ("api.ipify.org"); "" when they gave it. The confirm says so: the lookup tells that service this computer's address.
	SSHFromLookup string
	Wait          time.Duration
	// RetryListAfter is how long a launch whose create timed out waits before it looks once more for a machine it may have made (a provider's list can lag the create); 0 is 60 seconds.
	RetryListAfter time.Duration
}

// Deps are what a launch uses; tests give it stubs.
type Deps struct {
	Provider Provider
	Hub      Minter
	// Keys makes the launch's own keys; nil is NewBootKeys. A test gives it fixed ones.
	Keys func() (*BootKeys, error)
	// UserData makes the cloud-init user-data for a launch's keys (BuildUserData with the rest of its spec closed over). It carries the keys' PUBLIC login half and the host key the machine presents, and never a credential.
	UserData func(keys *BootKeys) (string, error)
	// Bootstrap hands the machine the Hub's credential over SSH once it runs, after the pinned handshake (an SSHBootstrap).
	Bootstrap Bootstrapper
	// Revoker revokes a credential this launch minted when the launch fails after the mint; nil uses Hub when it can (HubClient does).
	Revoker Revoker
	// Isolate makes the launch's own VPC and cloud firewall (SSH in from Options.SSHFrom only, until the credential is delivered) and puts the machine in them (#10918). The command line always sets it; a
	// provider that cannot is refused.
	Isolate bool
	// State, when set, is the state file the launch writes its ids to as they come into being (nil: none).
	State *State
	// Confirm shows the summary and asks; nil means no one can be asked, so only Options.Yes goes on.
	Confirm func(summary string) (bool, error)
	// Interrupt is closed (or sent on) when the person interrupts a SECOND time: it ends the sweep's wait at once. nil never fires.
	Interrupt <-chan struct{}
	Out       io.Writer
}

// Revoker revokes the credential minted for a machine's label (and the identity enrolled from it, if it was redeemed).
type Revoker interface {
	Revoke(ctx context.Context, label string) error
}

// Result is a machine that was launched.
type Result struct {
	Instance   Instance
	Enrollment BootResult // what the machine's own Coral said once it had the credential
}

// ErrDeclined is a person who said no at the confirm.
var ErrDeclined = errors.New("not confirmed: nothing was created")

var nameShape = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,62})$`)

const defaultWait = 5 * time.Minute

// Launch makes one machine (the joint note's slice 2, changed by #10917): it checks the provider token, shows what it will cost and asks, makes the launch's own keys, creates the instance with user-data that
// holds NO credential, waits for the INSTANCE to run, connects over SSH with the machine's host key pinned, and only then mints a one-time credential labelled with the machine's name and writes it to the machine
// on standard input; the machine's own Coral is asked whether it enrolled (the Hub's side is not read: the key cannot list anything and the machine lands pending until the person keeps it), and the person is told
// where to approve it. An instance it created is deleted again when anything after the create fails (an SSH host key that is not the pin included, which is never retried) or the caller cancels. Nothing it prints
// holds a token or the credential.
func Launch(ctx context.Context, o Options, d Deps) (*Result, error) {
	if d.Provider == nil || d.Hub == nil || d.UserData == nil || d.Bootstrap == nil || d.Out == nil {
		return nil, errors.New("launch is missing a provider, a Hub client, a user-data builder, a bootstrap or an output")
	}
	if !nameShape.MatchString(o.Name) {
		return nil, errors.New("the machine name must be 1 to 63 of a-z, 0-9 and hyphen, not starting with a hyphen")
	}
	if o.Region == "" || o.Size == "" {
		return nil, errors.New("a region and a size are needed")
	}
	if d.State != nil { // a name that is already recorded is refused before the provider is asked anything: the record is keyed by name, and a second launch must never replace the first one's ids
		if _, ok := d.State.Get(o.Name); ok {
			return nil, fmt.Errorf("%w: a machine named %q is already recorded: delete it first (coral machine delete %s) or choose another name", ErrRecordExists, o.Name, o.Name)
		}
	}
	wait := o.Wait
	if wait <= 0 {
		wait = defaultWait
	}
	p := d.Provider
	// The Hub is asked first, while nothing exists: a Hub that does not serve machine credentials (yet) is refused here, not after a billable machine is up and the credential cannot be minted (#12584).
	if pf, ok := d.Hub.(Preflighter); ok {
		if err := pf.Preflight(ctx); err != nil {
			if errors.Is(err, ErrHubBootstrapOff) {
				return nil, fmt.Errorf("%w; nothing was created at %s: run this again once Coral Hub says machine credentials are enabled", err, p.Name())
			}
			return nil, err
		}
	}

	if err := p.Validate(ctx); err != nil {
		if errors.Is(err, ErrUnauthorized) {
			return nil, fmt.Errorf("%s did not accept the token: make a new one with the narrowest scope that can create, read and delete droplets", p.Name())
		}
		return nil, fmt.Errorf("could not check the %s token: %w", p.Name(), err)
	}
	price, err := p.Price(ctx, o.Region, o.Size)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, fmt.Errorf("%s does not offer size %s in %s", p.Name(), o.Size, o.Region)
		}
		return nil, fmt.Errorf("could not read the price of %s: %w", o.Size, err)
	}
	summary := fmt.Sprintf("Create machine %q on %s: size %s in %s, about $%.4f an hour ($%.2f a month) until you delete it. It runs Coral and joins Coral Hub as a pending machine you approve there. "+
		"Coral Hub's credential is never put in the machine's user-data: it is sent over SSH once the machine's host key matches the one this launch made. A single-use SSH host key and this launch's public login key "+
		"do sit in the user-data, which the provider keeps readable; the key stops working when setup finishes (SSH is closed and the key deleted on the machine). Until then SSH accepts only %s%s.",
		o.Name, p.Name(), o.Size, o.Region, price.HourlyUSD, price.MonthlyUSD, sshFromWords(o.SSHFrom), sshLookupWords(o.SSHFromLookup))
	if d.Isolate {
		summary += " " + isolationWords(o.SSHFrom)
	}
	if !o.Yes {
		if d.Confirm == nil {
			return nil, errors.New("no one can be asked to confirm: pass --yes to go on without asking")
		}
		ok, err := d.Confirm(summary)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, ErrDeclined
		}
	} else {
		fmt.Fprintln(d.Out, summary)
	}

	newKeys := d.Keys
	if newKeys == nil {
		newKeys = NewBootKeys
	}
	keys, err := newKeys()
	if err != nil {
		return nil, err
	}
	defer keys.Destroy() // the launch's keys live in memory for the length of the launch
	launchTag, err := newLaunchTag()
	if err != nil {
		return nil, err
	}
	userData, err := d.UserData(keys) // nothing is made at the provider before the user-data is known good
	if err != nil {
		return nil, err
	}
	ls := newLaunchState(d.State, o, p.Name(), launchTag)
	if err := ls.reserve(); err != nil { // the name is claimed under the state file's lock before anything is made
		return nil, err
	}
	var net *Net
	spec := Spec{Name: o.Name, Region: o.Region, Size: o.Size, Image: o.Image, Tags: []string{Tag, launchTag}, UserData: userData, SSHKeys: o.SSHKeys}
	if d.Isolate { // createNetwork: the machine is made inside its own VPC and firewall, never before them
		if net, err = CreateNetwork(ctx, p, o.Name, o.Region, launchTag, []string{o.SSHFrom}, d.Out); err != nil {
			ls.drop() // nothing was made that the record could name: the claimed name is released
			return nil, err
		}
		spec.VPCID = net.VPC.ID
		ls.set(func(r *Record) { r.VPCID, r.FirewallID, r.FirewallOpen = net.VPC.ID, net.Firewall.ID, true }, d.Out)
	}
	want := sweepWant{Name: o.Name, Region: o.Region, Size: o.Size, Since: time.Now()}
	inst, err := p.Create(ctx, spec)
	userData, spec.UserData = "", "" // not kept past the call
	if err != nil {
		// A create that failed on the way (transport error, timeout, Ctrl-C) may still have made the machine: one with this launch's tag and name is deleted, then its network.
		note, clean := sweepAfterFailedCreate(p, launchTag, want, err, retryAfter(o), d.Interrupt, d.Out)
		if clean {
			note += teardownNetworkOnly(p, net, ls, d.Out)
			if net == nil {
				ls.drop() // no network and the create is settled (a 4xx, or nothing landed): the claimed name is released
			}
		} else if net != nil { // the machine may still exist: its firewall and VPC stay, with their ids and the one command that removes them later (Security's ruling, #9934)
			fmt.Fprintf(d.Out, "The launch's firewall %s and private network %s were left in place, so a machine that appears late is not unfiltered. When the machine is gone, remove them with: coral machine delete %s --provider %s --token-file <the token file>\n", net.Firewall.ID, net.VPC.ID, o.Name, p.Name())
			note += fmt.Sprintf("; firewall %s and private network %s were left in place: `coral machine delete %s` removes them once the machine is gone", net.Firewall.ID, net.VPC.ID, o.Name)
		}
		return nil, fmt.Errorf("could not create the machine: %w%s", err, note)
	}
	ls.set(func(r *Record) { r.DropletID = inst.ID }, d.Out)
	fmt.Fprintf(d.Out, "Created %s (%s); waiting for it to run ...\n", inst.Name, inst.ID)

	wctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	running, err := p.WaitRunning(wctx, inst.ID)
	if err != nil {
		note := teardownLaunch(p, inst.ID, net, ls, d.Out)
		if errors.Is(wctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
			return nil, fmt.Errorf("the machine was not running within %s%s", wait, note)
		}
		return nil, fmt.Errorf("the machine did not come up: %w%s", err, note)
	}
	fmt.Fprintf(d.Out, "The machine is running at %s; connecting over SSH with its pinned host key ...\n", running.IPv4)
	minted := false
	boot, err := d.Bootstrap.Bootstrap(ctx, BootRequest{Instance: running, Keys: keys, Out: d.Out, Mint: func(ctx context.Context) (string, error) { // the credential is minted inside, after the handshake
		c, err := d.Hub.Mint(ctx, o.Name)
		minted = minted || err == nil
		if err == nil { // the id of the credential (not the credential) goes to the state file AT ONCE: a crash between here and the end still leaves `coral machine delete` able to revoke the machine's Hub identity by it (#10944)
			if h, ok := d.Hub.(credentialIDer); ok {
				if id := h.CredentialID(o.Name); id != "" {
					ls.set(func(r *Record) { r.CredentialID = id }, d.Out)
				}
			}
		}
		return c, err
	}})
	if err != nil {
		note := teardownLaunch(p, inst.ID, net, ls, d.Out)
		if minted { // a credential that was minted and not used up must not stay valid at the Hub (Security's SHOULD 2 on #10917)
			note += revokeMinted(d, o.Name)
		}
		switch {
		case errors.Is(err, ErrHostKeyMismatch):
			return nil, fmt.Errorf("%w; it was not retried%s", err, note)
		case ctx.Err() != nil:
			return nil, fmt.Errorf("interrupted while setting the machine up: %w%s", err, note)
		default:
			return nil, fmt.Errorf("the machine did not take its credential: %w%s", err, note)
		}
	}
	// The name to look for at the Hub is the one THIS launch minted the credential under, never the one the machine reports about itself (a compromised machine could name another pending machine). The machine's own
	// claim is shown only when it differs, marked as the machine's own.
	label := o.Name
	own := ""
	if boot.Label != "" && boot.Label != o.Name {
		own = fmt.Sprintf(" (the machine itself reports the name %q: that is its own claim, not what this launch minted)", clipLabel(boot.Label))
	}
	var closeErr error
	if net != nil { // the credential is delivered, so nothing is allowed in at the cloud firewall (the machine closes its own SSH too)
		cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		if closeErr = CloseDoor(cctx, p, net.Firewall); closeErr == nil {
			ls.set(func(r *Record) { r.FirewallOpen = false }, d.Out)
			fmt.Fprintln(d.Out, "Closed the cloud firewall: nothing is allowed in.")
		}
		cancel()
	}
	if boot.State == "connected" {
		fmt.Fprintf(d.Out, "Launched %s at %s; its Coral is connected to Coral Hub. It is pending there: open %s, find %q and press Keep to approve it.%s\n", running.Name, running.IPv4, o.HubURL, label, own)
	} else { // only "connecting": the machine has not confirmed that it reached the Hub, and this says so rather than "Launched"
		fmt.Fprintf(d.Out, "The machine %s at %s reported connecting to Coral Hub, and has not confirmed it yet. Open %s and look for %q: if it is pending there, press Keep to approve it; if it does not show up in a few minutes, delete the machine.%s\n", running.Name, running.IPv4, o.HubURL, label, own)
	}
	res := &Result{Instance: running, Enrollment: boot}
	if closeErr != nil { // SSH is still open at the firewall: a launch that opened SSH and cannot say it closed it did not finish (Security's ruling v). The record keeps firewall_open, so `coral machine delete` tries again and nothing says clean.
		fw := net.Firewall.ID
		fmt.Fprintf(d.Out, "SSH IS STILL OPEN to %s on firewall %s at %s: %v\nClose it now: coral machine delete %s --provider %s --token-file <the token file> (it removes the machine and this firewall), or remove the inbound rule of firewall %s at %s yourself.\n",
			SSHRule(o.SSHFrom), fw, p.Name(), closeErr, o.Name, p.Name(), fw, p.Name())
		return res, fmt.Errorf("the launch did not finish: SSH is still open to %s on firewall %s (%w); run `coral machine delete %s` to close it", SSHRule(o.SSHFrom), fw, closeErr, o.Name)
	}
	return res, nil
}

// cleanup deletes the instance a failed launch made, on its own short deadline (the caller's context may be the thing that ended), and says how that went in a sentence for the error.
func cleanup(p Provider, id string, out io.Writer) string {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	switch err := p.Delete(ctx, id); {
	case err == nil || errors.Is(err, ErrNotFound):
		fmt.Fprintln(out, "The machine this launch created was deleted.")
		return "; the machine this launch created was deleted"
	default:
		fmt.Fprintf(out, "Could not delete machine %s: delete it yourself at %s, it costs money while it exists.\n", id, p.Name())
		return fmt.Sprintf("; it could NOT be deleted (id %s): delete it yourself at %s", id, p.Name())
	}
}

// newLaunchTag is the tag only this launch's instance carries ("coral-launch-" and 32 hex digits, 128 random bits): what a clean-up after a failed Create finds it by, never its name.
func newLaunchTag() (string, error) {
	var b [16]byte // 128 bits (Security ruling, #9934): a sweep after a timed-out create deletes by this tag
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("could not make a launch tag: %w", err)
	}
	return "coral-launch-" + hex.EncodeToString(b[:]), nil
}

// isTimeout reports whether err is a deadline or a network timeout.
func isTimeout(err error) bool {
	var ne net.Error
	return errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout())
}

// retryAfter is the wait between the sweep's two looks.
func retryAfter(o Options) time.Duration {
	if o.RetryListAfter > 0 {
		return o.RetryListAfter
	}
	return defaultSweepWait
}

// maxClaimedLabel is the most of a machine's own claimed name that is printed.
const maxClaimedLabel = 80

// clipLabel cuts a name the machine reported to maxClaimedLabel characters, on a character boundary, and adds an ellipsis when it cut: the machine's status answer may be up to 64 KB and none of it should fill the terminal.
func clipLabel(s string) string {
	if utf8.RuneCountInString(s) <= maxClaimedLabel {
		return s
	}
	r := []rune(s)
	return string(r[:maxClaimedLabel]) + "…"
}

// sshFromWords is the address SSH is open to, for the confirm.
func sshFromWords(v string) string {
	if v == "" {
		return "the address of this computer"
	}
	return SSHRule(v) // the rule exactly: address, prefix and how many addresses it opens
}

// sshLookupWords says where the SSH address came from when the person did not give it.
func sshLookupWords(lookup string) string {
	if lookup == "" {
		return ""
	}
	return " (this computer's address, looked up at " + lookup + ", a service outside Coral that sees this computer's address; pass --allow-ssh-from to skip the lookup)"
}

// expiryWords says when the minted credential stops working, from the Hub's own expires_at when the Hub client has it; otherwise only that it expires (no number of minutes is guessed).
func expiryWords(d Deps, label string) string {
	if e, ok := d.Hub.(interface {
		ExpiresAt(string) (time.Time, bool)
	}); ok {
		if t, known := e.ExpiresAt(label); known {
			return "it expires at " + t.UTC().Format("15:04:05Z") + " on its own"
		}
	}
	return "it expires on its own"
}

// revokeMinted revokes the credential this launch minted, on its own short deadline, and says how that went in a sentence for the error and a line for the person.
func revokeMinted(d Deps, label string) string {
	r := d.Revoker
	if r == nil {
		r, _ = d.Hub.(Revoker)
	}
	if r == nil {
		fmt.Fprintf(d.Out, "The Coral Hub credential for %q could not be revoked from here: %s; revoke the machine in Coral Hub if it enrolled.\n", label, expiryWords(d, label))
		return "; the Coral Hub credential could NOT be revoked from here (" + expiryWords(d, label) + ")"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := r.Revoke(ctx, label); err != nil {
		fmt.Fprintf(d.Out, "The Coral Hub credential for %q could NOT be revoked (%v): %s; if the machine enrolled, revoke it in Coral Hub.\n", label, err, expiryWords(d, label))
		return "; the Coral Hub credential could NOT be revoked (" + expiryWords(d, label) + "; if the machine enrolled, revoke it in Coral Hub)"
	}
	fmt.Fprintf(d.Out, "The Coral Hub credential for %q was revoked.\n", label)
	return "; the Coral Hub credential was revoked"
}
