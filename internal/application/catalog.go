package application

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/mihaiflorentin88/filelist-streaming-service/internal/domain"
)

func (s *Service) CatalogTitles(ctx context.Context, q domain.CatalogQuery) (domain.Page[domain.CatalogTitle], error) {
	ids, err := s.repo.QueryCatalogTitleIDs(ctx, q)
	if err != nil {
		return domain.Page[domain.CatalogTitle]{}, err
	}
	sources, err := s.repo.ListCatalogSourcesByTitleIDs(ctx, ids.Items)
	if err != nil {
		return domain.Page[domain.CatalogTitle]{}, err
	}
	grouped := groupCatalog(sources, false)
	byID := make(map[string]domain.CatalogTitle, len(grouped))
	for i := range grouped {
		s.applyMetadataOnly(&grouped[i])
		byID[grouped[i].ID] = grouped[i]
	}
	items := make([]domain.CatalogTitle, 0, len(ids.Items))
	for _, id := range ids.Items {
		if title, ok := byID[id]; ok {
			items = append(items, title)
		}
	}
	return domain.Page[domain.CatalogTitle]{Items: items, NextCursor: ids.NextCursor, Total: ids.Total}, nil
}

func (s *Service) CatalogDetail(ctx context.Context, id string) (domain.CatalogDetail, error) {
	matched, err := s.repo.ListCatalogSourcesByTitleIDs(ctx, []string{id})
	if err != nil {
		return domain.CatalogDetail{}, err
	}
	if len(matched) == 0 {
		return domain.CatalogDetail{}, fmt.Errorf("catalog title not found")
	}
	title := groupCatalog(matched, true)[0]
	s.applyCachedMetadata(&title)
	detail := domain.CatalogDetail{Title: title, Seasons: []domain.CatalogSeason{}, Sources: []domain.CatalogSource{}}
	if title.Kind == domain.MediaMovie {
		detail.Sources = matched
		return detail, nil
	}
	type episodeKey struct{ season, episode int }
	episodes := map[episodeKey][]domain.CatalogSource{}
	seasonPacks := map[int][]domain.CatalogSource{}
	for _, source := range matched {
		p := source.Parsed
		if p.EpisodeStart > 0 {
			key := episodeKey{p.SeasonStart, p.EpisodeStart}
			episodes[key] = append(episodes[key], source)
			continue
		}
		if source.Release.FileCount > 1 {
			if manifest, manifestErr := s.repo.GetTorrentManifest(ctx, source.Release.ID); manifestErr == nil {
				expanded := false
				for _, file := range manifest.Files {
					if !file.Playable {
						continue
					}
					if virtual, ok := episodeSource(source, file); ok {
						key := episodeKey{virtual.Parsed.SeasonStart, virtual.Parsed.EpisodeStart}
						episodes[key] = append(episodes[key], virtual)
						expanded = true
					}
				}
				if expanded {
					continue
				}
			}
		}
		start, end := p.SeasonStart, p.SeasonEnd
		if start == 0 {
			start, end = 1, 1
		}
		for season := start; season <= max(start, end); season++ {
			seasonPacks[season] = append(seasonPacks[season], source)
		}
	}
	seasonNumbers := map[int]bool{}
	for key := range episodes {
		seasonNumbers[key.season] = true
	}
	for number := range seasonPacks {
		seasonNumbers[number] = true
	}
	numbers := make([]int, 0, len(seasonNumbers))
	for number := range seasonNumbers {
		numbers = append(numbers, number)
	}
	sort.Ints(numbers)
	for _, number := range numbers {
		season := domain.CatalogSeason{Number: number, Title: fmt.Sprintf("Season %d", number), Episodes: []domain.CatalogEpisode{}}
		keys := []episodeKey{}
		for key := range episodes {
			if key.season == number {
				keys = append(keys, key)
			}
		}
		sort.Slice(keys, func(i, j int) bool { return keys[i].episode < keys[j].episode })
		for _, key := range keys {
			items := episodes[key]
			name := items[0].Parsed.EpisodeTitle
			if name == "" {
				name = fmt.Sprintf("Episode %d", key.episode)
			}
			season.Episodes = append(season.Episodes, domain.CatalogEpisode{Number: key.episode, Season: number, Title: name, SourceCount: len(items), Sources: items})
		}
		season.EpisodeCount = len(season.Episodes)
		if len(seasonPacks[number]) > 0 && len(season.Episodes) == 0 {
			season.Episodes = append(season.Episodes, domain.CatalogEpisode{Season: number, Title: "Complete season", SourceCount: len(seasonPacks[number]), Sources: seasonPacks[number]})
		}
		detail.Seasons = append(detail.Seasons, season)
	}
	return detail, nil
}

