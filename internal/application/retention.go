package application

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
	"github.com/mihaiflorentin88/filelist-streaming-service/internal/platform/config"
)

// retentionKind is the persisted Job kind for storage enforcement. The
// scheduler runs it hourly next to the catalog sync.
const retentionKind = "retention"

// gigabytesToBytes converts the fractional-GB settings into bytes using binary
// gigabytes (GiB), the convention qBittorrent reports torrent sizes in.
func gigabytesToBytes(gb float64) int64 {
	return int64(gb * (1 << 30))
}

// retentionRoute is one Engine route — a torrent — plus every Managed download
// row pinned to it. Season-pack siblings share a route and die together.
type retentionRoute struct {
	engineID string
	hash     string
	rows     []domain.Download
	status   domain.DownloadStatus
}

// completedAt stands in for a completion timestamp: the oldest row timestamp
// on the route, since the schema keeps no dedicated completion column.
func (r retentionRoute) completedAt() time.Time {
	oldest := r.rows[0].UpdatedAt
	for _, row := range r.rows[1:] {
		if row.UpdatedAt.Before(oldest) {
			oldest = row.UpdatedAt
		}
	}
	return oldest
}

// retentionProtected is the eviction protection predicate (ADR-0004 defaults):
// incomplete torrents and actively-streamed (leased) downloads are never
// chosen. Ticket #49 turns these defaults into user toggles by extending this
// predicate, never the engine loop.
func retentionProtected(route retentionRoute) bool {
	if route.status.Progress < 1 {
		return true
	}
	for _, row := range route.rows {
		if row.Leased || row.Progress < 1 {
			return true
		}
	}
	return false
}

// oldestCompletedFirst orders candidates for eviction, oldest completed first
// (ADR-0004 default rule). Ticket #49 replaces this ordering with a
// user-composed rule list; swap this function, not the engine loop.
func oldestCompletedFirst(candidates []retentionRoute) {
	sort.Slice(candidates, func(i, j int) bool {
		if !candidates[i].completedAt().Equal(candidates[j].completedAt()) {
			return candidates[i].completedAt().Before(candidates[j].completedAt())
		}
		return candidates[i].engineID < candidates[j].engineID
	})
}

// retentionPlan is one evaluation pass over live engine telemetry.
type retentionPlan struct {
	routes      []retentionRoute
	storedBytes int64
	freeBytes   int64
	freeErr     error
}

// retentionSurvey groups Managed downloads by Engine route, samples engine
// Status once per route, and probes free space on the download root. A route
// the engine cannot describe is neither counted nor evicted — protection errs
// on the safe side.
func (s *Service) retentionSurvey(ctx context.Context) (retentionPlan, error) {
	managed, err := s.repo.ListDownloads(ctx)
	if err != nil {
		return retentionPlan{}, err
	}
	byRoute := map[string][]domain.Download{}
	order := []string{}
	for _, row := range managed {
		if _, ok := engineHash(row.EngineID); !ok {
			continue
		}
		if _, seen := byRoute[row.EngineID]; !seen {
			order = append(order, row.EngineID)
		}
		byRoute[row.EngineID] = append(byRoute[row.EngineID], row)
	}
	plan := retentionPlan{}
	for _, engineID := range order {
		hash, _ := engineHash(engineID)
		status, statusErr := s.engine.Status(ctx, hash)
		if statusErr != nil {
			continue
		}
		plan.routes = append(plan.routes, retentionRoute{engineID: engineID, hash: hash, rows: byRoute[engineID], status: status})
		plan.storedBytes += status.TotalBytes
	}
	plan.freeBytes, plan.freeErr = s.freeSpace(s.settings.Get().DownloadRoot)
	return plan, nil
}

// retentionDeficit reports which check tripped and how many bytes must go.
// The Allocation cap is evaluated first; the Reserve only triggers eviction
// while the cap is satisfied. A zero-valued setting disables its check.
func retentionDeficit(plan retentionPlan, settings config.Settings) (string, int64, bool) {
	if settings.AllocationGB > 0 {
		if excess := plan.storedBytes - gigabytesToBytes(settings.AllocationGB); excess > 0 {
			return "cap", excess, true
		}
	}
	if settings.ReserveGB > 0 && plan.freeErr == nil {
		if deficit := gigabytesToBytes(settings.ReserveGB) - plan.freeBytes; deficit > 0 {
			return "reserve", deficit, true
		}
	}
	return "", 0, false
}

// evictOldest removes one unprotected torrent from the surveyed plan —
// oldest completed first (ADR-0004) — through the same delete path as the
// manual remove action, and announces it on the live feed. It reports false
// when storage holds no evictable torrent. The retention job and the
// download admission gate (starvation path) share this hook; the protection
// predicate and ordering live only here.
func (s *Service) evictOldest(ctx context.Context, plan retentionPlan, reason string) (retentionRoute, bool, error) {
	candidates := make([]retentionRoute, 0, len(plan.routes))
	for _, route := range plan.routes {
		if !retentionProtected(route) {
			candidates = append(candidates, route)
		}
	}
	if len(candidates) == 0 {
		return retentionRoute{}, false, nil
	}
	oldestCompletedFirst(candidates)
	victim := candidates[0]
	if err := s.removeTorrent(ctx, victim.engineID); err != nil {
		return retentionRoute{}, false, err
	}
	s.publish("downloads.evicted", s.evictionEvent(ctx, victim, reason))
	return victim, true, nil
}

