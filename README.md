# Hill Lab

A static, browser-based King of the Hill chess analyzer. PGN parsing and board
state use chess.js; analysis uses Fairy-Stockfish compiled to threaded WebAssembly.
Saved games remain in the browser's `localStorage` and are not sent to a server.

## Run locally

Threaded WebAssembly requires cross-origin isolation headers, so opening
`index.html` directly will show the board but cannot start the engine.

```bash
node dev-server.mjs
```

Then open `http://localhost:4173`.

## Production headers

The host must send these response headers on every app and engine file:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

See `chess.connermccarthy.com.nginx` for the intended nginx server block.

## Vendored software

- Fairy-Stockfish WASM 1.1.12, GPL-3.0
- chess.js 1.4.0, BSD-2-Clause
- Lichess cburnett pieces, GPLv2+

The matching licenses are included beside each vendored dependency. Exact source
and package checksums are recorded in `THIRD_PARTY.md`.
