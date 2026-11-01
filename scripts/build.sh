#!/usr/bin/env bash
# Builds everything from clean, in the one order that gives the code hashes on chain: the token first,
# because the launcher embeds it. Anyone with the Rust version in rust-toolchain.toml gets the same
# bytes, whatever their home directory: paths are remapped, and nothing old is reused.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR="$PWD"
CARGO_DIR="${CARGO_HOME:-$HOME/.cargo}"
SYSROOT="$(rustc --print sysroot)"
SEP=$'\x1f'
REMAP="--remap-path-prefix=$CARGO_DIR=/cargo$SEP--remap-path-prefix=$SYSROOT=/rustc$SEP--remap-path-prefix=$ROOT_DIR=/src"
rm -rf target judge/target
NEAR_FLAGS="--cfg${SEP}near$SEP-Clink-arg=-s$SEP-Ctarget-cpu=mvp$SEP$REMAP"
JOBS="-j${BUILD_JOBS:-3}"
CARGO_ENCODED_RUSTFLAGS="$NEAR_FLAGS" cargo build $JOBS --locked -p token --target wasm32-unknown-unknown --release
cmp -s target/wasm32-unknown-unknown/release/token.wasm contracts/launcher/token.wasm || cp target/wasm32-unknown-unknown/release/token.wasm contracts/launcher/token.wasm
CARGO_ENCODED_RUSTFLAGS="$NEAR_FLAGS" cargo build $JOBS --locked --target wasm32-unknown-unknown --release
CARGO_ENCODED_RUSTFLAGS="$REMAP" cargo build $JOBS --locked --manifest-path judge/Cargo.toml --target wasm32-wasip2 --release
sha256sum target/wasm32-unknown-unknown/release/{plan,market,launcher,token}.wasm judge/target/wasm32-wasip2/release/judge.wasm | sed 's|  .*/| |'
