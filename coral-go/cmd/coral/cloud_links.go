package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

type linkRow struct {
	LinkID    string `json:"link_id"`
	HubOrigin string `json:"hub_origin"`
	Label     string `json:"label"`
	State     string `json:"state"`
	MaxMode   string `json:"max_mode"`
}

// addingRow is one Hub being added: what the server shows (text only, no token or device code).
type addingRow struct {
	Hub             string `json:"hub"`
	Cap             string `json:"cap"`
	State           string `json:"state"`
	UserCode        string `json:"user_code"`
	VerificationURL string `json:"verification_url"`
	Note            string `json:"note"`
	Message         string `json:"message"`
	OwnerCandidate  string `json:"owner_candidate"`
}

type linkReply struct {
	Links      []linkRow   `json:"links"`
	Pending    bool        `json:"pending"`
	Message    string      `json:"message"`
	Enrollment *addingRow  `json:"enrollment"`
	Adding     []addingRow `json:"adding"`
}

// grantLine says in plain words what a cap lets the Hub do, so the person reads it as they choose it.
func grantLine(mode string) string {
	switch mode {
	case "launch":
		return "start sessions on this computer, and send to and answer your agents"
	case "interact":
		return "send to and answer your agents' sessions on this computer, but not start new ones"
	}
	return "look at your sessions on this computer, and nothing more"
}

// links is `coral cloud links`: list, cap and remove, all through this computer's own server and never the Hub (#20346). A link is named by its id or its full Hub address.
func (c *cloudClient) links(ctx context.Context, words []string, out, errw io.Writer) int {
	usage := func() int {
		fmt.Fprintln(errw, "usage: coral cloud links [list | add <hub address> <view|interact|launch> | cap <link_id|hub address> <view|interact|launch> | remove <link_id|hub address> | confirm-owner <hub address> <the name the Hub gave> | arm-owner <hub address>]")
		return 2
	}
	if len(words) == 0 {
		words = []string{"list"}
	}
	read := func() (linkReply, int) {
		var r linkReply
		code := c.call(ctx, http.MethodGet, "/api/cloud/links", nil, nil, 15*time.Second, &r)
		return r, code
	}
	find := func(r linkReply, key string) *linkRow {
		for i := range r.Links {
			if r.Links[i].LinkID == key || r.Links[i].HubOrigin == key {
				return &r.Links[i]
			}
		}
		fmt.Fprintf(errw, "No link %q. List them with: coral cloud links\n", oneLine(key))
		return nil
	}
	switch {
	case words[0] == "list" && len(words) == 1:
		r, code := read()
		if code >= 0 {
			return code
		}
		if len(r.Links) == 0 {
			fmt.Fprintln(out, "No Coral Hub links.")
		}
		for _, l := range r.Links {
			fmt.Fprintf(out, "%s  %-8s %-9s %s  %s\n", l.LinkID, l.MaxMode, l.State, l.HubOrigin, oneLine(l.Label))
		}
		return 0
	case words[0] == "add" && len(words) == 3 && validModeWord(words[2]):
		return c.addLink(ctx, words[1], words[2], out, errw)
	case words[0] == "cap" && len(words) == 3 && validModeWord(words[2]):
		r, code := read()
		if code >= 0 {
			return code
		}
		l := find(r, words[1])
		if l == nil {
			return 1
		}
		var reply linkReply
		if code := c.call(ctx, http.MethodPut, "/api/cloud/links/"+url.PathEscape(l.LinkID)+"/cap", map[string]string{"mode": words[2]}, nil, 15*time.Second, &reply); code >= 0 {
			return code
		}
		fmt.Fprintf(out, "%s (%s) may now %s (access: %s).\n", l.HubOrigin, l.LinkID, grantLine(words[2]), words[2])
		return 0
	case words[0] == "confirm-owner" && len(words) == 3:
		var reply linkReply
		if code := c.call(ctx, http.MethodPost, "/api/cloud/links/confirm-owner", map[string]string{"hub": words[1], "candidate": words[2]}, nil, 15*time.Second, &reply); code >= 0 {
			return code
		}
		fmt.Fprintf(out, "%s is now this Hub link's owner. It may do everything the link's access allows.\n", oneLine(words[2]))
		return 0
	case words[0] == "arm-owner" && len(words) == 2:
		// The fallback when the Hub named no owner: for one minute, the first owner read through THAT Hub is recorded as its owner. Do the read as the Hub's owner now.
		var reply struct {
			Seconds int `json:"seconds"`
		}
		if code := c.call(ctx, http.MethodPost, "/api/cloud/owner-label/arm", map[string]string{"hub": words[1]}, nil, 15*time.Second, &reply); code >= 0 {
			return code
		}
		fmt.Fprintf(out, "Ready for %d seconds: open this computer in Coral Hub as that Hub's owner now. The first owner read through that Hub is recorded as its owner.\n", reply.Seconds)
		return 0
	case words[0] == "remove" && len(words) == 2:
		r, code := read()
		if code >= 0 {
			return code
		}
		l := find(r, words[1])
		if l == nil {
			return 1
		}
		var reply linkReply
		if code := c.call(ctx, http.MethodDelete, "/api/cloud/links/"+url.PathEscape(l.LinkID), nil, nil, 30*time.Second, &reply); code >= 0 {
			return code
		}
		if reply.Pending {
			fmt.Fprintf(out, "%s: %s\n", l.HubOrigin, reply.Message)
			return 0
		}
		fmt.Fprintf(out, "Removed %s (%s) from this computer.\n", l.HubOrigin, l.LinkID)
		if reply.Message != "" {
			fmt.Fprintln(out, "Note: "+reply.Message+".")
		}
		return 0
	}
	return usage()
}

