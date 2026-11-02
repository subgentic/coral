package machinelaunch

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"
)

// ListRow is one machine in `coral machine list`: the provider's tagged instances joined with the state file, and nothing from the Hub (the key reads nothing).
type ListRow struct {
	Name      string
	ID        string
	Status    Status
	Region    string
	Size      string
	Age       time.Duration // 0 when the provider did not say
	HourlyUSD float64       // 0 when the price could not be read
	InState   bool          // the state file has its ids (so delete finds the network too)
	SSHOpen   bool          // the state file says SSH is still open at this machine's cloud firewall
	Gone      bool          // the state file has it and the provider does not
}

// List joins what the provider says it holds (instances with this tool's tag, with their age and hourly price) with the state file.
func List(ctx context.Context, d ManageDeps) ([]ListRow, error) {
	l, ok := d.Provider.(Lister)
	if !ok {
		return nil, fmt.Errorf("%s cannot list the machines this tool made", d.Provider.Name())
	}
	all, err := l.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("could not list the machines at %s: %w", d.Provider.Name(), err)
	}
	prices := map[string]float64{}
	price := func(region, size string) float64 {
		k := region + "/" + size
		if v, ok := prices[k]; ok {
			return v
		}
		p, err := d.Provider.Price(ctx, region, size)
		if err != nil {
			prices[k] = 0
			return 0
		}
		prices[k] = p.HourlyUSD
		return p.HourlyUSD
	}
	seen := map[string]bool{}
	var rows []ListRow
	for _, in := range all {
		if !slices.Contains(in.Tags, Tag) {
			continue
		}
		seen[in.Name] = true
		row := ListRow{Name: in.Name, ID: in.ID, Status: in.Status, Region: in.Region, Size: in.Size, HourlyUSD: price(in.Region, in.Size)}
		if !in.Created.IsZero() {
			row.Age = d.now().Sub(in.Created)
		}
		rec, known := d.State.Get(in.Name)
		row.InState, row.SSHOpen = known, known && rec.FirewallOpen
		rows = append(rows, row)
	}
	for _, r := range d.State.Records() {
		if !seen[r.Name] {
			rows = append(rows, ListRow{Name: r.Name, ID: r.DropletID, Region: r.Region, InState: true, Gone: true, SSHOpen: r.FirewallOpen})
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Name < rows[j].Name })
	return rows, nil
}

// PruneItem is one thing a prune would remove.
type PruneItem struct {
	Name   string
	Why    string
	IDs    IDs
	Record bool // the state file has a record to drop
}

// PruneReport says what a prune found and did.
type PruneReport struct {
	Items   []PruneItem
	Removed []string
	Failed  []string
}

// PruneOptions choose what a prune may take.
type PruneOptions struct {
	OlderThan time.Duration // how old an instance or a record must be (required)
}

