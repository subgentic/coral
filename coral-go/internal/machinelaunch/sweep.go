package machinelaunch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"slices"
	"time"
)

// The sweep after a create that may have landed (Security's ruling, #9934, in seven limits). It exists for ONE case: a create that timed out, was cut off or was interrupted, so no id came back and the machine
// may exist anyway. Anything else (a refusal, an auth error, a failure before a request) never sweeps.
//
//  1. The tag is this launch's own (newLaunchTag: 128 random bits, fresh, never typed, put on the create request).
//  2. It LISTS (and prints what it saw), then DELETES BY ID. Nothing here calls a delete-by-tag endpoint.
//  3. Every listed machine must match what THIS launch asked for (name, region, size, made after the launch began) and there must be exactly one; otherwise nothing is deleted and the person is told to check by hand.
//  4. Two looks at most: one at once, one after a bounded wait. A second Ctrl-C ends it at once with the tag and "check by hand".
//  5. Each id is printed as it is deleted, with the tag; a failed delete is printed and the launch ends in an error (no retry loop).
//  6. It uses only the token the launch was given.
//
// sweepNow is the clock the made-at bounds are read against; a test replaces it.
var sweepNow = time.Now

const (
	sweepCallTimeout = 10 * time.Second // each list and each delete
	sweepClockSkew   = time.Minute      // the provider's clock against this computer's: made-at may be this much before the launch began or after now, and no more (not the safety control: the tag, name, region, size and count are)
	defaultSweepWait = 60 * time.Second // between the first look and the second
)

// sweepWant is what the launch asked the provider for: the fields a swept machine must match.
type sweepWant struct {
	Name, Region, Size string
	Since              time.Time // when the launch began (just before the create request)
}

// createMayHaveLanded is whether a failed create is one that may have made the machine anyway: a timeout, a cut-off connection or an interruption with NO answer, or a 5xx answer with no droplet id (a gateway can answer
// after the provider made the machine: Security's correction, #9934). A 4xx proves nothing was created and never sweeps; neither does an auth error.
func createMayHaveLanded(err error) bool {
	var api *APIError
	if errors.As(err, &api) {
		return api.Status >= 500
	}
	if err == nil || errors.Is(err, ErrUnauthorized) || errors.Is(err, ErrNotFound) {
		return false
	}
	var ne net.Error
	return isTimeout(err) || errors.Is(err, context.Canceled) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.As(err, &ne)
}

type sweepKind int

const (
	sweepNone    sweepKind = iota // listed, and nothing carries the tag
	sweepDeleted                  // the one machine was deleted by its id
	sweepRefused                  // nothing (more) was deleted and the person must check by hand
)

// sweepAfterFailedCreate runs the sweep for a failed create. clean is whether the launch can go on to remove its network: true when the create never could have landed, or the machine was found and deleted.
// It is false when the machine may still exist (not found yet, refused, a failed delete), and then the network is left in place so a machine that lands late is not left unprotected.
func sweepAfterFailedCreate(p Provider, tag string, want sweepWant, createErr error, wait time.Duration, interrupt <-chan struct{}, out io.Writer) (note string, clean bool) {
	if !createMayHaveLanded(createErr) {
		return "", true
	}
	l, ok := p.(Lister)
	if !ok {
		return sweepByHand(out, p, tag, want.Name, "this provider cannot list what the launch may have made"), false
	}
	kind, note := sweepOnce(l, p, tag, want, out)
	if kind == sweepNone { // the list can lag the create: once more, after a bounded wait that a second Ctrl-C cuts short
		select {
		case <-time.After(wait):
		case <-interrupt:
			return sweepByHand(out, p, tag, want.Name, "interrupted a second time"), false
		}
		kind, note = sweepOnce(l, p, tag, want, out)
	}
	switch kind {
	case sweepDeleted:
		return note, true
	case sweepNone:
		return sweepByHand(out, p, tag, want.Name, "no machine for this launch has shown up yet"), false
	}
	return note, false
}

