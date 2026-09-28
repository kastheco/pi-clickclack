#!/bin/sh
# refuse to start a bot when the disk behind its private tree lacks headroom.
# heavy setup and indexing (lcm, context-mode, go and pnpm caches) all land there.
set -eu

bot=${1:-clickclack}
dir="$HOME/.local/share/omp-clickclack/$bot"
min_free_gib=${OMP_CLICKCLACK_MIN_FREE_GIB:-50}
max_metadata_pct=${OMP_CLICKCLACK_MAX_METADATA_PCT:-95}

[ -d "$dir" ] || { echo "preflight: missing bot tree $dir" >&2; exit 1; }

free_gib=$(( $(stat -f -c '%a * %S' "$dir") / 1073741824 ))
if [ "$free_gib" -lt "$min_free_gib" ]; then
  echo "preflight: $free_gib GiB free under $dir, need $min_free_gib GiB" >&2
  exit 1
fi

if [ "$(stat -f -c %T "$dir")" = btrfs ]; then
  uuid=$(findmnt -no UUID -T "$dir")
  meta=/sys/fs/btrfs/$uuid/allocation/metadata
  used=$(cat "$meta/bytes_used")
  total=$(cat "$meta/total_bytes")
  pct=$(( used * 100 / total ))
  if [ "$pct" -gt "$max_metadata_pct" ]; then
    echo "preflight: btrfs metadata ${pct}% used, limit ${max_metadata_pct}%" >&2
    exit 1
  fi
fi

echo "preflight: $bot ok, ${free_gib} GiB free"
