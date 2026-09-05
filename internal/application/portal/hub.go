// Hub owns the portal integration state: it serializes refresh cycles against
// the upstream Client, keeps the cached Snapshot, notices, and promotions that
// the local HTTP surface serves, and publishes portal.state events through the
// injected sink. Composition injects the live settings reader, clock, jitter
// function, and sink; this package never imports composition or the upstream
// adapter. Failure classification works on the package sentinels, which the
// adapter's typed errors wrap.
package portal

import (
	"context"
	"errors"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

var (
	// ErrCredentials marks rejected or missing credentials (401/403): a form
	// error, never a service outage.
	ErrCredentials = errors.New("portal credentials rejected")
	// ErrUnavailable marks transport outages and upstream 5xx responses.
	ErrUnavailable = errors.New("portal integration unavailable")
	// ErrNoticeAbsent marks an absent update feed entry: nothing published
	// yet, distinct from a failure to fetch.
	ErrNoticeAbsent = errors.New("no portal update notice published")
	// ErrAccountsUnavailable is returned by gated account operations while
	// the account surface is hidden (no refresh yet, or a transport outage
	// awaiting a successful health probe).
	ErrAccountsUnavailable = errors.New("portal accounts are unavailable")
	// ErrPromotionsUnavailable is returned by click tracking while the
	// promotion slot is hidden.
	ErrPromotionsUnavailable = errors.New("portal promotions are unavailable")
)

// errSuperseded reports a refresh whose results were discarded because the
// settings generation moved underneath it.
var errSuperseded = errors.New("portal refresh superseded by a settings change")

// Sink receives integration events. The service publisher is the production
// sink; the payload is the marshalled event body.
type Sink func(kind string, payload any)

const (
	defaultRefreshInterval = time.Hour
	defaultPollInterval    = 30 * time.Second
	defaultPromotionCount  = 5
)

// hubState is the mutable integration state guarded by Hub.mu. It is never
// held across network calls: refresh cycles build a candidate locally and
// commit it in one critical section.
type hubState struct {
	accountsEnabled bool
	adsEnabled      bool
	promotionLive   bool
	donor           bool
	donorUntil      time.Time
	links           []Link
	promotions      []Promotion
}

// Hub serializes portal integration. Create one with NewHub and own it with
// Run(ctx); cancellation is the only stop mechanism, so there is no
// Stop-before-Start deadlock to avoid.
type Hub struct {
	client          Client
	apiKey          func() string
	now             func() time.Time
	jitter          func(time.Duration) time.Duration
	sink            Sink
	refreshInterval time.Duration
	pollInterval    time.Duration
	promotionCount  int

	refreshMu sync.Mutex // serializes refresh cycles
	running   atomic.Bool

	mu         sync.Mutex
	state      hubState
	generation int
	lastKey    string
	notice     Notice
	hasNotice  bool
}

// NewHub builds the integration hub. A nil clock falls back to time.Now, a
// nil jitter leaves the base interval untouched, and a nil sink drops events.
func NewHub(client Client, apiKey func() string, now func() time.Time, jitter func(time.Duration) time.Duration, sink Sink) *Hub {
	if apiKey == nil {
		apiKey = func() string { return "" }
	}
	if now == nil {
		now = time.Now
	}
	if sink == nil {
		sink = func(string, any) {}
	}
	h := &Hub{
		client:          client,
		apiKey:          apiKey,
		now:             now,
		jitter:          jitter,
		sink:            sink,
		refreshInterval: defaultRefreshInterval,
		pollInterval:    defaultPollInterval,
		promotionCount:  defaultPromotionCount,
	}
	h.lastKey = h.apiKey()
	return h
}

// nextInterval is the production cadence: one hour plus the bounded nonzero
// jitter injected by composition, never allowed to collapse to zero.
func (h *Hub) nextInterval() time.Duration {
	interval := h.refreshInterval
	if h.jitter != nil {
		if jittered := interval + h.jitter(interval); jittered > 0 {
			return jittered
		}
	}
	return interval
}

// Snapshot returns the current integration state. Slices are copies: callers
// can never mutate the hub's internal state through them.
func (h *Hub) Snapshot() Snapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	return Snapshot{
		AccountsEnabled: h.state.accountsEnabled,
		AdsEnabled:      h.state.adsEnabled && h.state.promotionLive,
		Donor:           h.state.donor,
		Links:           append(make([]Link, 0, len(h.state.links)), h.state.links...),
	}
}

