.PHONY: check test build build-arm64 build-all frontend tizen-wgt validate-tizen-wgt smoke-tizen-engine deploy-pi bootstrap-server-dry-run docker-configure docker-validate docker-import-pi docker-prepare docker-up docker-down docker-logs docker-check docker-urls docker-smoke-stream

VERSION ?= $(shell tr -d '[:space:]' < VERSION)
PI_HOST ?=
TIZEN_VERSION ?= $(VERSION)
TIZEN_TARGET ?= 7.0
TIZEN_WGT := clients/tizen/.build/artifacts/FileListTV-$(TIZEN_VERSION).wgt
GO_CACHE ?= /tmp/filelist-streaming-go-cache
GO_LDFLAGS := -s -w -X github.com/mihaiflorentin88/filelist-streaming-service/internal/composition.Version=$(VERSION)
DOCKER_ENV ?= .env.docker

check:
	GOCACHE="$(GO_CACHE)" go test ./...
	python3 -m unittest discover -s tools/tests -p 'test_*.py'
	GOCACHE="$(GO_CACHE)" go vet ./...
	git diff --check

test:
	GOCACHE="$(GO_CACHE)" go test -race ./...
	python3 -m unittest discover -s tools/tests -p 'test_*.py'

build:
	GOCACHE="$(GO_CACHE)" CGO_ENABLED=0 go build -trimpath -ldflags="$(GO_LDFLAGS)" -o bin/filelist-streaming ./cmd/server

build-arm64:
	GOCACHE="$(GO_CACHE)" CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="$(GO_LDFLAGS)" -o bin/filelist-streaming-linux-arm64 ./cmd/server

# Six-platform release binaries (windows/linux/darwin x amd64/arm64). The
# binary is cgo-free everywhere; the free-space probe carries per-OS builds.
build-all:
	GOCACHE="$(GO_CACHE)" CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -trimpath -ldflags="$(GO_LDFLAGS)" -o bin/filelist-streaming-linux-amd64 ./cmd/server
	GOCACHE="$(GO_CACHE)" CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -trimpath -ldflags="$(GO_LDFLAGS)" -o bin/filelist-streaming-linux-arm64 ./cmd/server
	GOCACHE="$(GO_CACHE)" CGO_ENABLED=0 GOOS=darwin  GOARCH=amd64 go build -trimpath -ldflags="$(GO_LDFLAGS)" -o bin/filelist-streaming-darwin-amd64 ./cmd/server
	GOCACHE="$(GO_CACHE)" CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags="$(GO_LDFLAGS)" -o bin/filelist-streaming-darwin-arm64 ./cmd/server
	GOCACHE="$(GO_CACHE)" CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="$(GO_LDFLAGS)" -o bin/filelist-streaming-windows-amd64.exe ./cmd/server
	GOCACHE="$(GO_CACHE)" CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -trimpath -ldflags="$(GO_LDFLAGS)" -o bin/filelist-streaming-windows-arm64.exe ./cmd/server

frontend:
	docker build -f deploy/docker/Dockerfile.frontend -t filelist-frontend-build .
	docker run --rm --user "$(shell id -u):$(shell id -g)" -v "$(CURDIR):/src" -v /src/node_modules -v /src/clients/tizen/node_modules filelist-frontend-build
	$(MAKE) tizen-wgt

tizen-wgt:
	python3 tools/tizen_wgt.py pack \
		--source clients/tizen/dist \
		--config clients/tizen/config.xml \
		--icon clients/tizen/icon.png \
		--output "$(TIZEN_WGT)" \
		--target-tizen "$(TIZEN_TARGET)"

validate-tizen-wgt:
	python3 tools/tizen_wgt.py validate \
		--file "$(TIZEN_WGT)" \
		--target-tizen "$(TIZEN_TARGET)"

# Headless old-engine boot smoke (ticket #84, parent #79): boots the real
# clients/tizen/dist in the pinned oldest reliably obtainable old Chromium,
# selenoid/chrome:63.0 = Google Chrome 63.0.3239.84 — the Tizen 5.0-era engine
# floor ("Tizen 5.0-era Chromium 63", clients/tizen/vite.config.ts). Selenoid
# (Aerokube) still publishes the tag on Docker Hub. The pin is the guarantee's
# ceiling: nothing older than Chrome 63 is covered. Requires Docker and
# Node >= 22 (CI provides Node 24); uses --network host, so no ports are
# published. The third case intentionally runs a broken-bundle fixture and
# must exit 3; any other outcome fails the target.
smoke-tizen-engine:
	@echo "smoke-tizen-engine: pinned engine selenoid/chrome:63.0 (Google Chrome 63.0.3239.84) — oldest reliably obtainable Chromium at the Tizen 5.0 floor; ceiling of this guarantee"
	node tools/smoke_tizen_engine/smoke.mjs --cases clean,fatal
	@status=0; node tools/smoke_tizen_engine/smoke.mjs --cases broken || status=$$?; \
	if [ "$$status" -eq 3 ]; then \
		echo "smoke-tizen-engine: broken-bundle fixture correctly rejected (case 3, exit 3)"; \
	else \
		echo "smoke-tizen-engine: FAIL — the broken-bundle case must exit 3 (harness detection proven); got $$status" >&2; \
		exit 1; \
	fi
	@echo "smoke-tizen-engine: PASS — clean boot and injected-error panel verified on Google Chrome 63.0.3239.84; broken fixture rejected."

deploy-pi: build-arm64
	PI_HOST="$(PI_HOST)" sh deploy/pi-deploy.sh "$(CURDIR)/bin/filelist-streaming-linux-arm64" "$(CURDIR)/deploy/systemd/filelist-streaming.service" "$(CURDIR)/deploy/systemd/filelist-streaming.logrotate"

bootstrap-server-dry-run:
	@echo "Review only; this target does not install packages."
	sudo sh deploy/bootstrap-server.sh --confirm-server-install --dry-run

docker-configure:
	sh deploy/docker/configure.sh "$(DOCKER_ENV)"

docker-import-pi:
	sh deploy/docker/import-pi-config.sh "$(PI_HOST)"

docker-validate:
	python3 tools/docker_env_validate.py "$(DOCKER_ENV)"

docker-prepare:
	sh deploy/docker/prepare.sh "$(DOCKER_ENV)"

docker-up: docker-prepare
	docker compose --env-file "$(DOCKER_ENV)" up -d --build --wait
	sh deploy/docker/verify.sh "$(DOCKER_ENV)"
	sh deploy/docker/access-urls.sh "$(DOCKER_ENV)"

docker-down:
	docker compose --env-file "$(DOCKER_ENV)" down

docker-logs:
	docker compose --env-file "$(DOCKER_ENV)" logs --tail=200 -f

docker-check:
	sh deploy/docker/verify.sh "$(DOCKER_ENV)"

docker-urls:
	sh deploy/docker/access-urls.sh "$(DOCKER_ENV)"

docker-smoke-stream:
	@test -n "$(RELEASE_ID)" || { echo "Usage: make docker-smoke-stream RELEASE_ID=<disposable FileList release id>" >&2; exit 2; }
	docker compose --env-file "$(DOCKER_ENV)" exec -T server python3 /usr/local/bin/progressive_stream_smoke.py --release-id "$(RELEASE_ID)" --base-url http://127.0.0.1:8097 --ffprobe