func (s *Service) applyMetadataOnly(title *domain.CatalogTitle) {
	if metadata, err := s.repo.GetCatalogMetadata(context.Background(), title.ID); err == nil {
		applyMetadata(title, metadata)
	}
}

func (s *Service) applyCachedMetadata(title *domain.CatalogTitle) {
	metadata, err := s.repo.GetCatalogMetadata(context.Background(), title.ID)
	if err == nil {
		applyMetadata(title, metadata)
		if metadata.ExpiresAt.After(time.Now()) {
			return
		}
	} else if !errorsIsNoRows(err) {
		return
	}
	if s.metadata != nil && title.IMDbID != "" {
		s.EnsureMetadata(context.Background(), []string{title.ID})
	}
}

func applyMetadata(title *domain.CatalogTitle, metadata domain.CatalogMetadata) {
	if metadata.Title != "" {
		title.Title = metadata.Title
	}
	title.OriginalTitle, title.Overview = metadata.OriginalTitle, metadata.Overview
	title.Rating, title.RatingVotes, title.RatingProvider = metadata.Rating, metadata.RatingVotes, metadata.RatingProvider
	if metadata.PosterPath != "" {
		title.PosterURL = "/api/v1/artwork/" + title.ID + "/poster"
	}
	if metadata.BackdropPath != "" {
		title.BackdropURL = "/api/v1/artwork/" + title.ID + "/backdrop"
	}
}

func errorsIsNoRows(err error) bool { return err == sql.ErrNoRows }

func (s *Service) Artwork(ctx context.Context, titleID, kind string) (string, string, error) {
	if kind != "poster" && kind != "backdrop" {
		return "", "", fmt.Errorf("invalid artwork kind")
	}
	metadata, err := s.repo.GetCatalogMetadata(ctx, titleID)
	if err != nil {
		return "", "", err
	}
	remotePath := metadata.PosterPath
	if kind == "backdrop" {
		remotePath = metadata.BackdropPath
	}
	if remotePath == "" || s.metadata == nil {
		return "", "", fmt.Errorf("artwork is unavailable")
	}
	sum := sha256.Sum256([]byte(titleID + "\x00" + kind + "\x00" + remotePath))
	base := base64.RawURLEncoding.EncodeToString(sum[:18])
	root := s.settings.Get().ArtworkCachePath
	for _, ext := range []string{".jpg", ".png", ".webp"} {
		path := filepath.Join(root, base+ext)
		if _, statErr := os.Stat(path); statErr == nil {
			return path, mime.TypeByExtension(ext), nil
		}
	}
	body, contentType, err := s.metadata.OpenArtwork(ctx, remotePath, kind)
	if err != nil {
		return "", "", err
	}
	defer body.Close()
	ext := ".jpg"
	if strings.Contains(contentType, "png") {
		ext = ".png"
	} else if strings.Contains(contentType, "webp") {
		ext = ".webp"
	}
	if err := os.MkdirAll(root, 0o750); err != nil {
		return "", "", err
	}
	path := filepath.Join(root, base+ext)
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o640)
	if err != nil {
		return "", "", err
	}
	written, copyErr := io.Copy(f, io.LimitReader(body, (16<<20)+1))
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil || written > 16<<20 {
		_ = os.Remove(tmp)
		if copyErr != nil {
			return "", "", copyErr
		}
		if closeErr != nil {
			return "", "", closeErr
		}
		return "", "", fmt.Errorf("artwork exceeds 16 MiB")
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", "", err
	}
	return path, contentType, nil
}

func (s *Service) CatalogFacets(ctx context.Context) (domain.CatalogFacets, error) {
	return s.repo.CatalogFacets(ctx)
}

