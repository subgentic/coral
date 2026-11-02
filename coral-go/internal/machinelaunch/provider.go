// Package machinelaunch creates a cloud machine that runs Coral and enrolls itself with Coral Hub (#9973, the joint note of #9934). This file is the provider side: the Provider interface and the
// types a launch passes through it. A provider is one file that implements it (DigitalOcean first); the launcher, the Hub client and the user-data builder never see a provider SDK, and no test
// here ever calls a real provider: a provider is tested against a stub HTTP server.
//
// A provider token is held by its Provider value for the calls it makes and for nothing else: it is never logged, never put in an error, never sent anywhere but the provider's own API, and never
// written to the instance (the instance's user-data holds only the Hub's one-time credential).
package machinelaunch

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Tag marks every instance this tool makes, so listing and deleting find only what it created.
const Tag = "coral-machine"

// Status is an instance's state, as far as a launch needs it.
type Status string

const (
	StatusPending Status = "pending" // created, not yet running
	StatusRunning Status = "running" // up: it has an address
	StatusStopped Status = "stopped" // off or archived
	StatusUnknown Status = "unknown" // a state this tool does not know
)

// Spec is what Create is asked to make.
type Spec struct {
	Name     string   // the machine's name at the provider (a host name: 1 to 63 of a-z, 0-9, hyphen)
	Region   string   // the provider's region slug
	Size     string   // the provider's size slug
	Image    string   // the provider's image slug; "" is the provider's default (an Ubuntu LTS)
	Tags     []string // always includes Tag (Create adds it)
	UserData string   // the cloud-init user-data (BuildUserData)
	SSHKeys  []string // provider ids or fingerprints of ssh keys to install; none by default
	VPCID    string   // the VPC to make the instance in (Network.CreateVPC); "" is the provider's default network
}

// Instance is a machine at a provider.
type Instance struct {
	ID      string
	Name    string
	Status  Status
	IPv4    string // the public IPv4 once it is running, else ""
	Region  string
	Size    string
	Tags    []string
	VPCID   string    // the VPC it is in, when the provider says
	Created time.Time // when it was made, when the provider says (a prune's age)
}

// Price is what an instance costs, from the provider's own size list (for the confirm before anything is created).
type Price struct {
	HourlyUSD  float64
	MonthlyUSD float64
}

// Provider is a cloud provider this tool can make a machine at.
type Provider interface {
	// Name is the provider's short name ("digitalocean").
	Name() string
	// Validate checks the token (a read that creates nothing). A refused token is ErrUnauthorized.
	Validate(ctx context.Context) error
	// Price is the cost of a size in a region, read from the provider's own size list. A size the region does not offer is ErrNotFound.
	Price(ctx context.Context, region, size string) (Price, error)
	// Create makes an instance and returns it as the provider first reports it (usually pending).
	Create(ctx context.Context, spec Spec) (Instance, error)
	// WaitRunning polls the instance until it is running and has an address, honouring ctx; an instance that ends up in another final state is an error.
	WaitRunning(ctx context.Context, id string) (Instance, error)
	// Delete removes an instance. One that is already gone is ErrNotFound, which a cleanup ignores.
	Delete(ctx context.Context, id string) error
}

// Lister is implemented by a provider that can list the instances this tool made (the ones with Tag).
type Lister interface {
	List(ctx context.Context) ([]Instance, error)
}

// Errors a provider answers with, to be told apart with errors.Is.
var (
	ErrNotFound     = errors.New("not found")
	ErrUnauthorized = errors.New("the provider refused the token")
)

// APIError is a provider's own refusal or failure: the HTTP status and the provider's short message (never the token: a provider that echoes it back has it removed before it gets here).
type APIError struct {
	Provider string
	Op       string
	Status   int
	Message  string
}

func (e *APIError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("%s: %s: HTTP %d", e.Provider, e.Op, e.Status)
	}
	return fmt.Sprintf("%s: %s: HTTP %d: %s", e.Provider, e.Op, e.Status, e.Message)
}

// Is makes a 404 an ErrNotFound and a 401 or 403 an ErrUnauthorized.
func (e *APIError) Is(target error) bool {
	switch target {
	case ErrNotFound:
		return e.Status == 404
	case ErrUnauthorized:
		return e.Status == 401 || e.Status == 403
	}
	return false
}
