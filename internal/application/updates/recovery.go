package updates

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// DefaultHealthTimeout bounds the helper's health acknowledgement window.
const DefaultHealthTimeout = 90 * time.Second

// Operation phases, persisted before every mutation so any interruption
// leaves an actionable durable record.
const (
	// PhaseStaged: the payload is verified and staged; no live mutation has
	// been observed (the planned backup path is already recorded).
	PhaseStaged = "staged"
	// PhaseActivated: the backup holds the previous installation and the
	// live path carries the new content; health acknowledgement is pending.
	PhaseActivated = "activated"
	// PhaseConfirmed: health acknowledged; only debris cleanup remains.
	PhaseConfirmed = "confirmed"
	// PhaseRolledBack: the previous installation was restored; the next
	// startup suppresses automatic updates once.
	PhaseRolledBack = "rolled-back"
)

// journalName is the durable operation record inside the install directory.
const journalName = ".filelist-update.json"

// Helper coordination environment. The helper is the verified staged binary
// itself (or a copy of it, outside the replaced path), re-executed in a
// dedicated mode; it never runs unverified content.
const (
	helperEnvVar     = "FILELIST_UPDATE_HELPER"
	helperDirEnv     = "FILELIST_UPDATE_DIR"
	helperParentEnv  = "FILELIST_UPDATE_PARENT_PID"
	helperLiveEnv    = "FILELIST_UPDATE_LIVE_PATH"
	helperBundleEnv  = "FILELIST_UPDATE_BUNDLE_PATH"
	helperStagedEnv  = "FILELIST_UPDATE_STAGED_PATH"
	helperTimeoutEnv = "FILELIST_UPDATE_TIMEOUT_MS"

	// parentExitTimeout bounds the helper's wait for the old process to exit.
	parentExitTimeout = 2 * time.Minute
	// ackPollInterval is the journal polling period while awaiting health.
	ackPollInterval = 250 * time.Millisecond
)

// Sentinel errors for the operation lifecycle. Callers classify with
// errors.Is.
var (
	// ErrPendingOperation marks an install directory with an unfinished
	// update operation that must run recovery first.
	ErrPendingOperation = errors.New("updates: pending update operation requires recovery")

	// ErrOperationMismatch marks a health acknowledgement or helper handoff
	// that does not identify the recorded operation and version.
	ErrOperationMismatch = errors.New("updates: operation identity mismatch")
)

// Operation is the durable update transaction record. Every field is
// persisted before the state it describes can be observed on disk.
type Operation struct {
	ID           string    `json:"id"`
	Version      string    `json:"version"`
	Flavor       string    `json:"flavor"`
	Phase        string    `json:"phase"`
	Backup       string    `json:"backup,omitempty"`       // path holding the previous installation
	StagedPaths  []string  `json:"stagedPaths,omitempty"`  // archive, extraction dir, helper copies
	Deadline     time.Time `json:"deadline,omitempty"`     // health acknowledgement deadline
	SuppressNext bool      `json:"suppressNext,omitempty"` // skip automatic update on next startup only
	FailedError  string    `json:"failedError,omitempty"`  // rollback failure evidence; demands manual repair
}

// RecoveryAction is the startup decision for a pending operation.
type RecoveryAction string

const (
	// RecoveryNone: nothing pending.
	RecoveryNone RecoveryAction = ""
	// RecoveryAcknowledge: the running process is the healthy new
	// installation and should acknowledge after readiness.
	RecoveryAcknowledge RecoveryAction = "acknowledge"
	// RecoveryRollback: restore the backup and relaunch the previous
	// installation with startup-update suppression for this recovery.
	RecoveryRollback RecoveryAction = "rollback"
	// RecoveryCleanup: the transaction finished; remove backup and debris.
	RecoveryCleanup RecoveryAction = "cleanup"
	// RecoverySuppress: a rollback completed; suppress the next automatic
	// startup update once, then clear the journal.
	RecoverySuppress RecoveryAction = "suppress"
	// RecoveryManual: rollback failed; the durable backup needs manual repair.
	RecoveryManual RecoveryAction = "manual"
)

// Recovery is the startup decision for one pending operation.
type Recovery struct {
	Action    RecoveryAction
	Operation Operation
}

