#!/usr/bin/env bash
# Builds everything in the one order that gives the code hashes on chain: the token first, because
# the launcher embeds it. Needs the Rust version in rust-toolchain.toml, exactly.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build -j3 -p token --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/token.wasm contracts/launcher/token.wasm
cargo build -j3 --target wasm32-unknown-unknown --release
cargo build -j3 --manifest-path judge/Cargo.toml --target wasm32-wasip2 --release
sha256sum target/wasm32-unknown-unknown/release/{plan,market,launcher,token}.wasm judge/target/wasm32-wasip2/release/judge.wasm | sed 's|  .*/| |'
