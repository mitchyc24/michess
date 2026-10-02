#!/usr/bin/env bash
# Download the official Stockfish Linux build into engine/ and link it as engine/stockfish-bin.
set -euo pipefail
cd "$(dirname "$0")"
TAG=${1:-$(curl -s https://api.github.com/repos/official-stockfish/Stockfish/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)}
curl -sL -o sf.tar.gz "https://github.com/official-stockfish/Stockfish/releases/download/${TAG}/stockfish-linux-x86-64-universal.tar.gz"
tar xzf sf.tar.gz && rm sf.tar.gz
ln -sf stockfish/stockfish-linux-x86-64-universal stockfish-bin
echo "Installed Stockfish ${TAG}"