// InstallState is what the running process observes about its installation
// for recovery evaluation.
type InstallState struct {
	CurrentVersion string    // running build identity version
	Now            time.Time // evaluation clock
	Activated      bool      // live content is the operation's new content
}

// EvaluateRecovery decides the startup action for a persisted operation.
//
// Phase semantics:
//   - staged: no confirmed mutation. If the live content nevertheless
//     differs from the planned backup, the rename landed inside the crash
//     window and the operation is treated as activated; otherwise the
//     transaction is pure debris.
//   - activated: past the deadline there is no healthy acknowledgement, so
//     roll back. Before it, the new version starting up acknowledges; the
//     old version starting up means the helper died mid-transaction, so
//     roll back. Live content equal to the backup means the swap never
//     landed: pure cleanup.
//   - confirmed: cleanup only. rolled-back: suppression only. A recorded
//     rollback failure demands manual repair and preserves every artifact.
func EvaluateRecovery(op Operation, st InstallState) Recovery {
	if op.FailedError != "" {
		return Recovery{Action: RecoveryManual, Operation: op}
	}
	switch op.Phase {
	case PhaseStaged:
		if st.Activated {
			op.Phase = PhaseActivated
			return Recovery{Action: RecoveryRollback, Operation: op}
		}
		return Recovery{Action: RecoveryCleanup, Operation: op}
	case PhaseActivated:
		if st.Activated && st.CurrentVersion == op.Version && st.Now.Before(op.Deadline) {
			return Recovery{Action: RecoveryAcknowledge, Operation: op}
		}
		return Recovery{Action: RecoveryRollback, Operation: op}
	case PhaseConfirmed:
		return Recovery{Action: RecoveryCleanup, Operation: op}
	case PhaseRolledBack:
		return Recovery{Action: RecoverySuppress, Operation: op}
	default:
		return Recovery{Action: RecoveryManual, Operation: op}
	}
}

// Journal owns the exclusive update operation record inside one install
// directory. OpenJournal acquires the exclusive lock; concurrent updaters
// fail immediately instead of racing the transaction.
type Journal struct {
	dir  string
	lock *os.File
}

// OpenJournal creates or opens the operation journal for installDir and
// acquires exclusive operation ownership for this process.
func OpenJournal(installDir string) (*Journal, error) {
	if err := os.MkdirAll(installDir, 0o755); err != nil {
		return nil, fmt.Errorf("journal: prepare install directory: %w", err)
	}
	lock, err := os.OpenFile(filepath.Join(installDir, journalName+".lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("journal: open operation lock: %w", err)
	}
	if err := lockExclusive(lock); err != nil {
		lock.Close()
		return nil, fmt.Errorf("journal: %w", err)
	}
	return &Journal{dir: installDir, lock: lock}, nil
}

// Close releases exclusive operation ownership.
func (j *Journal) Close() error {
	if j == nil || j.lock == nil {
		return nil
	}
	err := unlockExclusive(j.lock)
	if closeErr := j.lock.Close(); err == nil {
		err = closeErr
	}
	j.lock = nil
	return err
}

// Load returns the persisted operation, or ok=false when none is recorded.
func (j *Journal) Load() (Operation, bool, error) {
	data, err := os.ReadFile(j.path())
	if errors.Is(err, os.ErrNotExist) {
		return Operation{}, false, nil
	}
	if err != nil {
		return Operation{}, false, fmt.Errorf("journal: read operation: %w", err)
	}
	var op Operation
	if err := json.Unmarshal(data, &op); err != nil {
		return Operation{}, false, fmt.Errorf("journal: parse operation: %w", err)
	}
	return op, true, nil
}

// Save atomically persists op: write, flush, rename over the journal, then
// flush the directory entry so the phase survives a crash at any point.
func (j *Journal) Save(op Operation) error {
	data, err := json.MarshalIndent(op, "", "  ")
	if err != nil {
		return fmt.Errorf("journal: encode operation: %w", err)
	}
	temp, err := os.CreateTemp(j.dir, ".filelist-journal-*.tmp")
	if err != nil {
		return fmt.Errorf("journal: write operation: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return fmt.Errorf("journal: write operation: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("journal: flush operation: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("journal: write operation: %w", err)
	}
	if err := os.Rename(tempPath, j.path()); err != nil {
		return fmt.Errorf("journal: persist operation: %w", err)
	}
	if err := syncDir(j.dir); err != nil {
		return fmt.Errorf("journal: flush install directory: %w", err)
	}
	return nil
}

// Clear removes a finished operation record.
func (j *Journal) Clear() error {
	if err := os.Remove(j.path()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("journal: clear operation: %w", err)
	}
	if err := syncDir(j.dir); err != nil {
		return fmt.Errorf("journal: flush install directory: %w", err)
	}
	return nil
}

// Acknowledge records the health acknowledgement of the running new
// installation. It must identify the operation and the new version, and is
// only valid while the operation awaits acknowledgement.
func (j *Journal) Acknowledge(opID, version string) error {
	op, found, err := j.Load()
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("%w: no pending operation", ErrOperationMismatch)
	}
	if op.Phase != PhaseActivated {
		return fmt.Errorf("%w: operation %s is in phase %q, awaiting %q", ErrOperationMismatch, op.ID, op.Phase, PhaseActivated)
	}
	if op.ID != opID || op.Version != version {
		return fmt.Errorf("%w: acknowledgement names %s/%s, operation is %s/%s", ErrOperationMismatch, opID, version, op.ID, op.Version)
	}
	op.Phase = PhaseConfirmed
	return j.Save(op)
}

func (j *Journal) path() string { return filepath.Join(j.dir, journalName) }

// newOperation builds the staged-phase record for one installation. The
// backup path is persisted before the backup exists so a crash between the
// two always leaves a recoverable record.
func newOperation(installDir string, sel Selection, target Target, stagedPaths ...string) Operation {
	return Operation{
		ID:          newOperationID(),
		Version:     sel.Version,
		Flavor:      target.Flavor,
		Phase:       PhaseStaged,
		Backup:      filepath.Join(installDir, ".filelist-backup-"+operationToken()),
		StagedPaths: stagedPaths,
	}
}

// operationToken returns a random token for identifiers and backup paths.
func operationToken() string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(fmt.Sprintf("updates: operation entropy unavailable: %v", err))
	}
	return hex.EncodeToString(raw[:])
}

