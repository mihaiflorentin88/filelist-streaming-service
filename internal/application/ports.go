package application

import (
	"context"
	"io"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
)

type CatalogSource interface {
	Latest(context.Context) ([]domain.TorrentRelease, error)
	Category(context.Context, int) ([]domain.TorrentRelease, error)
	Search(context.Context, string) ([]domain.TorrentRelease, error)
	OpenTorrent(context.Context, string) (io.ReadCloser, error)
}

// Tracker is the provider-neutral catalog boundary. CatalogSource remains the
// minimum compatibility surface for existing adapters and tests; new trackers
// advertise their identity and capabilities through this interface.
type Tracker interface {
	CatalogSource
	ID() string
	Capabilities() TrackerCapabilities
}
type TrackerCapabilities struct {
	IMDbSearch    bool `json:"imdbSearch"`
	SeasonFilter  bool `json:"seasonFilter"`
	EpisodeFilter bool `json:"episodeFilter"`
	Categories    bool `json:"categories"`
}
type TorrentEngine interface {
	Test(context.Context) (string, error)
	Add(context.Context, io.Reader, string) (string, error)
	Files(context.Context, string) ([]domain.TorrentFile, error)
	Status(context.Context, string) (domain.DownloadStatus, error)
	Pieces(context.Context, string) (domain.PieceMap, error)
	PrepareFile(context.Context, string, int, []int) error
	Pause(context.Context, string) error
	Resume(context.Context, string) error
	Remove(context.Context, string, bool) error
}
type SubtitleQuery struct {
	Release          domain.TorrentRelease
	MediaPath        string
	Language         string
	FallbackLanguage string
}
type SubtitleDownload struct {
	Data   []byte
	Format string
	Name   string
}
type SubtitleProvider interface {
	Name() string
	Test(context.Context) (string, error)
	Search(context.Context, SubtitleQuery) ([]domain.SubtitleCandidate, error)
	Download(context.Context, string) (SubtitleDownload, error)
}
type MetadataProvider interface {
	Lookup(context.Context, string, domain.MediaKind, string, string) (domain.CatalogMetadata, error)
	OpenArtwork(context.Context, string, string) (io.ReadCloser, string, error)
}
type MediaProbe interface {
	ProbeSubtitles(context.Context, string) ([]domain.MediaSubtitleTrack, error)
	ExtractSubtitle(context.Context, string, int, string) error
}
type Repository interface {
	Close() error
	UpsertReleases(context.Context, []domain.TorrentRelease) error
	ListReleases(context.Context, string, string, int, int) (domain.Page[domain.TorrentRelease], error)
	ListCatalogSources(context.Context) ([]domain.CatalogSource, error)
	QueryCatalogTitleIDs(context.Context, domain.CatalogQuery) (domain.Page[string], error)
	ListCatalogSourcesByTitleIDs(context.Context, []string) ([]domain.CatalogSource, error)
	CatalogTitleIDsForReleases(context.Context, []string) (map[string]string, error)
	CatalogFacets(context.Context) (domain.CatalogFacets, error)
	SaveCatalogMetadata(context.Context, domain.CatalogMetadata) error
	GetCatalogMetadata(context.Context, string) (domain.CatalogMetadata, error)
	GetRelease(context.Context, string) (domain.TorrentRelease, error)
	SyncAge(context.Context, string) (int64, error)
	RecordSync(context.Context, string, int, error) error
	SaveDownload(context.Context, domain.Download) error
	DeleteDownload(context.Context, string) error
	GetDownload(context.Context, string) (domain.Download, error)
	ListDownloads(context.Context) ([]domain.Download, error)
	SetLease(context.Context, string, bool) error
	SaveJob(context.Context, domain.Job) error
	ListJobs(context.Context, int) ([]domain.Job, error)
	ListDueJobs(context.Context, time.Time, int) ([]domain.Job, error)
	QueryJobs(context.Context, string, string, string, string, int64, int, int) (domain.Page[domain.Job], error)
	GetJob(context.Context, string) (domain.Job, error)
	AppendJobLog(context.Context, domain.JobLog) (domain.JobLog, error)
	ListJobLogs(context.Context, string, int64, int) (domain.Page[domain.JobLog], error)
	PruneJobLogs(context.Context, time.Time, int) error
	SaveTorrentManifest(context.Context, domain.TorrentManifest) error
	GetTorrentManifest(context.Context, string) (domain.TorrentManifest, error)
	CatalogCounts(context.Context) (int, int, error)
	AppendEvent(context.Context, string, string) (domain.Event, error)
	ListEvents(context.Context, int64, int) ([]domain.Event, error)
	SavePlayback(context.Context, domain.PlaybackState) error
	GetPlayback(context.Context, string, string) (domain.PlaybackState, error)
	ListPlayback(context.Context, string) ([]domain.PlaybackState, error)
	SetFavorite(context.Context, string, string, bool) error
	ListFavorites(context.Context, string) ([]domain.Favorite, error)
	SaveSubtitleAsset(context.Context, domain.SubtitleAsset) error
	GetSubtitleAsset(context.Context, string, string, string, string) (domain.SubtitleAsset, error)
}
