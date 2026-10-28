package machinelaunch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// DigitalOcean is the Provider for DigitalOcean droplets (API v2, https://docs.digitalocean.com/reference/api/). It talks to one base URL (the real API, or a stub in a test), with a bearer token it
// holds in memory only. It never follows a redirect (a 3xx is an error, so the token cannot be sent anywhere else), reads at most maxResponseBytes of any answer, and removes the token from every
// message it returns.
type DigitalOcean struct {
	token    string
	baseURL  string
	client   *http.Client
	poll     time.Duration
	pageSize int
}

const (
	// DigitalOceanAPI is the real API's base URL.
	DigitalOceanAPI = "https://api.digitalocean.com/v2"
	// defaultImage is the stock Ubuntu LTS image the user-data is written for.
	defaultImage = "ubuntu-24-04-x64"

	maxResponseBytes  = 4 << 20  // an answer bigger than this is refused
	maxUserDataBytes  = 64 << 10 // DigitalOcean's own limit
	maxPages          = 20       // a listing is read for at most this many pages
	maxTransientRetry = 5        // consecutive 429 or 5xx answers WaitRunning rides out
)

var (
	hostNameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	slugRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	tagRe      = regexp.MustCompile(`^[A-Za-z0-9:_-]{1,255}$`)
	idRe       = regexp.MustCompile(`^[0-9]{1,20}$`)
	keyRe      = regexp.MustCompile(`^[A-Za-z0-9:._-]{1,128}$`)
)

// DOOption configures a DigitalOcean provider.
type DOOption func(*DigitalOcean)

// WithBaseURL points the provider at another API (a stub server in a test). It must be an http or https URL.
func WithBaseURL(u string) DOOption {
	return func(d *DigitalOcean) { d.baseURL = strings.TrimRight(u, "/") }
}

// WithPollInterval sets how often WaitRunning asks.
func WithPollInterval(p time.Duration) DOOption { return func(d *DigitalOcean) { d.poll = p } }

// WithHTTPClient replaces the HTTP client; its redirects are still refused.
func WithHTTPClient(c *http.Client) DOOption { return func(d *DigitalOcean) { d.client = c } }

// NewDigitalOcean makes the provider for token. A token that is empty, or holds a space or a control character, is refused (without being shown).
func NewDigitalOcean(token string, opts ...DOOption) (*DigitalOcean, error) {
	if token == "" || len(token) > 512 {
		return nil, errors.New("digitalocean: the token is empty or too long")
	}
	for _, r := range token {
		if r > unicode.MaxASCII || unicode.IsSpace(r) || unicode.IsControl(r) {
			return nil, errors.New("digitalocean: the token holds a space or a character a token never has (a trailing newline from a file?)")
		}
	}
	d := &DigitalOcean{token: token, baseURL: DigitalOceanAPI, poll: 3 * time.Second, pageSize: 200}
	for _, o := range opts {
		o(d)
	}
	u, err := url.Parse(d.baseURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return nil, errors.New("digitalocean: the base URL is not an http or https URL")
	}
	if d.client == nil {
		d.client = &http.Client{Timeout: 30 * time.Second}
	}
	c := *d.client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse } // never follow: the token goes to the one host it was given for
	d.client = &c
	if d.poll <= 0 {
		d.poll = 3 * time.Second
	}
	return d, nil
}

// Name is "digitalocean".
func (d *DigitalOcean) Name() string { return "digitalocean" }

// doError is the body DigitalOcean answers a failure with.
type doError struct {
	ID      string `json:"id"`
	Message string `json:"message"`
}

// do sends one request and decodes a 2xx answer into out (nil: ignore the body). A failure is an *APIError with the token removed from its message.
func (d *DigitalOcean) do(ctx context.Context, op, method, path string, query url.Values, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("digitalocean: %s: %w", op, err)
		}
		rd = bytes.NewReader(b)
	}
	u := d.baseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return fmt.Errorf("digitalocean: %s: %s", op, d.redact(err.Error()))
	}
	req.Header.Set("Authorization", "Bearer "+d.token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "coral-machine-launch")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("digitalocean: %s: %s", op, d.redact(err.Error()))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return fmt.Errorf("digitalocean: %s: reading the answer: %s", op, d.redact(err.Error()))
	}
	if len(raw) > maxResponseBytes {
		return fmt.Errorf("digitalocean: %s: the answer is larger than %d bytes", op, maxResponseBytes)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		e := &APIError{Provider: "digitalocean", Op: op, Status: resp.StatusCode}
		var de doError
		if json.Unmarshal(raw, &de) == nil {
			e.Message = d.cleanMessage(de.Message)
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			if ra := strings.TrimSpace(resp.Header.Get("Retry-After")); ra != "" {
				if n, err := strconv.Atoi(ra); err == nil && n >= 0 && n < 86400 {
					e.Message = strings.TrimSpace(e.Message + " (retry after " + ra + "s)")
				}
			}
		}
		return e
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("digitalocean: %s: the answer is not what the API documents", op)
		}
	}
	return nil
}