// Promotions returns the cached creatives for the local delivery endpoint.
// The slice is a copy.
func (h *Hub) Promotions() []Promotion {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append(make([]Promotion, 0, len(h.state.promotions)), h.state.promotions...)
}

// Notice returns the cached update notice. The bool distinguishes an absent
// notice from a valid zero value.
func (h *Hub) Notice() (Notice, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.notice, h.hasNotice
}

// RefreshNotice fetches the update notice and caches it. An absent notice
// clears the cache and returns false without an error; a failed fetch clears
// the cache too and returns the error. Notice refresh feeds updater checks
// without controlling install eligibility.
func (h *Hub) RefreshNotice(ctx context.Context) (Notice, bool, error) {
	notice, err := h.client.Notice(ctx)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.notice, h.hasNotice = Notice{}, false
	if err != nil {
		if errors.Is(err, ErrNoticeAbsent) {
			return Notice{}, false, nil
		}
		return Notice{}, false, err
	}
	h.notice, h.hasNotice = notice, true
	return notice, true, nil
}

// Refresh runs one serialized refresh cycle: public settings gate accounts
// and promotions, then links, donor status, and promotions fail
// independently — each error removes only its own surface.
func (h *Hub) Refresh(ctx context.Context) error {
	h.refreshMu.Lock()
	defer h.refreshMu.Unlock()
	return h.refresh(ctx)
}

func (h *Hub) refresh(ctx context.Context) error {
	h.noteSettings()
	g := h.currentGeneration()

	if ctx.Err() != nil {
		return ctx.Err()
	}
	next := h.current()

	settings, err := h.client.Settings(ctx)
	if stale := h.gate(ctx, g); stale != nil {
		return stale
	}
	if err != nil {
		// A public-settings failure removes accounts and promotions;
		// links are an independent surface and stay.
		next.accountsEnabled, next.adsEnabled, next.promotionLive = false, false, false
		next.donor, next.donorUntil = false, time.Time{}
		next.promotions = nil
		h.commit(next)
		return err
	}
	next.accountsEnabled = settings.AccountsEnabled
	next.adsEnabled = settings.AdsEnabled

	var errs []error

	links, err := h.client.Links(ctx)
	if stale := h.gate(ctx, g); stale != nil {
		return stale
	}
	if err != nil {
		errs = append(errs, err) // keep the previously known links
	} else {
		next.links = links
	}

	if settings.AccountsEnabled {
		status, err := h.client.AccountStatus(ctx, h.apiKey())
		if stale := h.gate(ctx, g); stale != nil {
			return stale
		}
		switch {
		case err == nil:
			next.donor, next.donorUntil = false, time.Time{}
			if status.Donor {
				if status.DonorUntil != nil {
					if h.now().Before(*status.DonorUntil) {
						next.donor, next.donorUntil = true, *status.DonorUntil
					}
				} else {
					next.donor = true
				}
			}
		case isCredentials(err):
			next.donor, next.donorUntil = false, time.Time{} // a rejected key is not an outage
		default:
			// A true account transport outage hides the account controls
			// until a later successful health probe restores the gate.
			next.accountsEnabled = false
			next.donor, next.donorUntil = false, time.Time{}
			errs = append(errs, err)
		}
	} else {
		next.donor, next.donorUntil = false, time.Time{}
	}

	switch {
	case settings.AdsEnabled && next.promotionLive:
		// The slot is live: deliver directly.
		promotions, err := h.client.Promotions(ctx, h.promotionCount)
		if stale := h.gate(ctx, g); stale != nil {
			return stale
		}
		if err != nil {
			// A delivery failure hides the slot; recovery happens
			// through the non-impression availability probe.
			next.promotions, next.promotionLive = nil, false
			errs = append(errs, err)
		} else {
			next.promotions = promotions
		}
	case settings.AdsEnabled:
		// The slot is hidden: recover through the non-impression
		// availability probe before delivering again.
		available, err := h.client.PromotionAvailability(ctx)
		if stale := h.gate(ctx, g); stale != nil {
			return stale
		}
		if err != nil {
			next.promotions = nil
			errs = append(errs, err)
		} else if !available {
			next.promotions = nil // no creative exists: absent slot, not a fabricated one
		} else {
			promotions, err := h.client.Promotions(ctx, h.promotionCount)
			if stale := h.gate(ctx, g); stale != nil {
				return stale
			}
			if err != nil {
				next.promotions, next.promotionLive = nil, false
				errs = append(errs, err)
			} else {
				next.promotions, next.promotionLive = promotions, true
			}
		}
	default:
		next.promotions, next.promotionLive = nil, false
	}

	h.commit(next)
	return errors.Join(errs...)
}

