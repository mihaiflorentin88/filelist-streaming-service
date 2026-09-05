//go:build !headless && !(linux && arm)

package updates

// buildFlavor mirrors the GUI constraint: this build runs the GUI runtime
// shape unless the platform forces the fallback.
const buildFlavor = FlavorGUI