// newOperationID returns a random operation identifier.
func newOperationID() string {
	return "op-" + operationToken()
}

// LoadOperation reads the operation record for an install directory without
// acquiring updater ownership. The running installation uses it to discover
// the operation it should acknowledge after readiness.
func LoadOperation(installDir string) (Operation, bool, error) {
	return (&Journal{dir: installDir}).Load()
}

// AcknowledgeOperation records the running installation's health
// acknowledgement without updater ownership: the acknowledging process is
// the new installation itself, while the updater lock belongs to the
// helper. The acknowledgement must identify the operation and the new
// version.
func AcknowledgeOperation(installDir, opID, version string) error {
	return (&Journal{dir: installDir}).Acknowledge(opID, version)
}

// filePlatform carries the single-file transaction steps for one operating
// system family; install_unix.go and install_windows.go bind it at init.
type filePlatformer interface {
	// activate takes the backup and swaps the staged executable in.
	activate(i *Installer, op Operation, payload *Payload) (Operation, error)
	// handoff transfers the activated transaction to the helper.
	handoff(i *Installer, op Operation, payload *Payload) error
	// rollback restores the previous file from the backup.
	rollback(i *Installer, op Operation, reason string) error
	// runHelper runs the helper transaction for one activated operation.
	runHelper(ctx context.Context, i *Installer, journal *Journal, op Operation, parentPID int) error
}

var filePlatform filePlatformer

// bundlePlatform carries the macOS bundle transaction steps: atomic
// directory exchange, helper handoff outside the replaced bundle, and the
// bundle helper flow. install_darwin.go binds it at init; other platforms
// leave it nil, and a bundle payload on such a platform fails closed.
type bundlePlatformer interface {
	activate(i *Installer, op Operation, payload *Payload) (Operation, error)
	handoff(i *Installer, op Operation, payload *Payload) error
	rollback(i *Installer, op Operation, reason string) error
	liveIsNew(i *Installer, op Operation) bool
	runHelper(ctx context.Context, i *Installer, journal *Journal, op Operation, parentPID int) error
}

var bundlePlatform bundlePlatformer

