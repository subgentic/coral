package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// keys is `coral cloud keys` (#20944): a self-hosted Hub's request key, made, listed and revoked through this computer's own server. `create` is what a Hub runs over SSH to get its key: the key goes alone to stdout
// (once; Coral keeps only a hash), every word about it to stderr, and the key is never in a list.
func (c *cloudClient) keys(ctx context.Context, words []string, out, errw io.Writer) int {
	usage := func() int {
		fmt.Fprintln(errw, "usage: coral cloud keys [list | create <name> | revoke <key id>]")
		return 2
	}
	if len(words) == 0 {
		words = []string{"list"}
	}
	switch {
	case words[0] == "list" && len(words) == 1:
		var r struct {
			Keys []struct {
				ID         string `json:"id"`
				Name       string `json:"name"`
				CreatedAt  string `json:"created_at"`
				LastUsedAt string `json:"last_used_at"`
			} `json:"keys"`
		}
		if code := c.call(ctx, http.MethodGet, "/api/cloud/link-keys", nil, nil, 15*time.Second, &r); code >= 0 {
			return code
		}
		if len(r.Keys) == 0 {
			fmt.Fprintln(out, "No request keys.")
		}
		for _, k := range r.Keys {
			used := "never used"
			if k.LastUsedAt != "" {
				used = "last used " + oneLine(k.LastUsedAt)
			}
			fmt.Fprintf(out, "%s  %s  made %s, %s\n", oneLine(k.ID), oneLine(k.Name), oneLine(k.CreatedAt), used)
		}
		return 0
	case words[0] == "create" && len(words) == 2:
		var r struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Key  string `json:"key"`
		}
		if code := c.call(ctx, http.MethodPost, "/api/cloud/link-keys", map[string]string{"name": words[1]}, nil, 15*time.Second, &r); code >= 0 {
			return code
		}
		if r.Key == "" {
			fmt.Fprintln(errw, "Coral did not make a key.")
			return 1
		}
		fmt.Fprintf(errw, "Made the request key %s (%s). It is shown once, on the next line, and cannot be read again: keep it in the Hub.\n", oneLine(r.ID), oneLine(r.Name))
		fmt.Fprintln(out, r.Key)
		return 0
	case words[0] == "revoke" && len(words) == 2:
		var r struct {
			OK bool `json:"ok"`
		}
		if code := c.call(ctx, http.MethodDelete, "/api/cloud/link-keys/"+url.PathEscape(words[1]), nil, nil, 15*time.Second, &r); code >= 0 {
			return code
		}
		fmt.Fprintf(out, "Revoked %s. Its Hub can no longer ask to join, and any request it left waiting is ended.\n", oneLine(words[1]))
		return 0
	}
	return usage()
}
