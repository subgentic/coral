package releasediff

import (
	"fmt"
	"io"
	"strings"
)

// tier is the tier of a route entry ("launch owner-only" is launch).
func tier(entry string) string { f, _, _ := strings.Cut(entry, " "); return f }

func line(w io.Writer, c Change, show func(Change) string) {
	fmt.Fprintf(w, "- `%s`: %s\n", c.Key, show(c))
}

func section(w io.Writer, title string, cs []Change, show func(Change) string) {
	if len(cs) == 0 {
		return
	}
	fmt.Fprintf(w, "\n%s (%d)\n\n", title, len(cs))
	for _, c := range cs {
		line(w, c, show)
	}
}

// WriteRoutes writes the route diff as Markdown for the note. A route with the tier never is not reachable through the tunnel, so those rows are kept apart from the ones the Hub can see: an
// added route that is never is only a count and a list, while a route that leaves or enters never is a change of exposure and stays in Changed.
func WriteRoutes(w io.Writer, d Diff, oldRef, newRef string) {
	fmt.Fprintf(w, "### Tunnel routes, %s to %s\n", oldRef, newRef)
	if d.Empty() {
		fmt.Fprintln(w, "\nNo route was added, removed or changed.")
		return
	}
	split := func(cs []Change, entry func(Change) string) (open, never []Change) {
		for _, c := range cs {
			if tier(entry(c)) == "never" {
				never = append(never, c)
			} else {
				open = append(open, c)
			}
		}
		return
	}
	newEntry, oldEntry := func(c Change) string { return c.New }, func(c Change) string { return c.Old }
	addOpen, addNever := split(d.Added, newEntry)
	remOpen, remNever := split(d.Removed, oldEntry)
	section(w, "Added, reachable through the tunnel", addOpen, func(c Change) string { return strings.Replace(c.New, " ", ", ", 1) })
	section(w, "Removed, was reachable through the tunnel", remOpen, func(c Change) string { return "was " + strings.Replace(c.Old, " ", ", ", 1) })
	section(w, "Changed", d.Changed, func(c Change) string { return c.Old + " to " + c.New })
	section(w, "Added, never reachable (the Hub has nothing to do)", addNever, func(Change) string { return "never" })
	section(w, "Removed, was never reachable", remNever, func(Change) string { return "never" })
}

// WriteSettings writes the settings keys diff as Markdown for the note, each key with its type.
func WriteSettings(w io.Writer, d Diff, oldRef, newRef string) {
	fmt.Fprintf(w, "### Board settings keys (%s, HealthSettings included), %s to %s\n", SettingsType, oldRef, newRef)
	if d.Empty() {
		fmt.Fprintln(w, "\nNo key was added, removed or changed.")
		return
	}
	section(w, "Added", d.Added, func(c Change) string { return c.New })
	section(w, "Removed", d.Removed, func(c Change) string { return "was " + c.Old })
	section(w, "Changed", d.Changed, func(c Change) string { return c.Old + " to " + c.New })
}
