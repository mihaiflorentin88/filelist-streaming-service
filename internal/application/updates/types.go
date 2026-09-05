// Package updates resolves, verifies, and applies repository releases for
// this installation. Selection is anchored to the fixed repository: the
// public update notice is only an announcement hint, and the exact tag,
// asset, and checksum always come from repository release metadata.
package updates

import "context"

// Build flavors embedded in release and local builds. Flavor selects the
// release asset together with the platform.
const (
	FlavorGUI      = "gui"
	FlavorHeadless = "headless"
	FlavorBundle   = "bundle"
)

// Identity describes the running installation for release resolution.
type Identity struct {
	Version string
	GOOS    string
	GOARCH  string
	Flavor  string // gui, headless, or bundle
}

// Status is the observable updater state surfaced over HTTP and SSE.
type Status struct {
	CurrentVersion string `json:"currentVersion"`
	Available      bool   `json:"available"`
	Latest         string `json:"latest,omitempty"`
	Notes          string `json:"notes,omitempty"`
	ReleasedAt     string `json:"releasedAt,omitempty"`
	ReleasesURL    string `json:"releasesUrl"`
	SelfUpdate     bool   `json:"selfUpdate"`
	Applying       bool   `json:"applying"`
}

// ApplyResult reports whether an apply request was accepted and the status
// observed afterwards.
type ApplyResult struct {
	Accepted bool
	Status   Status
}

// API is the updater surface consumed by the HTTP layer and the GUI.
type API interface {
	Current() Status
	Check(context.Context) (Status, error)
	Apply(context.Context) (ApplyResult, error)
}
