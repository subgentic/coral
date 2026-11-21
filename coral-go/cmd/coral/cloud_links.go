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

type linkReply struct {
	Links   []linkRow `json:"links"`
	Pending bool      `json:"pending"`
	Message string    `json:"message"`
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
		fmt.Fprintln(errw, "usage: coral cloud links [list | cap <link_id|hub address> <view|interact|launch> | remove <link_id|hub address>]")
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