// Installer performs one verified installation transaction against the
// install directory owned by its journal.
type Installer struct {
	// Executable is the live executable path for file payloads, and the
	// inner launcher binary inside the live bundle for bundle payloads.
	Executable string
	// BundlePath is the live .app directory for bundle payloads.
	BundlePath    string
	Kind          PayloadKind
	HealthTimeout time.Duration
	Now           func() time.Time

	journal *Journal
}

// NewInstaller binds an installer to an exclusively owned journal.
func NewInstaller(journal *Journal, kind PayloadKind, executable, bundlePath string, healthTimeout time.Duration) *Installer {
	if healthTimeout <= 0 {
		healthTimeout = DefaultHealthTimeout
	}
	return &Installer{
		Executable:    executable,
		BundlePath:    bundlePath,
		Kind:          kind,
		HealthTimeout: healthTimeout,
		Now:           time.Now,
		journal:       journal,
	}
}

// Prepare records the staged, verified payload in the journal before any
// mutation, reserving the backup path. A pending unfinished operation must
// run recovery first.
func (i *Installer) Prepare(payload *Payload, sel Selection, target Target, stagedArchive string) (Operation, error) {
	op, found, err := i.journal.Load()
	if err != nil {
		return Operation{}, err
	}
	if found && (op.Phase == PhaseStaged || op.Phase == PhaseActivated) {
		return Operation{}, fmt.Errorf("%w: operation %s in phase %q", ErrPendingOperation, op.ID, op.Phase)
	}
	op = newOperation(i.journal.dir, sel, target, stagedArchive, payload.Dir)
	if payload.Kind == PayloadBundle {
		// The exchange counterpart is the backup: after activation the
		// previous bundle lives at the staged bundle path.
		op.Backup = payload.Bundle
	}
	if err := i.journal.Save(op); err != nil {
		return Operation{}, err
	}
	return op, nil
}

// Activate mutates the installation: the file platform preserves the
// previous file as a same-filesystem backup and atomically renames the
// staged executable over the live name; the bundle platform exchanges the
// staged and live directories atomically. Only after the mutation and a
// metadata flush is the activated phase (with its health deadline)
// persisted.
func (i *Installer) Activate(op Operation, payload *Payload) (Operation, error) {
	if i.Kind == PayloadBundle {
		if bundlePlatform == nil {
			return Operation{}, fmt.Errorf("activate: bundle installation unsupported on %s", runtimeGOOS())
		}
		return bundlePlatform.activate(i, op, payload)
	}
	if filePlatform == nil {
		return Operation{}, fmt.Errorf("activate: file installation unsupported on %s", runtimeGOOS())
	}
	return filePlatform.activate(i, op, payload)
}

// Handoff transfers the transaction to the update helper. The caller must
// exit promptly on success so the helper can complete swap, launch, health
// acknowledgement, and rollback.
func (i *Installer) Handoff(op Operation, payload *Payload) error {
	if i.Kind == PayloadBundle {
		if bundlePlatform == nil {
			return fmt.Errorf("handoff: bundle installation unsupported on %s", runtimeGOOS())
		}
		return bundlePlatform.handoff(i, op, payload)
	}
	if filePlatform == nil {
		return fmt.Errorf("handoff: file installation unsupported on %s", runtimeGOOS())
	}
	return filePlatform.handoff(i, op, payload)
}

// Acknowledge records the running installation's health acknowledgement and
// finishes the transaction: backups and staging debris are removed and the
// journal cleared. The acknowledgement must identify the operation and the
// running version.
func (i *Installer) Acknowledge(currentVersion string) error {
	op, found, err := i.journal.Load()
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("%w: no pending operation to acknowledge", ErrOperationMismatch)
	}
	if err := i.journal.Acknowledge(op.ID, currentVersion); err != nil {
		return err
	}
	return i.Cleanup(op)
}

// Rollback restores the previous installation from the durable backup and
// marks the operation rolled back with next-startup suppression. A failed
// restore leaves the backup in place, records the failure, and returns an
// error: the installation stays recoverable.
func (i *Installer) Rollback(op Operation, reason string) error {
	if i.Kind == PayloadBundle {
		if bundlePlatform == nil {
			return fmt.Errorf("rollback: bundle installation unsupported on %s", runtimeGOOS())
		}
		return bundlePlatform.rollback(i, op, reason)
	}
	if filePlatform == nil {
		return fmt.Errorf("rollback: file installation unsupported on %s", runtimeGOOS())
	}
	return filePlatform.rollback(i, op, reason)
}

