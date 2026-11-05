package machinelaunch

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var (
	_ Network       = (*DigitalOcean)(nil)
	_ NetworkLister = (*DigitalOcean)(nil)
)

// uuidRe is a DigitalOcean VPC or firewall id.
var (
	doUUIDRe = regexpMust(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	netName  = regexpMust(`^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$`)
)

type doVPC struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Region string `json:"region"`
}

type doFirewall struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	Tags []string `json:"tags"`
}

// CreateVPC makes a VPC (POST /vpcs). DigitalOcean picks its address range.
func (d *DigitalOcean) CreateVPC(ctx context.Context, name, region string) (VPC, error) {
	if !netName.MatchString(name) || !strings.HasPrefix(name, VPCPrefix) {
		return VPC{}, errors.New("digitalocean: the VPC name is not one this tool makes")
	}
	if !slugRe.MatchString(region) {
		return VPC{}, errors.New("digitalocean: the region is not a slug")
	}
	var out struct {
		VPC doVPC `json:"vpc"`
	}
	body := map[string]any{"name": name, "region": region, "description": "made by coral machine launch; removed with the machine"}
	if err := d.do(ctx, "create a VPC", http.MethodPost, "/vpcs", nil, body, &out); err != nil {
		return VPC{}, err
	}
	if !doUUIDRe.MatchString(out.VPC.ID) {
		return VPC{}, errors.New("digitalocean: create a VPC: the answer names no VPC")
	}
	return VPC{ID: out.VPC.ID, Name: out.VPC.Name, Region: out.VPC.Region}, nil
}

// DeleteVPC removes a VPC. A 409 or 403 saying it still has members is ErrInUse; one already gone is ErrNotFound.
func (d *DigitalOcean) DeleteVPC(ctx context.Context, id string) error {
	if !doUUIDRe.MatchString(id) {
		return errors.New("digitalocean: the id is not a VPC id")
	}
	err := d.do(ctx, "delete a VPC", http.MethodDelete, "/vpcs/"+id, nil, nil, nil)
	var ae *APIError
	if errors.As(err, &ae) && (ae.Status == http.StatusConflict || ae.Status == http.StatusForbidden && strings.Contains(strings.ToLower(ae.Message), "member")) {
		return fmt.Errorf("%w: %v", ErrInUse, err)
	}
	return err
}

// firewallBody is the whole firewall: DigitalOcean's update replaces it, so one function makes both the create and the close. Outbound is open for tcp, udp and icmp (a firewall with no outbound
// rule allows none); inbound is SSH from the given sources only, or nothing.
func firewallBody(name, tag string, sshFrom []string) map[string]any {
	all := map[string]any{"addresses": []string{"0.0.0.0/0", "::/0"}}
	inbound := []map[string]any{}
	if len(sshFrom) > 0 {
		inbound = append(inbound, map[string]any{"protocol": "tcp", "ports": "22", "sources": map[string]any{"addresses": sshFrom}})
	}
	return map[string]any{
		"name":          name,
		"tags":          []string{tag},
		"inbound_rules": inbound,
		"outbound_rules": []map[string]any{
			{"protocol": "tcp", "ports": "all", "destinations": all},
			{"protocol": "udp", "ports": "all", "destinations": all},
			{"protocol": "icmp", "destinations": all},
		},
	}
}

// CreateFirewall makes the launch's firewall (POST /firewalls).
func (d *DigitalOcean) CreateFirewall(ctx context.Context, spec FirewallSpec) (Firewall, error) {
	if !netName.MatchString(spec.Name) || !strings.HasPrefix(spec.Name, FirewallPrefix) {
		return Firewall{}, errors.New("digitalocean: the firewall name is not one this tool makes")
	}
	if !tagRe.MatchString(spec.Tag) {
		return Firewall{}, errors.New("digitalocean: the firewall's tag has characters DigitalOcean does not take")
	}
	for _, s := range spec.SSHFrom {
		if _, err := firewallSource(s); err != nil {
			return Firewall{}, fmt.Errorf("digitalocean: %w", err)
		}
	}
	// A firewall applies to droplets by tag, and DigitalOcean refuses one whose tag does not exist (422 "tag ... does not exist"): the tag is made first, here, and removed again with the firewall.
	if err := d.createTag(ctx, spec.Tag); err != nil {
		return Firewall{}, err
	}
	var out struct {
		Firewall doFirewall `json:"firewall"`
	}
	if err := d.do(ctx, "create a firewall", http.MethodPost, "/firewalls", nil, firewallBody(spec.Name, spec.Tag, spec.SSHFrom), &out); err != nil {
		d.deleteLaunchTag(spec.Tag) // the firewall that needed it was not made
		return Firewall{}, err
	}
	if !doUUIDRe.MatchString(out.Firewall.ID) {
		return Firewall{}, errors.New("digitalocean: create a firewall: the answer names no firewall")
	}
	return Firewall{ID: out.Firewall.ID, Name: spec.Name, Tag: spec.Tag}, nil
}