// redact removes the token from s.
func (d *DigitalOcean) redact(s string) string { return strings.ReplaceAll(s, d.token, "[token]") }

// cleanMessage is a provider message made safe to show: the token out, controls out, at most 200 characters.
func (d *DigitalOcean) cleanMessage(s string) string {
	s = d.redact(s)
	var b strings.Builder
	n := 0
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		if n++; n > 200 {
			break
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

// Validate reads the account: a 200 means the token works.
func (d *DigitalOcean) Validate(ctx context.Context) error {
	return d.do(ctx, "validate the token", http.MethodGet, "/account", nil, nil, nil)
}

type doPages struct {
	Links struct {
		Pages struct {
			Next string `json:"next"`
		} `json:"pages"`
	} `json:"links"`
}

type doSize struct {
	Slug        string   `json:"slug"`
	PriceHourly float64  `json:"price_hourly"`
	PriceMonth  float64  `json:"price_monthly"`
	Available   bool     `json:"available"`
	Regions     []string `json:"regions"`
}

// Price reads the size list and answers the size's price when it is available in the region; otherwise ErrNotFound.
func (d *DigitalOcean) Price(ctx context.Context, region, size string) (Price, error) {
	if !slugRe.MatchString(region) || !slugRe.MatchString(size) {
		return Price{}, fmt.Errorf("digitalocean: the region or size is not a slug")
	}
	for page := 1; page <= maxPages; page++ {
		var out struct {
			Sizes []doSize `json:"sizes"`
			doPages
		}
		q := url.Values{"per_page": {strconv.Itoa(d.pageSize)}, "page": {strconv.Itoa(page)}}
		if err := d.do(ctx, "list the sizes", http.MethodGet, "/sizes", q, nil, &out); err != nil {
			return Price{}, err
		}
		for _, s := range out.Sizes {
			if s.Slug != size {
				continue
			}
			if !s.Available || !contains(s.Regions, region) {
				return Price{}, &APIError{Provider: "digitalocean", Op: "price a size", Status: http.StatusNotFound, Message: "that size is not offered in that region"}
			}
			return Price{HourlyUSD: s.PriceHourly, MonthlyUSD: s.PriceMonth}, nil
		}
		if out.Links.Pages.Next == "" {
			break
		}
	}
	return Price{}, &APIError{Provider: "digitalocean", Op: "price a size", Status: http.StatusNotFound, Message: "no such size"}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

type doDroplet struct {
	ID       json.Number `json:"id"`
	Name     string      `json:"name"`
	Status   string      `json:"status"`
	SizeSlug string      `json:"size_slug"`
	Region   struct {
		Slug string `json:"slug"`
	} `json:"region"`
	Networks struct {
		V4 []struct {
			IP   string `json:"ip_address"`
			Type string `json:"type"`
		} `json:"v4"`
	} `json:"networks"`
	Tags []string `json:"tags"`
}

func (dr doDroplet) instance() Instance {
	in := Instance{ID: dr.ID.String(), Name: dr.Name, Region: dr.Region.Slug, Size: dr.SizeSlug, Tags: dr.Tags}
	switch dr.Status {
	case "new":
		in.Status = StatusPending
	case "active":
		in.Status = StatusRunning
	case "off", "archive":
		in.Status = StatusStopped
	default:
		in.Status = StatusUnknown
	}
	for _, n := range dr.Networks.V4 {
		if n.Type == "public" && n.IP != "" {
			in.IPv4 = n.IP
			break
		}
	}
	return in
}

// Create makes a droplet with the spec's name, region, size, image, tags (Tag included), ssh keys and user-data, and returns it as DigitalOcean first reports it. Nothing is sent for a spec that
// is not valid.
func (d *DigitalOcean) Create(ctx context.Context, spec Spec) (Instance, error) {
	if !hostNameRe.MatchString(spec.Name) {
		return Instance{}, errors.New("digitalocean: the machine name is not a host name (a-z, 0-9 and hyphens, at most 63)")
	}
	if !slugRe.MatchString(spec.Region) || !slugRe.MatchString(spec.Size) {
		return Instance{}, errors.New("digitalocean: the region or size is not a slug")
	}
	image := spec.Image
	if image == "" {
		image = defaultImage
	} else if !slugRe.MatchString(image) {
		return Instance{}, errors.New("digitalocean: the image is not a slug")
	}
	if len(spec.UserData) == 0 || len(spec.UserData) > maxUserDataBytes {
		return Instance{}, fmt.Errorf("digitalocean: the user-data is empty or over %d bytes", maxUserDataBytes)
	}
	tags := []string{Tag}
	for _, t := range spec.Tags {
		if !tagRe.MatchString(t) {
			return Instance{}, errors.New("digitalocean: a tag has characters DigitalOcean does not take")
		}
		if t != Tag {
			tags = append(tags, t)
		}
	}
	keys := []string{}
	for _, k := range spec.SSHKeys {
		if !keyRe.MatchString(k) {
			return Instance{}, errors.New("digitalocean: an ssh key is not an id or fingerprint")
		}
		keys = append(keys, k)
	}
	body := map[string]any{
		"name": spec.Name, "region": spec.Region, "size": spec.Size, "image": image,
		"ssh_keys": keys, "backups": false, "ipv6": false, "monitoring": false, "tags": tags, "user_data": spec.UserData,
	}
	var out struct {
		Droplet doDroplet `json:"droplet"`
	}
	if err := d.do(ctx, "create a droplet", http.MethodPost, "/droplets", nil, body, &out); err != nil {
		return Instance{}, err
	}
	if !idRe.MatchString(out.Droplet.ID.String()) {
		return Instance{}, errors.New("digitalocean: create a droplet: the answer names no droplet")
	}
	return out.Droplet.instance(), nil
}

func (d *DigitalOcean) get(ctx context.Context, id string) (Instance, error) {
	if !idRe.MatchString(id) {
		return Instance{}, errors.New("digitalocean: the instance id is not a droplet id")
	}
	var out struct {
		Droplet doDroplet `json:"droplet"`
	}
	if err := d.do(ctx, "read a droplet", http.MethodGet, "/droplets/"+id, nil, nil, &out); err != nil {
		return Instance{}, err
	}
	return out.Droplet.instance(), nil
}

// WaitRunning asks about the droplet every poll interval until it is running with a public address; a droplet that is off or archived is an error, and so is ctx ending. A few 429 or 5xx answers in
// a row are ridden out.
func (d *DigitalOcean) WaitRunning(ctx context.Context, id string) (Instance, error) {
	transient := 0
	for {
		in, err := d.get(ctx, id)
		switch {
		case err == nil:
			transient = 0
			switch {
			case in.Status == StatusRunning && in.IPv4 != "":
				return in, nil
			case in.Status == StatusStopped:
				return in, fmt.Errorf("digitalocean: the droplet is %s, not running", string(in.Status))
			case in.Status == StatusUnknown:
				return in, errors.New("digitalocean: the droplet is in a state this tool does not know")
			}
		case isTransient(err) && transient < maxTransientRetry:
			transient++
		default:
			return Instance{}, err
		}
		select {
		case <-ctx.Done():
			return Instance{}, ctx.Err()
		case <-time.After(d.poll):
		}
	}
}

func isTransient(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && (ae.Status == http.StatusTooManyRequests || ae.Status >= 500)
}

// Delete removes the droplet; one that is already gone is ErrNotFound.
func (d *DigitalOcean) Delete(ctx context.Context, id string) error {
	if !idRe.MatchString(id) {
		return errors.New("digitalocean: the instance id is not a droplet id")
	}
	return d.do(ctx, "delete a droplet", http.MethodDelete, "/droplets/"+id, nil, nil, nil)
}

// List returns the droplets tagged Tag (the ones this tool made).
func (d *DigitalOcean) List(ctx context.Context) ([]Instance, error) {
	var all []Instance
	for page := 1; page <= maxPages; page++ {
		var out struct {
			Droplets []doDroplet `json:"droplets"`
			doPages
		}
		q := url.Values{"tag_name": {Tag}, "per_page": {strconv.Itoa(d.pageSize)}, "page": {strconv.Itoa(page)}}
		if err := d.do(ctx, "list droplets", http.MethodGet, "/droplets", q, nil, &out); err != nil {
			return nil, err
		}
		for _, dr := range out.Droplets {
			if contains(dr.Tags, Tag) { // the tag filter is the provider's; the tag is checked here too
				all = append(all, dr.instance())
			}
		}
		if out.Links.Pages.Next == "" {
			break
		}
	}
	return all, nil
}
