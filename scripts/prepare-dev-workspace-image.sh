#!/bin/sh
set -eu

repo_root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
image="${SOPHIA_DEV_WORKSPACE_IMAGE:-sophiaai/workspace:debian}"
cache_dir="${SOPHIA_DEV_WORKSPACE_CACHE_DIR:-$repo_root/.cache/sophia}"
archive="$cache_dir/workspace-debian.tar"

mkdir -p "$cache_dir"

echo "Building development workspace image: $image"
docker build \
  --progress=plain \
  --file "$repo_root/docker/Dockerfile.workspace" \
  --target workspace \
  --tag "$image" \
  "$repo_root"

archive_tmp="$(mktemp "$cache_dir/workspace-debian.tar.XXXXXX")"
cleanup() {
  rm -f "$archive_tmp"
}
trap cleanup EXIT INT TERM

echo "Exporting development workspace image: $archive"
docker save --output "$archive_tmp" "$image"
mv "$archive_tmp" "$archive"
trap - EXIT INT TERM
