#!/usr/bin/env sh
TARBALL=elasticsearch-"$ES_VERSION"-darwin-x86_64.tar.gz
TARBALL_FULL_PATH="$(dirname "$0")"/"$TARBALL"
curl -o "$TARBALL_FULL_PATH" -z "$TARBALL_FULL_PATH" -L https://artifacts.elastic.co/downloads/elasticsearch/"$TARBALL"
cp "$TARBALL_FULL_PATH" "$TMPDIR" || exit 255
cd "$TMPDIR" || exit 255
tar -xzf ./"$TARBALL" || exit 255
cd ./elasticsearch-"$ES_VERSION"/bin || exit 255
./elasticsearch
