.PHONY: check test build build-arm64 frontend tizen-wgt validate-tizen-wgt deploy-pi bootstrap-server-dry-run

VERSION ?= $(shell tr -d '[:space:]' < VERSION)
PI_HOST ?= user@server.lan
TIZEN_VERSION ?= $(VERSION)
TIZEN_TARGET ?= 7.0
TIZEN_WGT := clients/tizen/.build/artifacts/FileListTV-$(TIZEN_VERSION).wgt
GO_CACHE ?= /tmp/filelist-streaming-go-cache
GO_LDFLAGS := -s -w -X github.com/mihaiflorentin88/filelist-streaming-service/internal/composition.Version=$(VERSION)

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
	sh deploy/pi-deploy.sh "$(PI_HOST)" "$(CURDIR)/bin/filelist-streaming-linux-arm64" "$(CURDIR)/deploy/systemd/filelist-streaming.service" "$(CURDIR)/deploy/systemd/filelist-streaming.logrotate"

bootstrap-server-dry-run:
	@echo "Review only; this target does not install packages."
	sudo sh deploy/bootstrap-server.sh --confirm-server-install --dry-run