// Recover evaluates and executes the startup action for a pending
// operation. Cleanup and rollback disk effects run here; the acknowledge
// action is returned for the caller to perform after readiness, and the
// suppress action keeps the journal until ConsumeSuppression.
func (i *Installer) Recover(currentVersion string) (Recovery, error) {
	op, found, err := i.journal.Load()
	if err != nil {
		return Recovery{}, err
	}
	if !found {
		return Recovery{Action: RecoveryNone}, nil
	}
	recovery := EvaluateRecovery(op, i.installState(op, currentVersion))
	switch recovery.Action {
	case RecoveryCleanup:
		if err := i.Cleanup(op); err != nil {
			return recovery, err
		}
	case RecoveryRollback:
		if err := i.Rollback(op, "startup recovery"); err != nil {
			return Recovery{Action: RecoveryManual, Operation: op}, err
		}
		recovery.Operation = op
	}
	return recovery, nil
}

// ConsumeSuppression clears the journal after the caller honored a
// suppression decision for this startup only.
func (i *Installer) ConsumeSuppression() error {
	return i.journal.Clear()
}

// Cleanup removes the backup and all staging debris, then clears the
// journal. Best effort per artifact: leftovers of a crashed cleanup are
// retried by the next startup (confirmed phase re-cleans).
func (i *Installer) Cleanup(op Operation) error {
	for _, path := range backupAndStagingPaths(op) {
		os.RemoveAll(path)
	}
	if err := syncDir(i.journal.dir); err != nil {
		return fmt.Errorf("cleanup: flush install directory: %w", err)
	}
	return i.journal.Clear()
}

func backupAndStagingPaths(op Operation) []string {
	paths := make([]string, 0, len(op.StagedPaths)+1)
	if op.Backup != "" {
		paths = append(paths, op.Backup)
	}
	return append(paths, op.StagedPaths...)
}

// livePath is the path the helper replaces: the executable for file
// payloads, the bundle directory for bundle payloads.
func (i *Installer) livePath() string {
	if i.Kind == PayloadBundle {
		return i.BundlePath
	}
	return i.Executable
}

func (i *Installer) now() time.Time {
	if i.Now == nil {
		return time.Now()
	}
	return i.Now()
}

// installState observes what recovery evaluation needs: whether the live
// content already carries the operation's new content.
func (i *Installer) installState(op Operation, currentVersion string) InstallState {
	return InstallState{
		CurrentVersion: currentVersion,
		Now:            i.now(),
		Activated:      i.liveIsActivated(op),
	}
}

// liveIsActivated reports whether the live path already carries the new
// content. For file payloads the backup digest is the pre-mutation
// reference: identical content means the swap never landed. For bundles the
// live Info.plist version is the marker; a missing backup likewise means no
// mutation happened.
func (i *Installer) liveIsActivated(op Operation) bool {
	if i.Kind == PayloadBundle {
		return bundlePlatform != nil && bundlePlatform.liveIsNew(i, op)
	}
	liveDigest, liveErr := digestFile(i.Executable)
	backupDigest, backupErr := digestFile(op.Backup)
	if liveErr != nil || backupErr != nil {
		// A missing backup means the mutation never landed; a missing live
		// path cannot be activated either.
		return false
	}
	return !equalDigests(liveDigest, backupDigest)
}

// digestFile streams a file through SHA-256 without buffering it whole.
func digestFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return nil, err
	}
	return digest.Sum(nil), nil
}

func equalDigests(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if a[k] != b[k] {
			return false
		}
	}
	return true
}

