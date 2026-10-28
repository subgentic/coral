package machinelaunch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"
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
	Wait    time.Duration
}

// Deps are what a launch uses; tests give it stubs.
type Deps struct {
	Provider Provider
	Hub      Minter
	// UserData makes the cloud-init user-data for a credential (BuildUserData with the rest of its spec closed over): the credential goes into it and nowhere else.
	UserData func(credential string) (string, error)
	// Confirm shows the summary and asks; nil means no one can be asked, so only Options.Yes goes on.
	Confirm func(summary string) (bool, error)
	Out     io.Writer
}

// Result is a machine that was launched.
type Result struct {
	Instance Instance
}

// ErrDeclined is a person who said no at the confirm.
var ErrDeclined = errors.New("not confirmed: nothing was created")

var nameShape = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,62})$`)

const defaultWait = 5 * time.Minute

// Launch makes one machine (the joint note's slice 2): it checks the provider token, shows what it will cost and asks, mints a one-time credential labelled with the machine's name, creates the instance
// with that credential in its user-data, waits for the INSTANCE (the Hub's side is not read: the key cannot list anything and the machine lands pending until the person keeps it), and tells the person
// where to approve it. An instance it created is deleted again when anything after the create fails or the caller cancels. Nothing it prints holds a token or the credential.
func Launch(ctx context.Context, o Options, d Deps) (*Result, error) {
	if d.Provider == nil || d.Hub == nil || d.UserData == nil || d.Out == nil {
		return nil, errors.New("launch is missing a provider, a Hub client, a user-data builder or an output")
	}
	if !nameShape.MatchString(o.Name) {
		return nil, errors.New("the machine name must be 1 to 63 of a-z, 0-9 and hyphen, not starting with a hyphen")
	}
	if o.Region == "" || o.Size == "" {
		return nil, errors.New("a region and a size are needed")
	}
	wait := o.Wait
	if wait <= 0 {
		wait = defaultWait
	}
	p := d.Provider

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
	summary := fmt.Sprintf("Create machine %q on %s: size %s in %s, about $%.4f an hour ($%.2f a month) until you delete it. It runs Coral and joins Coral Hub as a pending machine you approve there.",
		o.Name, p.Name(), o.Size, o.Region, price.HourlyUSD, price.MonthlyUSD)
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

	credential, err := d.Hub.Mint(ctx, o.Name) // minted only now: it lives five minutes from here
	if err != nil {
		return nil, err
	}
	userData, err := d.UserData(credential)
	if err != nil {
		return nil, err
	}
	inst, err := p.Create(ctx, Spec{Name: o.Name, Region: o.Region, Size: o.Size, Image: o.Image, Tags: []string{Tag}, UserData: userData, SSHKeys: o.SSHKeys})
	userData, credential = "", "" // not kept past the call
	if err != nil {
		return nil, fmt.Errorf("could not create the machine: %w", err)
	}
	fmt.Fprintf(d.Out, "Created %s (%s); waiting for it to run ...\n", inst.Name, inst.ID)

	wctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	running, err := p.WaitRunning(wctx, inst.ID)
	if err != nil {
		note := cleanup(p, inst.ID, d.Out)
		if errors.Is(wctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
			return nil, fmt.Errorf("the machine was not running within %s%s", wait, note)
		}
		return nil, fmt.Errorf("the machine did not come up: %w%s", err, note)
	}
	fmt.Fprintf(d.Out, "Launched %s at %s. It is pending in Coral Hub: open %s, find %q and press Keep to approve it.\n", running.Name, running.IPv4, o.HubURL, o.Name)
	return &Result{Instance: running}, nil
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
