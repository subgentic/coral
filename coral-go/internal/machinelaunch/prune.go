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
		_, row.InState = d.State.Get(in.Name)
		rows = append(rows, row)
	}
	for _, r := range d.State.Records() {
		if !seen[r.Name] {
			rows = append(rows, ListRow{Name: r.Name, ID: r.DropletID, Region: r.Region, InState: true, Gone: true})
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

// Prune finds what a crashed or forgotten launch left, by this tool's tag and names, and removes it after ONE confirmation that lists it all:
//   - an instance with the tool's tag that is at least olderThan old and that the state file does not know (an orphan; one the state file knows is a machine you launched and is left alone), with its network by name;
//   - a state record at least olderThan old whose instance the provider no longer has (its leftover network is removed, the record dropped);
//   - with includeNetworks, a VPC or firewall with the tool's name prefix whose machine has no instance and no record (these carry no age, so they are only taken when you say so).
//
// Nothing the person did not launch with this tool is touched: everything is matched by the tool's tag and names. A prune cannot revoke a Hub identity (it has no credential id for an orphan): say so.
func Prune(ctx context.Context, olderThan time.Duration, includeNetworks bool, d ManageDeps) (*PruneReport, error) {
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
	var vpcs []VPC
	var fws []Firewall
	if nl, ok := d.Provider.(NetworkLister); ok {
		if vpcs, err = nl.ListVPCs(ctx); err != nil {
			return nil, fmt.Errorf("could not list the private networks: %w", err)
		}
		if fws, err = nl.ListFirewalls(ctx); err != nil {
			return nil, fmt.Errorf("could not list the firewalls: %w", err)
		}
	}
	netIDs := func(name string) (vpc, fw string) {
		for _, v := range vpcs {
			if v.Name == VPCName(name) {
				vpc = v.ID
			}
		}
		for _, f := range fws {
			if f.Name == FirewallName(name) {
				fw = f.ID
			}
		}
		return
	}
	var items []PruneItem
	taken := map[string]bool{}
	for _, in := range all {
		if !slices.Contains(in.Tags, Tag) || in.Created.IsZero() || in.Created.After(cutoff) {
			continue
		}
		if _, known := d.State.Get(in.Name); known {
			continue // launched by this person, and still theirs
		}
		vpc, fw := netIDs(in.Name)
		items = append(items, PruneItem{Name: in.Name, Why: fmt.Sprintf("an instance made %s ago that the state file does not know", age(d.now().Sub(in.Created))), IDs: IDs{DropletID: in.ID, VPCID: vpc, FirewallID: fw}})
		taken[in.Name] = true
	}
	for _, r := range d.State.Records() {
		if alive[r.Name] || r.Created.IsZero() || r.Created.After(cutoff) {
			continue
		}
		ids := r.IDs()
		ids.DropletID = "" // the provider no longer has it
		items = append(items, PruneItem{Name: r.Name, Why: "a record whose instance is gone", IDs: ids, Record: true})
		taken[r.Name] = true
	}
	if includeNetworks {
		names := map[string]bool{}
		for _, v := range vpcs {
			if strings.HasPrefix(v.Name, VPCPrefix) { // the lister filters too; a network without this tool's name is never taken, whoever lists it
				names[strings.TrimPrefix(v.Name, VPCPrefix)] = true
			}
		}
		for _, f := range fws {
			if strings.HasPrefix(f.Name, FirewallPrefix) {
				names[strings.TrimPrefix(f.Name, FirewallPrefix)] = true
			}
		}
		var sorted []string
		for n := range names {
			sorted = append(sorted, n)
		}
		sort.Strings(sorted)
		for _, n := range sorted {
			if taken[n] || alive[n] {
				continue
			}
			if _, known := d.State.Get(n); known {
				continue
			}
			vpc, fw := netIDs(n)
			items = append(items, PruneItem{Name: n, Why: "a private network or firewall with no instance and no record", IDs: IDs{VPCID: vpc, FirewallID: fw}})
		}
	}
	rep := &PruneReport{Items: items}
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
