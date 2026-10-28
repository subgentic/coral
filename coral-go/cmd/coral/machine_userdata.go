package main

import "github.com/subgentic/coral/internal/machinelaunch"

// machineUserData makes the cloud-init user-data for one machine credential: the Coral release to install, the cap the machine announces, the Hub it joins and the agent CLIs (claude@V, codex@V, pi@V,
// agy@sha256:...). It is the one seam between this command and the user-data builder (machinelaunch.BuildUserData); a test replaces it.
var machineUserData = func(credential, maxMode, coralVersion, hubURL string, agents []string) (string, error) {
	return machinelaunch.BuildUserData(machinelaunch.UserDataSpec{Credential: credential, MaxMode: maxMode, CoralVersion: coralVersion, HubURL: hubURL, Agents: agents})
}

// checkCredential stands in for the credential while the flags are only being checked, before any secret is read.
const checkCredential = "chb_0000000000000000000000000000000000"
