package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/machinelaunch"
)

// machineUserData makes the cloud-init user-data for one launch: the launch's public login key, the address SSH accepts, the Coral release to install, the cap the machine announces, the Hub it joins and the agent
// CLIs (claude@V, codex@V, pi@V, agy@sha256:...). It carries no Hub credential (#10917: that goes over SSH). It is the one seam between this command and the user-data builder (machinelaunch.BuildUserData); a test replaces it.
var machineUserData = func(keys *machinelaunch.BootKeys, sshFrom, maxMode, coralVersion string, digests machinelaunch.ReleaseDigests, hubURL string, agents []string) (string, error) {
	spec := machinelaunch.UserDataSpec{AllowSSHFrom: sshFrom, MaxMode: maxMode, CoralVersion: coralVersion, CoralDigests: digests, HubURL: hubURL, Agents: agents}
	if err := keys.FillUserData(&spec); err != nil {
		return "", err
	}
	return machinelaunch.BuildUserData(spec)
}

// newMachineBootstrap makes the bootstrapper that hands the machine its credential over SSH; a test replaces it.
var newMachineBootstrap = func() machinelaunch.Bootstrapper { return &machinelaunch.SSHBootstrap{} }

// publicIPEndpoint answers with this computer's public address as plain text over TLS (the address SSH on the machine is opened to, unless --allow-ssh-from names one).
var publicIPEndpoint = "https://api.ipify.org"

// publicIPHost is the host the lookup goes to, for the confirmation to name.
func publicIPHost() string {
	u, err := url.Parse(publicIPEndpoint)
	if err != nil {
		return publicIPEndpoint
	}
	return u.Host
}

// detectSSHSource is the address SSH on the machine should accept: this computer's, from a TLS endpoint. A failure says to name one.
var detectSSHSource = func(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, publicIPEndpoint, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("could not find this computer's public address (%v): pass --allow-ssh-from ADDRESS", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 128))
	ip := net.ParseIP(strings.TrimSpace(string(b)))
	if resp.StatusCode != http.StatusOK || ip == nil {
		return "", fmt.Errorf("could not find this computer's public address: pass --allow-ssh-from ADDRESS")
	}
	return ip.String(), nil
}
