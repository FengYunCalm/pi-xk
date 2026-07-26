#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_INSTALL=false
SKIP_DEPS=false
SKIP_BUILD=false
PLATFORM=""
OUTPUT_DIR=".artifacts/pi-xk-release"
RELEASE_TAG=""
SOURCE_SHA=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		--skip-install)
			SKIP_INSTALL=true
			shift
			;;
		--skip-deps)
			SKIP_DEPS=true
			shift
			;;
		--skip-build)
			SKIP_BUILD=true
			shift
			;;
		--platform)
			PLATFORM="$2"
			shift 2
			;;
		--out)
			OUTPUT_DIR="$2"
			shift 2
			;;
		--tag)
			RELEASE_TAG="$2"
			shift 2
			;;
		--source-sha)
			SOURCE_SHA="$2"
			shift 2
			;;
		--help|-h)
			printf '%s\n' "Usage: ./scripts/build-pi-xk-binaries.sh [--skip-install] [--skip-deps] [--skip-build] [--platform <name>] [--out <dir>] [--tag <pi-xk-vX.Y.Z>] [--source-sha <sha>]"
			exit 0
			;;
		*)
			echo "Unknown option: $1" >&2
			exit 1
			;;
	esac
done

RELEASE_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('pi-xk-release.json', 'utf8')).version")"
PI_VERSION="$(node -p "require('./packages/coding-agent/package.json').version")"
if [[ -z "$RELEASE_TAG" ]]; then
	RELEASE_TAG="pi-xk-v${RELEASE_VERSION}"
fi
if [[ -z "$SOURCE_SHA" ]]; then
	SOURCE_SHA="$(git rev-parse HEAD)"
fi
if [[ "$RELEASE_TAG" != "pi-xk-v${RELEASE_VERSION}" ]]; then
	echo "Release tag $RELEASE_TAG does not match Pi-XK release version $RELEASE_VERSION" >&2
	exit 1
fi
if [[ ! "$SOURCE_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
	echo "Source SHA must be a full 40-character Git commit SHA" >&2
	exit 1
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
	OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi
OUTPUT_DIR="$(node -p "require('path').resolve(process.argv[1])" "$OUTPUT_DIR")"
if [[ "$OUTPUT_DIR" == "/" || "$OUTPUT_DIR" == "$(pwd)" || "$OUTPUT_DIR" == "${HOME:-}" ]]; then
	echo "Refusing unsafe Pi-XK release output directory: $OUTPUT_DIR" >&2
	exit 1
fi

BASE_ARGS=(--out "$OUTPUT_DIR")
if [[ "$SKIP_INSTALL" == "true" ]]; then BASE_ARGS+=(--skip-install); fi
if [[ "$SKIP_DEPS" == "true" ]]; then BASE_ARGS+=(--skip-deps); fi
if [[ "$SKIP_BUILD" == "true" ]]; then BASE_ARGS+=(--skip-build); fi
if [[ -n "$PLATFORM" ]]; then BASE_ARGS+=(--platform "$PLATFORM"); fi

./scripts/build-binaries.sh "${BASE_ARGS[@]}"

if [[ -n "$PLATFORM" ]]; then
	PLATFORMS=("$PLATFORM")
else
	PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
	echo "Building Pi-XK entrypoint for $platform..."
	if [[ "$platform" == windows-* ]]; then
		PI_XK_EXECUTABLE="$OUTPUT_DIR/$platform/pi-xk.exe"
	else
		PI_XK_EXECUTABLE="$OUTPUT_DIR/$platform/pi-xk"
	fi
	(
		cd packages/coding-agent
		bun build --compile --target="bun-$platform" ./dist/bun/pi-xk-cli.js ./src/utils/image-resize-worker.ts --outfile "$PI_XK_EXECUTABLE"
	)
done

PACKAGE_ARGS=(
	--input "$OUTPUT_DIR"
	--release-config "pi-xk-release.json"
	--extension-root "packages/pi-xk-extension"
	--docs-root "docs/pi-xk"
	--tag "$RELEASE_TAG"
	--source-sha "$SOURCE_SHA"
	--pi-version "$PI_VERSION"
)
for platform in "${PLATFORMS[@]}"; do PACKAGE_ARGS+=(--platform "$platform"); done
node scripts/package-pi-xk-release.mjs "${PACKAGE_ARGS[@]}"

echo "Pi-XK release artifacts created in $OUTPUT_DIR"