// sweepByHand tells the person where to look: the tag value is the line to search for in the provider's console.
func sweepByHand(out io.Writer, p Provider, tag, name, why string) string {
	fmt.Fprintf(out, "%s. Check by hand at %s for a machine tagged %s, or run: coral machine delete %s --provider %s --token-file <the token file>. It costs money while it exists. The launch's network was left in place.\n", capitalise(why), p.Name(), tag, name, p.Name())
	return fmt.Sprintf("; %s: check by hand at %s for a machine tagged %s, or run `coral machine delete %s` (it costs money while it exists; the launch's network was left in place)", why, p.Name(), tag, name)
}

// capitalise turns a leading a-z into its capital and leaves anything else alone (a digit must not become a control character).
func capitalise(s string) string {
	if s == "" || s[0] < 'a' || s[0] > 'z' {
		return s
	}
	return string(s[0]-'a'+'A') + s[1:]
}

// sweepOnce lists once, and deletes the one machine by its id only if everything matches.
func sweepOnce(l Lister, p Provider, tag string, want sweepWant, out io.Writer) (sweepKind, string) {
	ctx, cancel := context.WithTimeout(context.Background(), sweepCallTimeout)
	all, err := l.List(ctx)
	cancel()
	if err != nil {
		return sweepRefused, sweepByHand(out, p, tag, want.Name, "could not list the machines at "+p.Name())
	}
	var mine []Instance
	for _, in := range all {
		if slices.Contains(in.Tags, tag) && slices.Contains(in.Tags, Tag) {
			mine = append(mine, in)
		}
	}
	if len(mine) == 0 {
		return sweepNone, ""
	}
	for _, in := range mine {
		fmt.Fprintf(out, "Found a machine with this launch's tag %s: id %s, name %s, region %s, size %s, made %s.\n", tag, in.ID, in.Name, in.Region, in.Size, in.Created.UTC().Format(time.RFC3339))
	}
	if len(mine) != 1 {
		return sweepRefused, sweepByHand(out, p, tag, want.Name, fmt.Sprintf("%d machines carry this launch's tag where one was asked for, so none was deleted", len(mine)))
	}
	in := mine[0]
	if in.Name != want.Name || in.Region != want.Region || in.Size != want.Size || in.Created.IsZero() || in.Created.Before(want.Since.Add(-sweepClockSkew)) || in.Created.After(sweepNow().Add(sweepClockSkew)) {
		return sweepRefused, sweepByHand(out, p, tag, want.Name, "the machine with this launch's tag is not what the launch asked for, so it was not deleted")
	}
	dctx, dcancel := context.WithTimeout(context.Background(), sweepCallTimeout)
	defer dcancel()
	switch err := p.Delete(dctx, in.ID); {
	case err == nil || errors.Is(err, ErrNotFound):
		fmt.Fprintf(out, "Deleted machine %s (tag %s).\n", in.ID, tag)
		// Deleted is not gone until a read says so: the launch's firewall and VPC come off only when this list no longer shows the id (Security's ruling, #9934).
		rctx, rcancel := context.WithTimeout(context.Background(), sweepCallTimeout)
		after, lerr := l.List(rctx)
		rcancel()
		if lerr != nil || slices.ContainsFunc(after, func(x Instance) bool { return x.ID == in.ID }) {
			return sweepRefused, sweepByHand(out, p, tag, want.Name, fmt.Sprintf("machine %s was deleted but is not confirmed gone", in.ID))
		}
		return sweepDeleted, fmt.Sprintf("; deleted machine %s (tag %s) and confirmed it gone", in.ID, tag)
	default:
		fmt.Fprintf(out, "Could NOT delete machine %s (tag %s): delete it yourself at %s, it costs money while it exists.\n", in.ID, tag, p.Name())
		return sweepRefused, fmt.Sprintf("; machine %s (tag %s) could NOT be deleted: delete it yourself at %s, it costs money while it exists", in.ID, tag, p.Name())
	}
}
