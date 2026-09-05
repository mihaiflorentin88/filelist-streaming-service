package updates

import (
	"fmt"
	"strings"

	"golang.org/x/mod/semver"
)

// normalizeVersion trims surrounding space and one leading tag prefix "v",
// yielding the bare version text used in release asset names. Exactly one
// prefix is stripped: asset names never carry an optional "v".
func normalizeVersion(version string) string {
	return strings.TrimPrefix(strings.TrimSpace(version), "v")
}

// canonicalVersion converts a bare version into the v-prefixed form the
// semver library compares. A candidate must be a full major.minor.patch
// release version; prerelease and build metadata are preserved unchanged so
// semver.Compare keeps their precedence. ok is false for empty, partial, or
// otherwise invalid versions.
func canonicalVersion(version string) (string, bool) {
	if version == "" {
		return "", false
	}
	canonical := "v" + version
	if !semver.IsValid(canonical) || !fullReleaseCore(canonical) {
		return "", false
	}
	return canonical, true
}

// fullReleaseCore reports whether the core of a v-prefixed version is three
// numeric components. The semver library accepts "v1"; release tags never
// carry a partial core.
func fullReleaseCore(canonical string) bool {
	core := canonical[1:]
	if cut := strings.IndexAny(core, "-+"); cut >= 0 {
		core = core[:cut]
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		for _, digit := range part {
			if digit < '0' || digit > '9' {
				return false
			}
		}
	}
	return true
}

// SelfUpdateCapable reports whether the build identity can resolve and apply
// repository releases. Development and otherwise invalid build identities
// are manual-only.
func SelfUpdateCapable(identity Identity) bool {
	_, ok := canonicalVersion(normalizeVersion(identity.Version))
	return ok
}

// IsNewer reports whether candidate is a strictly newer release than current,
// preserving prerelease precedence (0.4.0-rc.1 sorts before 0.4.0). An
// invalid side is an error rather than a silent "no update".
func IsNewer(current, candidate string) (bool, error) {
	currentCanonical, ok := canonicalVersion(normalizeVersion(current))
	if !ok {
		return false, fmt.Errorf("current version %q is not a release version", current)
	}
	candidateCanonical, ok := canonicalVersion(normalizeVersion(candidate))
	if !ok {
		return false, fmt.Errorf("candidate version %q is not a release version", candidate)
	}
	return semver.Compare(candidateCanonical, currentCanonical) > 0, nil
}