// Run drives the hub until the context is cancelled: an immediate initial
// refresh, hourly jittered refreshes plus notice fetches, a short settings
// poll that refreshes as soon as the supporter key changes, and donor expiry
// scheduled at its actual time. Run is blocking; composition owns and joins
// it through the context.
func (h *Hub) Run(ctx context.Context) error {
	if !h.running.CompareAndSwap(false, true) {
		return errors.New("portal hub is already running")
	}
	defer h.running.Store(false)
	if ctx.Err() != nil {
		return ctx.Err() // shutdown before any refresh began
	}

	_ = h.refresh(ctx)

	poll := time.NewTicker(h.effectivePollInterval())
	defer poll.Stop()
	var (
		refreshC     <-chan time.Time
		expiryTimer  *time.Timer
		expiryC      <-chan time.Time
		scheduledFor time.Time
	)
	armRefresh := func() { refreshC = time.After(h.nextInterval()) }
	armRefresh()

	for {
		if delay, ok := h.donorDelay(); ok {
			target := h.now().Add(delay)
			if expiryC == nil || !target.Equal(scheduledFor) {
				if expiryTimer != nil {
					expiryTimer.Stop()
				}
				expiryTimer = time.NewTimer(delay)
				expiryC = expiryTimer.C
				scheduledFor = target
			}
		} else if expiryTimer != nil {
			expiryTimer.Stop()
			expiryTimer, expiryC = nil, nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-refreshC:
			_ = h.refresh(ctx)
			_, _, _ = h.RefreshNotice(ctx)
			armRefresh()
		case <-poll.C:
			if h.noteSettings() {
				_ = h.refresh(ctx)
			}
		case <-expiryC:
			h.expireDonor()
			expiryTimer, expiryC = nil, nil
		}
	}
}

func (h *Hub) effectivePollInterval() time.Duration {
	if h.pollInterval > 0 {
		return h.pollInterval
	}
	return defaultPollInterval
}

// noteSettings reads the live settings reader; a changed supporter key bumps
// the generation so stale in-flight responses are discarded, and reports
// whether a refresh should run now instead of waiting an hour.
func (h *Hub) noteSettings() bool {
	key := h.apiKey()
	h.mu.Lock()
	defer h.mu.Unlock()
	if key == h.lastKey {
		return false
	}
	h.lastKey = key
	h.generation++
	return true
}

func (h *Hub) currentGeneration() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.generation
}

// gate rejects a refresh cycle whose context is done or whose settings
// generation moved underneath it: stale responses must never be committed.
func (h *Hub) gate(ctx context.Context, g int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if h.currentGeneration() != g {
		return errSuperseded
	}
	return nil
}

func (h *Hub) current() hubState {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.state
}

// commit applies a candidate state in one critical section and publishes
// portal.state through the sink when the snapshot actually changed.
func (h *Hub) commit(next hubState) {
	h.mu.Lock()
	previous := h.state
	h.state = next
	h.mu.Unlock()
	if h.snapshotChanged(previous, next) {
		h.emit()
	}
}

