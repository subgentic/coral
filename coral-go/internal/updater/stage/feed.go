package stage

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/subgentic/coral/internal/updater/verify"
)

// The releases Atom feed (#9704). The anonymous API's list of releases is limited to 60 requests an hour per address, which a shared NAT or a hosted runner spends (the update check of run
// 40602161973 was refused with x-ratelimit-remaining 0). github.com's own page, https://github.com/<repo>/releases.atom, is not the API and is not counted: the check asks it first and the API
// only when the feed cannot say. The feed carries the tags of the newest releases and nothing the check trusts: as with the API's list, a name only narrows what is looked at, and every candidate's
// manifest is downloaded from the release's own download URL and verified against the pinned promote identity before it counts (findPromotion). The feed has no asset list and no draft flag
// (drafts are not in it), so a candidate whose files are not there is found out by the download, which is already "listed and not there: not a candidate" (a 404).
const (
	// ReleasesFeed is the newest releases of the repository, newest first, as github.com serves them.
	ReleasesFeed = "https://github.com/" + verify.Repo + "/releases.atom"

	// MaxFeedBytes caps the feed: ten entries with their release notes are far under it, and a larger answer is refused, not truncated.
	MaxFeedBytes = 2 << 20
	// maxFeedEntries is how many entries are read; a feed is ten.
	maxFeedEntries = 30
)

var errFeed = errors.New("the releases feed is not usable")

type atomFeed struct {
	Entries []struct {
		Links []struct {
			Rel  string `xml:"rel,attr"`
			Href string `xml:"href,attr"`
		} `xml:"link"`
	} `xml:"entry"`
}

// FeedTags are the release tags a releases feed names, newest first, each once: the last segment of the path of each entry's alternate link after /releases/tag/. Nothing else in the feed is read.
// A document with a DTD (an entity declaration has no use in a feed) or that is not XML is refused.
func FeedTags(body []byte) ([]string, error) {
	if bytes.Contains(bytes.ToLower(body), []byte("<!doctype")) || bytes.Contains(bytes.ToLower(body), []byte("<!entity")) {
		return nil, fmt.Errorf("%w: it has a DTD", errFeed)
	}
	dec := xml.NewDecoder(bytes.NewReader(body))
	dec.Strict = true
	var f atomFeed
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("%w: %v", errFeed, err)
	}
	var tags []string
	seen := map[string]bool{}
	for i, e := range f.Entries {
		if i >= maxFeedEntries {
			break
		}
		for _, l := range e.Links {
			if l.Rel != "" && l.Rel != "alternate" {
				continue
			}
			u, err := url.Parse(l.Href)
			if err != nil {
				continue
			}
			_, tag, ok := strings.Cut(u.Path, "/releases/tag/")
			if !ok || tag == "" || strings.Contains(tag, "/") || seen[tag] {
				continue
			}
			seen[tag] = true
			tags = append(tags, tag)
			break
		}
	}
	return tags, nil
}

// listFromFeed is the releases as the feed says them: tags only, with the assets assumed (the download says).
func (c *checker) listFromFeed(ctx context.Context) ([]listedRelease, error) {
	body, err := c.cfg.Fetcher.Get(ctx, c.cfg.FeedURL, MaxFeedBytes)
	if err != nil {
		return nil, err
	}
	tags, err := FeedTags(body)
	if err != nil {
		return nil, err
	}
	out := make([]listedRelease, 0, len(tags))
	for _, t := range tags {
		out = append(out, listedRelease{TagName: t, fromFeed: true})
	}
	return out, nil
}