// CloseFirewall replaces the firewall with the same one that has no inbound rule (PUT /firewalls/{id}).
func (d *DigitalOcean) CloseFirewall(ctx context.Context, fw Firewall) error {
	if !doUUIDRe.MatchString(fw.ID) || !netName.MatchString(fw.Name) || !tagRe.MatchString(fw.Tag) {
		return errors.New("digitalocean: the firewall to close is not one this tool made")
	}
	return d.do(ctx, "close a firewall", http.MethodPut, "/firewalls/"+fw.ID, nil, firewallBody(fw.Name, fw.Tag, nil), nil)
}

// DeleteFirewall removes a firewall; one already gone is ErrNotFound. The launch tag it was made for (CreateFirewall made it) goes with it, once the firewall is gone.
func (d *DigitalOcean) DeleteFirewall(ctx context.Context, id string) error {
	if !doUUIDRe.MatchString(id) {
		return errors.New("digitalocean: the id is not a firewall id")
	}
	var tags []string
	var got struct {
		Firewall doFirewall `json:"firewall"`
	}
	if d.do(ctx, "read a firewall", http.MethodGet, "/firewalls/"+id, nil, nil, &got) == nil { // an unreadable firewall is still deleted: only the tag clean-up is skipped
		tags = got.Firewall.Tags
	}
	if err := d.do(ctx, "delete a firewall", http.MethodDelete, "/firewalls/"+id, nil, nil, nil); err != nil {
		return err
	}
	for _, t := range tags {
		d.deleteLaunchTag(t)
	}
	return nil
}

// launchTagPrefix is the start of every tag a launch makes (newLaunchTag): the only tags this tool ever deletes. A person's own tags are never touched.
const launchTagPrefix = "coral-launch-"

// createTag makes the tag a firewall will apply to (POST /tags). One that already exists is fine.
func (d *DigitalOcean) createTag(ctx context.Context, name string) error {
	if !strings.HasPrefix(name, launchTagPrefix) || !tagRe.MatchString(name) {
		return errors.New("digitalocean: the tag is not one a launch makes")
	}
	err := d.do(ctx, "create a tag", http.MethodPost, "/tags", nil, map[string]string{"name": name}, nil)
	var ae *APIError
	if errors.As(err, &ae) && ae.Status == http.StatusUnprocessableEntity && strings.Contains(strings.ToLower(ae.Message), "already") {
		return nil
	}
	return err
}

// deleteLaunchTag removes a launch's tag (DELETE /tags/{name}), on its own short deadline and whatever the answer: a tag left behind is empty and costs nothing, and the delete that called this has succeeded.
func (d *DigitalOcean) deleteLaunchTag(name string) {
	if !strings.HasPrefix(name, launchTagPrefix) || !tagRe.MatchString(name) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	// A tag some droplet still carries is left alone: deleting it would strip the launch label from a machine that may still exist (the droplet delete before it can have failed), and the checks
	// that look for that machine by the label would no longer find it (Security, #13592). A tag that cannot be read is left too.
	var got struct {
		Tag struct {
			Resources struct {
				Droplets struct {
					Count int `json:"count"`
				} `json:"droplets"`
			} `json:"resources"`
		} `json:"tag"`
	}
	if d.do(ctx, "read a tag", http.MethodGet, "/tags/"+name, nil, nil, &got) != nil || got.Tag.Resources.Droplets.Count > 0 {
		return
	}
	_ = d.do(ctx, "delete a tag", http.MethodDelete, "/tags/"+name, nil, nil, nil)
}

// ListVPCs returns the VPCs this tool made (named VPCPrefix...).
func (d *DigitalOcean) ListVPCs(ctx context.Context) ([]VPC, error) {
	var all []VPC
	for page := 1; page <= maxPages; page++ {
		var out struct {
			VPCs []doVPC `json:"vpcs"`
			doPages
		}
		q := url.Values{"per_page": {strconv.Itoa(d.pageSize)}, "page": {strconv.Itoa(page)}}
		if err := d.do(ctx, "list VPCs", http.MethodGet, "/vpcs", q, nil, &out); err != nil {
			return nil, err
		}
		for _, v := range out.VPCs {
			if strings.HasPrefix(v.Name, VPCPrefix) && doUUIDRe.MatchString(v.ID) {
				all = append(all, VPC{ID: v.ID, Name: v.Name, Region: v.Region})
			}
		}
		if out.Links.Pages.Next == "" {
			break
		}
	}
	return all, nil
}

// ListFirewalls returns the firewalls this tool made (named FirewallPrefix...).
func (d *DigitalOcean) ListFirewalls(ctx context.Context) ([]Firewall, error) {
	var all []Firewall
	for page := 1; page <= maxPages; page++ {
		var out struct {
			Firewalls []doFirewall `json:"firewalls"`
			doPages
		}
		q := url.Values{"per_page": {strconv.Itoa(d.pageSize)}, "page": {strconv.Itoa(page)}}
		if err := d.do(ctx, "list firewalls", http.MethodGet, "/firewalls", q, nil, &out); err != nil {
			return nil, err
		}
		for _, f := range out.Firewalls {
			if strings.HasPrefix(f.Name, FirewallPrefix) && doUUIDRe.MatchString(f.ID) {
				tag := ""
				if len(f.Tags) > 0 {
					tag = f.Tags[0]
				}
				all = append(all, Firewall{ID: f.ID, Name: f.Name, Tag: tag})
			}
		}
		if out.Links.Pages.Next == "" {
			break
		}
	}
	return all, nil
}