func (h *Hub) snapshotChanged(before, after hubState) bool {
	return before.accountsEnabled != after.accountsEnabled ||
		before.adsEnabled != after.adsEnabled ||
		before.promotionLive != after.promotionLive ||
		before.donor != after.donor ||
		!before.donorUntil.Equal(after.donorUntil) ||
		!slices.Equal(before.links, after.links)
}

func (h *Hub) emit() {
	h.sink("portal.state", h.Snapshot())
}

// donorDelay reports how long to wait until the cached donor expiry, if any.
func (h *Hub) donorDelay() (time.Duration, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.state.donor || h.state.donorUntil.IsZero() {
		return 0, false
	}
	delay := h.state.donorUntil.Sub(h.now())
	if delay <= 0 {
		return 0, false
	}
	return delay, true
}

// expireDonor deactivates donor status whose expiry has passed.
func (h *Hub) expireDonor() {
	h.mu.Lock()
	if h.state.donor && !h.state.donorUntil.IsZero() && !h.now().Before(h.state.donorUntil) {
		h.state.donor, h.state.donorUntil = false, time.Time{}
		h.mu.Unlock()
		h.emit()
		return
	}
	h.mu.Unlock()
}

func isCredentials(err error) bool { return errors.Is(err, ErrCredentials) }

func isUnavailable(err error) bool { return errors.Is(err, ErrUnavailable) }

// accountGateOpen reports whether gated account operations may reach
// upstream.
func (h *Hub) accountGateOpen() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.state.accountsEnabled
}

// promotionsLive reports whether click tracking may proceed.
func (h *Hub) promotionsLive() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.state.adsEnabled && h.state.promotionLive
}

// observeAccountOutcome folds an account operation's transport outcome into
// the gate: a transport outage hides the controls, a success proves the
// service is reachable again, and a credential rejection changes nothing.
func (h *Hub) observeAccountOutcome(err error) {
	if err == nil || isCredentials(err) || !isUnavailable(err) {
		return
	}
	h.mu.Lock()
	next := h.state
	changed := next.accountsEnabled || next.donor
	next.accountsEnabled = false
	next.donor, next.donorUntil = false, time.Time{}
	h.state = next
	h.mu.Unlock()
	if changed {
		h.emit()
	}
}

// AccountStatus delegates the supporter-status lookup for the configured key.
func (h *Hub) AccountStatus(ctx context.Context, apiKey string) (AccountStatus, error) {
	if !h.accountGateOpen() {
		return AccountStatus{}, ErrAccountsUnavailable
	}
	status, err := h.client.AccountStatus(ctx, apiKey)
	h.observeAccountOutcome(err)
	return status, err
}

// Login delegates credential exchange. A 401 is a form error and never an
// outage; a transport outage hides the account surface.
func (h *Hub) Login(ctx context.Context, email, password string) (Session, error) {
	if !h.accountGateOpen() {
		return Session{}, ErrAccountsUnavailable
	}
	session, err := h.client.Login(ctx, email, password)
	h.observeAccountOutcome(err)
	return session, err
}

// Register delegates account creation without implying login.
func (h *Hub) Register(ctx context.Context, email, password, displayName string) error {
	if !h.accountGateOpen() {
		return ErrAccountsUnavailable
	}
	err := h.client.Register(ctx, email, password, displayName)
	h.observeAccountOutcome(err)
	return err
}

// Me delegates identity lookup for a bearer token.
func (h *Hub) Me(ctx context.Context, token string) (User, error) {
	if !h.accountGateOpen() {
		return User{}, ErrAccountsUnavailable
	}
	user, err := h.client.Me(ctx, token)
	h.observeAccountOutcome(err)
	return user, err
}

// Click delegates promotion click tracking while the slot is live.
func (h *Hub) Click(ctx context.Context, provider, id string) (string, error) {
	if !h.promotionsLive() {
		return "", ErrPromotionsUnavailable
	}
	return h.client.Click(ctx, provider, id)
}