// RunUpdateHelper runs the update-helper transaction when this process was
// started in helper mode. It reports handled=false when the process was
// started normally. The helper runs after the installing process exits and
// performs launch, bounded health acknowledgement, and rollback; it operates
// only on the verified operation recorded in the journal.
func RunUpdateHelper(ctx context.Context) (handled bool, err error) {
	if os.Getenv(helperEnvVar) != "1" {
		return false, nil
	}
	dir := os.Getenv(helperDirEnv)
	if dir == "" {
		return true, fmt.Errorf("helper: missing %s", helperDirEnv)
	}
	journal, err := OpenJournal(dir)
	if err != nil {
		return true, fmt.Errorf("helper: %w", err)
	}
	defer journal.Close()
	op, found, err := journal.Load()
	if err != nil {
		return true, fmt.Errorf("helper: %w", err)
	}
	if !found || op.Phase != PhaseActivated {
		return true, nil
	}
	installer := NewInstaller(journal, payloadKindFor(op), os.Getenv(helperLiveEnv), os.Getenv(helperBundleEnv), helperTimeout())
	if op.Flavor == FlavorBundle {
		if bundlePlatform == nil {
			return true, fmt.Errorf("helper: bundle installation unsupported on %s", runtimeGOOS())
		}
		return true, bundlePlatform.runHelper(ctx, installer, journal, op, helperParentPID())
	}
	if filePlatform == nil {
		return true, fmt.Errorf("helper: file installation unsupported on %s", runtimeGOOS())
	}
	return true, filePlatform.runHelper(ctx, installer, journal, op, helperParentPID())
}

// helperEnv builds the coordination environment for a helper handoff. The
// health timeout travels with the handoff so the helper enforces exactly
// the window the installer configured.
func helperEnv(i *Installer) []string {
	return []string{
		helperEnvVar + "=1",
		helperDirEnv + "=" + i.journal.dir,
		helperParentEnv + "=" + strconv.Itoa(os.Getpid()),
		helperTimeoutEnv + "=" + strconv.FormatInt(i.HealthTimeout.Milliseconds(), 10),
	}
}

// helperTimeout reads the health acknowledgement window carried through the
// handoff environment, falling back to the default.
func helperTimeout() time.Duration {
	ms, err := strconv.ParseInt(os.Getenv(helperTimeoutEnv), 10, 64)
	if err != nil || ms <= 0 {
		return DefaultHealthTimeout
	}
	return time.Duration(ms) * time.Millisecond
}

// helperParentPID parses the installing process's pid from the handoff
// environment; 0 means unknown.
func helperParentPID() int {
	pid, err := strconv.Atoi(os.Getenv(helperParentEnv))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

func payloadKindFor(op Operation) PayloadKind {
	if op.Flavor == FlavorBundle {
		return PayloadBundle
	}
	return PayloadFile
}

// cleanEnvironment strips helper coordination variables for launched
// installations so a launched update never re-enters helper mode.
func cleanEnvironment() []string {
	const prefix = "FILELIST_UPDATE_"
	env := os.Environ()
	kept := make([]string, 0, len(env))
	for _, entry := range env {
		if len(entry) >= len(prefix) && entry[:len(prefix)] == prefix {
			continue
		}
		kept = append(kept, entry)
	}
	return kept
}

// runtimeGOOS names the host GOOS for unsupported-platform errors.
func runtimeGOOS() string { return runtime.GOOS }

// detachedProcess is a launched background installation whose death the
// helper observes.
type detachedProcess struct {
	cmd      *exec.Cmd
	finished chan struct{}
}

func (d *detachedProcess) alive() bool {
	select {
	case <-d.finished:
		return false
	default:
		return true
	}
}

// awaitHealth polls the journal until the new process acknowledges, the
// deadline passes, or the new process dies early.
func awaitHealth(ctx context.Context, installer *Installer, journal *Journal, child *detachedProcess) error {
	deadline := installer.now().Add(installer.HealthTimeout)
	for {
		if ctx.Err() != nil {
			return fmt.Errorf("helper cancelled: %w", ctx.Err())
		}
		op, found, err := journal.Load()
		if err != nil {
			return fmt.Errorf("helper: read operation: %w", err)
		}
		if found && op.Phase == PhaseConfirmed {
			return nil
		}
		if installer.now().After(deadline) {
			return fmt.Errorf("health acknowledgement not received within %s", installer.HealthTimeout)
		}
		if child != nil && !child.alive() {
			return errors.New("new installation exited before acknowledging health")
		}
		sleep(ctx, ackPollInterval)
	}
}

// relaunchPrevious relaunches the previous installation at the live path
// after a successful rollback.
func relaunchPrevious(livePath string) error {
	if _, err := spawnDetached(livePath, cleanEnvironment()); err != nil {
		return fmt.Errorf("relaunch previous installation: %w", err)
	}
	return nil
}

func sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