// addLink is `coral cloud links add <hub address> <cap>`: this computer's own server asks that Hub for a code, the code is shown here, and the command waits for the person to approve it in the Hub. Ctrl-C cancels:
// an approval that comes later links nothing. The cap is typed out loud, with no default, and said back in words.
func (c *cloudClient) addLink(ctx context.Context, hub, linkCap string, out, errw io.Writer) int {
	var reply linkReply
	if code := c.call(ctx, http.MethodPost, "/api/cloud/links", map[string]string{"hub": hub, "cap": linkCap}, nil, 30*time.Second, &reply); code >= 0 {
		return code
	}
	e := reply.Enrollment
	if e == nil {
		fmt.Fprintln(errw, "Coral did not start adding that Hub.")
		return 1
	}
	fmt.Fprintf(out, "Adding %s. Once linked it may %s (access: %s).\n", oneLine(e.Hub), grantLine(linkCap), linkCap)
	fmt.Fprintf(out, "Open %s in your browser and enter the code %s\n", oneLine(e.VerificationURL), oneLine(e.UserCode))
	if e.Note != "" {
		fmt.Fprintln(out, "Note: "+oneLine(e.Note))
	}
	cancel := func() {
		cctx, stop := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer stop()
		var r linkReply
		c.call(cctx, http.MethodPost, "/api/cloud/links/cancel", map[string]string{"hub": e.Hub}, nil, 10*time.Second, &r)
	}
	for {
		select {
		case <-ctx.Done():
			cancel()
			fmt.Fprintln(out, "Cancelled: nothing was linked.")
			return 130
		case <-time.After(c.pollEvery()):
		}
		var r linkReply
		if code := c.call(ctx, http.MethodGet, "/api/cloud/links", nil, nil, 15*time.Second, &r); code >= 0 {
			if ctx.Err() != nil {
				continue
			}
			return code
		}
		var row *addingRow
		for i := range r.Adding {
			if r.Adding[i].Hub == e.Hub {
				row = &r.Adding[i]
			}
		}
		switch {
		case row == nil:
			fmt.Fprintln(out, "Adding that Hub was cancelled: nothing was linked.")
			return 1
		case row.State == "linked":
			fmt.Fprintf(out, "Linked %s.\n", oneLine(e.Hub))
			if row.OwnerCandidate != "" {
				fmt.Fprintf(out, "That Hub says its owner is %s. If that is right, that person will have everything this link's access allows. Confirm with:\n  coral cloud links confirm-owner %s %s\n", oneLine(row.OwnerCandidate), oneLine(e.Hub), oneLine(row.OwnerCandidate))
			} else {
				fmt.Fprintf(out, "That Hub named no owner. Until you record one, its owner can't act here. When you are ready: coral cloud links arm-owner %s\n", oneLine(e.Hub))
			}
			return 0
		case row.State != "pending":
			fmt.Fprintln(errw, oneLine(row.Message))
			return 4
		}
	}
}