func filterCatalogSources(items []domain.CatalogSource, q domain.CatalogQuery) []domain.CatalogSource {
	search := strings.ToLower(strings.TrimSpace(q.Search))
	out := make([]domain.CatalogSource, 0, len(items))
	for _, x := range items {
		p, r := x.Parsed, x.Release
		if r.Seeders <= 0 {
			continue
		}
		if domain.DefaultBlacklistedCategory(r.Category) {
			continue
		}
		if search != "" && !strings.Contains(strings.ToLower(p.Title+" "+p.EpisodeTitle+" "+r.Name), search) {
			continue
		}
		if q.Category != "" && !strings.EqualFold(r.Category, q.Category) {
			continue
		}
		if q.Kind != "" && p.Kind != q.Kind {
			continue
		}
		if q.Resolution != "" && !strings.EqualFold(p.Resolution, q.Resolution) {
			continue
		}
		if q.HDR != "" && !strings.EqualFold(p.HDR, q.HDR) {
			continue
		}
		if q.Source != "" && !strings.EqualFold(p.Source, q.Source) {
			continue
		}
		if q.Codec != "" && !strings.EqualFold(p.VideoCodec, q.Codec) {
			continue
		}
		if r.Seeders < q.MinSeeders {
			continue
		}
		if q.Freeleech != nil && r.Freeleech != *q.Freeleech {
			continue
		}
		if q.Internal != nil && r.Internal != *q.Internal {
			continue
		}
		if q.Moderated != nil && r.Moderated != *q.Moderated {
			continue
		}
		out = append(out, x)
	}
	return out
}

func groupCatalog(items []domain.CatalogSource, includeSources bool) []domain.CatalogTitle {
	groups := map[string]*domain.CatalogTitle{}
	categories, resolutions := map[string]map[string]bool{}, map[string]map[string]bool{}
	seasons, episodes := map[string]map[int]bool{}, map[string]map[string]bool{}
	order := []string{}
	for _, x := range items {
		id := domain.CatalogTitleID(x.Release, x.Parsed)
		title := groups[id]
		if title == nil {
			title = &domain.CatalogTitle{ID: id, Title: x.Parsed.Title, Kind: x.Parsed.Kind, Year: x.Parsed.Year, IMDbID: x.Release.IMDbID, Categories: []string{}, Resolutions: []string{}, Sources: []domain.CatalogSource{}}
			groups[id] = title
			categories[id], resolutions[id], seasons[id], episodes[id] = map[string]bool{}, map[string]bool{}, map[int]bool{}, map[string]bool{}
			order = append(order, id)
		}
		title.SourceCount++
		if x.Release.SizeBytes > title.LargestSizeBytes {
			title.LargestSizeBytes = x.Release.SizeBytes
		}
		if x.Release.Seeders > title.BestSeeders {
			title.BestSeeders = x.Release.Seeders
		}
		if x.Release.UploadedAt != nil && (title.NewestUpload == nil || x.Release.UploadedAt.After(*title.NewestUpload)) {
			title.NewestUpload = x.Release.UploadedAt
		}
		categories[id][x.Release.Category] = true
		setNonEmpty(resolutions[id], x.Parsed.Resolution)
		if x.Parsed.SeasonStart > 0 {
			for n := x.Parsed.SeasonStart; n <= max(x.Parsed.SeasonStart, x.Parsed.SeasonEnd); n++ {
				seasons[id][n] = true
			}
		}
		if x.Parsed.EpisodeStart > 0 {
			episodes[id][fmt.Sprintf("%d:%d", x.Parsed.SeasonStart, x.Parsed.EpisodeStart)] = true
		}
		if includeSources {
			title.Sources = append(title.Sources, x)
		}
	}
	out := make([]domain.CatalogTitle, 0, len(order))
	for _, id := range order {
		title := groups[id]
		title.Categories, title.Resolutions = sortedKeys(categories[id]), sortedKeys(resolutions[id])
		title.SeasonCount, title.EpisodeCount = len(seasons[id]), len(episodes[id])
		out = append(out, *title)
	}
	return out
}

func sortCatalogTitles(items []domain.CatalogTitle, order string) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		switch order {
		case "oldest":
			if a.NewestUpload == nil {
				return true
			}
			if b.NewestUpload == nil {
				return false
			}
			return a.NewestUpload.Before(*b.NewestUpload)
		case "title", "title-asc":
			return strings.ToLower(a.Title) < strings.ToLower(b.Title)
		case "title-desc":
			return strings.ToLower(a.Title) > strings.ToLower(b.Title)
		case "seeders":
			return a.BestSeeders > b.BestSeeders
		case "size":
			return a.LargestSizeBytes > b.LargestSizeBytes
		default:
			if a.NewestUpload == nil {
				return false
			}
			if b.NewestUpload == nil {
				return true
			}
			return a.NewestUpload.After(*b.NewestUpload)
		}
	})
}

func setNonEmpty(set map[string]bool, value string) {
	if value != "" {
		set[value] = true
	}
}
func sortedKeys(set map[string]bool) []string {
	out := []string{}
	for key, ok := range set {
		if ok && key != "" {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}
