// Package faketoken builds the made-up credentials Go tests feed to the redactors.
//
// A test needs a string shaped like a GitHub token or an AWS key to prove it is hidden, but a
// literal of that shape in the repository trips the secret scanner (gitleaks), so each test used
// to split one by hand ("ghp_" + "abc..."). The split lives here, once: a test passes only the
// body, which has no scanner shape of its own. Import it from test files only.
package faketoken

// githubPrefix and awsPrefix are written as two pieces so that no key-shaped literal exists in
// this file either.
const (
	githubPrefix = "gh" + "p_"
	awsPrefix    = "AK" + "IA"
)

// GitHub returns a GitHub personal access token shaped string: ghp_ then body.
func GitHub(body string) string { return githubPrefix + body }

// AWS returns an AWS access key id shaped string: AKIA then body.
func AWS(body string) string { return awsPrefix + body }