// RunRetention enforces the Allocation cap and free-space Reserve (ADR-0004).
// It evicts one torrent at a time — through the same delete path as the manual
// remove action — re-evaluating after each until storage fits again or only
// protected downloads remain. The run is synchronous, follows the persisted
// Job pattern, and is scheduled hourly next to the catalog sync.
func (s *Service) RunRetention() (domain.Job, error) {
	job := domain.Job{ID: retentionKind, Kind: retentionKind, State: "queued", Label: "Enforce storage allocation and reserve", DedupeKey: retentionKind, Attempt: 1, UpdatedAt: time.Now().UTC()}
	jobs, _ := s.repo.ListJobs(context.Background(), 200)
	for _, existing := range jobs {
		if existing.DedupeKey == job.DedupeKey && (existing.State == "queued" || existing.State == "running") {
			return existing, nil
		}
		if existing.DedupeKey == job.DedupeKey && existing.Attempt >= job.Attempt {
			job.Attempt = existing.Attempt + 1
		}
	}
	if err := s.repo.SaveJob(context.Background(), job); err != nil {
		return domain.Job{}, err
	}
	s.publish("job.updated", job)
	s.runRetention(job)
	return s.repo.GetJob(context.Background(), job.ID)
}

func (s *Service) runRetention(job domain.Job) {
	ctx := context.Background()
	settings := s.settings.Get()
	job.State = "running"
	job.Progress = .05
	job.UpdatedAt = time.Now().UTC()
	_ = s.repo.SaveJob(ctx, job)
	s.publish("job.updated", job)

	plan, err := s.retentionSurvey(ctx)
	if err != nil {
		s.failOrWait(&job, err, retentionKind)
		s.finishRetentionJob(job, 0, 0)
		return
	}
	if settings.ReserveGB > 0 && plan.freeErr != nil {
		s.jobLog(job, "warn", retentionKind, "Free space unavailable on the download root; reserve check skipped", map[string]any{"error": plan.freeErr.Error()})
	}
	evicted, freedBytes := 0, int64(0)
	for {
		reason, _, tripped := retentionDeficit(plan, settings)
		if !tripped {
			break
		}
		victim, removed, err := s.evictOldest(ctx, plan, reason)
		if err != nil {
			s.failOrWait(&job, err, retentionKind)
			break
		}
		if !removed {
			s.jobLog(job, "warn", retentionKind, "Storage remains over the limit; every candidate is protected", map[string]any{"reason": reason, "storedBytes": plan.storedBytes, "freeBytes": plan.freeBytes})
			break
		}
		evicted++
		freedBytes += victim.status.TotalBytes
		job.UpdatedAt = time.Now().UTC()
		_ = s.repo.SaveJob(ctx, job)
		s.publish("job.updated", job)
		if plan, err = s.retentionSurvey(ctx); err != nil {
			s.failOrWait(&job, err, retentionKind)
			break
		}
	}
	s.finishRetentionJob(job, evicted, freedBytes)
}

func (s *Service) finishRetentionJob(job domain.Job, evicted int, freedBytes int64) {
	if job.State == "running" {
		if evicted > 0 {
			job.Label = fmt.Sprintf("%s · %d evicted · %.1f GiB freed", job.Label, evicted, float64(freedBytes)/(1<<30))
		} else {
			job.Label += " · within limits"
		}
		job.State = "completed"
		job.Retryable = false
		job.NextAttemptAt = nil
		job.Progress = 1
	}
	job.UpdatedAt = time.Now().UTC()
	_ = s.repo.SaveJob(context.Background(), job)
	s.publish("job.updated", job)
}

// evictionEvent names the evicted torrent for the journal and live feed. The
// names come from the cached release, the same enrichment the downloads list
// uses.
func (s *Service) evictionEvent(ctx context.Context, route retentionRoute, reason string) map[string]any {
	titles, releases := []string{}, []string{}
	seen := map[string]bool{}
	for _, row := range route.rows {
		if seen[row.ReleaseID] {
			continue
		}
		seen[row.ReleaseID] = true
		named := row
		if release, err := s.repo.GetRelease(ctx, row.ReleaseID); err == nil {
			s.enrichDownload(ctx, &named, release)
		}
		if named.DisplayTitle != "" {
			titles = append(titles, named.DisplayTitle)
		}
		if named.ReleaseName != "" {
			releases = append(releases, named.ReleaseName)
		}
	}
	return map[string]any{"reason": reason, "titles": titles, "releases": releases}
}
