//go:build headless || (linux && arm)

package updates

// buildFlavor mirrors the GUI fallback constraint: this build always runs
// the headless runtime shape.
const buildFlavor = FlavorHeadless
