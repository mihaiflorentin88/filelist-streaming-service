package updates

// DetectFlavor resolves the installation flavor from its actual shape. The
// linux ARM build always runs the headless fallback — the GUI half of the
// build constraint is unreachable there — so it resolves to headless even
// when the headless build tag is absent. A macOS .app installation reports
// the bundle flavor from its actual install shape. Everything else inherits
// the build-tag flavor constant: headless under -tags headless, gui
// otherwise.
func DetectFlavor(goos, goarch string, bundleInstall bool) string {
	if bundleInstall {
		return FlavorBundle
	}
	if goos == "linux" && goarch == "arm" {
		return FlavorHeadless
	}
	return buildFlavor
}