// Prune finds what a crashed or forgotten launch left, by this tool's tag and names, and removes it after ONE confirmation that lists it all:
//   - NEVER an instance the state file does not know, however old: a tag proves this tool made it, not that THIS state file did (a second computer's launch looks the same). Those are only counted and said: `coral machine list --unknown` shows them and `coral machine delete NAME --id ID` takes one the person types;
//   - a state record at least olderThan old whose instance the provider no longer has (its leftover network is removed, the record dropped);
//   - a network is removed only with the record that names its id, after a fresh read shows nothing in it; one with this tool's name and no record is never removed (`coral machine list --unknown` lists them).
//
// Nothing the person did not launch with this tool is touched: everything is matched by the tool's tag and names. A prune cannot revoke a Hub identity (it has no credential id for an orphan): say so.
func Prune(ctx context.Context, o PruneOptions, d ManageDeps) (*PruneReport, error) {
	olderThan := o.OlderThan
	if olderThan <= 0 {
		return nil, errors.New("--older-than is needed: how old a machine must be before it is an orphan")
	}
	l, ok := d.Provider.(Lister)
	if !ok {
		return nil, fmt.Errorf("%s cannot list the machines this tool made", d.Provider.Name())
	}
	all, err := l.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("could not list the machines at %s: %w", d.Provider.Name(), err)
	}
	cutoff := d.now().Add(-olderThan)
	alive := map[string]bool{}
	for _, in := range all {
		if slices.Contains(in.Tags, Tag) {
			alive[in.Name] = true
		}
	}
	var items []PruneItem
	unknown := 0
	taken := map[string]bool{}
	for _, in := range all {
		if !slices.Contains(in.Tags, Tag) || in.Created.IsZero() || in.Created.After(cutoff) {
			continue
		}
		if _, known := d.State.Get(in.Name); known {
			continue // launched by this person, and still theirs
		}
		unknown++ // tagged by this tool but not in this state file: counted and said, NEVER taken (a tag proves this tool made it, not THIS state file: a second computer's launch looks the same)
	}
	for _, r := range d.State.Records() {
		if alive[r.Name] || r.Created.IsZero() || r.Created.After(cutoff) {
			continue
		}
		if r.VPCID != "" && slices.ContainsFunc(all, func(in Instance) bool { return in.VPCID == r.VPCID }) { // by this fresh read the network still has a member: it stays
			fmt.Fprintf(d.Out, "The private network %s of the record %s still has an instance in it: it was left alone.\n", r.VPCID, r.Name)
			continue
		}
		ids := r.IDs()
		ids.DropletID = "" // the provider no longer has it
		items = append(items, PruneItem{Name: r.Name, Why: "a record whose instance is gone", IDs: ids, Record: true})
		taken[r.Name] = true
	}
	rep := &PruneReport{Items: items}
	if unknown > 0 {
		fmt.Fprintf(d.Out, "%d instance(s) at %s carry this tool's tag, are old enough and are not in this state file: they may belong to another computer or to a state file that was lost, so they are left alone. See them with `coral machine list --unknown`; delete one with `coral machine delete NAME --id ID`, typing the id.\n", unknown, d.Provider.Name())
	}
	if len(items) == 0 {
		fmt.Fprintln(d.Out, "Nothing to prune.")
		return rep, nil
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "Remove %d thing(s) at %s that this tool made:\n", len(items), d.Provider.Name())
	for _, it := range items {
		fmt.Fprintf(&sb, "  %s: %s\n", it.Name, it.Why)
	}
	sb.WriteString("A prune cannot revoke a machine's Hub identity: remove those machines in Coral Hub.")
	if d.Confirm == nil {
		return rep, errors.New("no one can be asked to confirm: pass --yes to go on without asking")
	}
	ok, err = d.Confirm(sb.String())
	if err != nil {
		return rep, err
	}
	if !ok {
		return rep, ErrDeclined
	}
	for _, it := range items {
		it := it
		left := Teardown(ctx, d.Provider, it.IDs, d.Tune, d.Out, nil)
		if left.Empty() && len(left.Errs) == 0 {
			if it.Record {
				_ = d.State.Remove(it.Name)
			}
			rep.Removed = append(rep.Removed, it.Name)
		} else {
			rep.Failed = append(rep.Failed, it.Name)
		}
	}
	if len(rep.Failed) > 0 {
		return rep, fmt.Errorf("could not remove everything for: %s", strings.Join(rep.Failed, ", "))
	}
	return rep, nil
}

// age says a duration in the unit a person reads: minutes, hours or days.
func age(d time.Duration) string {
	switch {
	case d < time.Hour:
		return fmt.Sprintf("%d min", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d h", int(d.Hours()))
	}
	return fmt.Sprintf("%d days", int(d.Hours()/24))
}

// AgeText is age for the command line's table.
func AgeText(d time.Duration) string {
	if d <= 0 {
		return "-"
	}
	return age(d)
}
