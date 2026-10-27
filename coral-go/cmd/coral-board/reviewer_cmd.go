package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
)

const reviewerUsage = `Usage: coral-board reviewer set <name> [--reviews-only | --no-reviews-only] [--areas ui,go]

An agent's review setting on this board (Operator only: an agent cannot mark itself as a reviewer).
  --reviews-only      the agent takes review tasks and nothing else; it claims the oldest review in the pool that matches its areas
  --no-reviews-only   back to an ordinary agent
  --areas LIST        the areas it reviews, comma-separated (lowercase words: ui, go, security, docs, release...); "none" or an empty list: every area`

// cmdReviewer is coral-board reviewer: set an agent's Reviews only switch and its areas (#8957).
func cmdReviewer(args []string) {
	if len(args) < 2 || args[0] != "set" {
		fmt.Fprintln(os.Stderr, reviewerUsage)
		os.Exit(2) // usage
	}
	who := args[1]
	fs := flag.NewFlagSet("reviewer set", flag.ContinueOnError)
	on := fs.Bool("reviews-only", false, "")
	off := fs.Bool("no-reviews-only", false, "")
	areas := fs.String("areas", "", "")
	clihelp.ParseFlags(fs, args[2:], func() string { return reviewerUsage })
	given := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { given[f.Name] = true })
	if *on && *off {
		fmt.Fprintln(os.Stderr, "--reviews-only and --no-reviews-only cannot be combined")
		os.Exit(2)
	}
	body := map[string]any{}
	if *on || *off {
		body["reviews_only"] = *on
	}
	if given["areas"] {
		list := []string{}
		for _, a := range strings.Split(*areas, ",") {
			if a = strings.TrimSpace(a); a != "" && !strings.EqualFold(a, "none") {
				list = append(list, a)
			}
		}
		body["review_areas"] = list
	}
	if len(body) == 0 {
		fmt.Fprintln(os.Stderr, reviewerUsage)
		os.Exit(2)
	}
	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board.")
		clierr.Exit1()
	}
	data, status, err := apiCallRaw("PUT", "/"+url.PathEscape(st.Project)+"/subscribers/"+url.PathEscape(who)+"/review-settings", body)
	if err != nil || status != http.StatusOK {
		fmt.Fprintln(os.Stderr, "Could not change the review setting: "+clierr.Describe(err, status, data))
		clierr.Exit1()
	}
	var res struct {
		SubscriberID string   `json:"subscriber_id"`
		ReviewsOnly  bool     `json:"reviews_only"`
		ReviewAreas  []string `json:"review_areas"`
	}
	_ = json.Unmarshal(data, &res)
	areaText := "every area"
	if len(res.ReviewAreas) > 0 {
		areaText = "areas: " + strings.Join(res.ReviewAreas, ", ")
	}
	mode := "takes any task"
	if res.ReviewsOnly {
		mode = "reviews only"
	}
	fmt.Printf("%s: %s (%s).\n", res.SubscriberID, mode, areaText)
}
