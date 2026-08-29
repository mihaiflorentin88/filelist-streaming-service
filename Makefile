.PHONY: check test build build-arm64 frontend tizen-wgt validate-tizen-wgt deploy-pi bootstrap-server-dry-run docker-configure docker-validate docker-import-pi docker-prepare docker-up docker-down docker-logs docker-check docker-urls docker-smoke-stream

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
