# Scout — AGENTS.md

## Entrypoints

- `index.js` — routes 4 modes from argv: `mcp`, `serve`, `webui`, or bare query (CLI search)
- `webui` mode loads LLM first (`loadModel()`), then starts Express on port 3848
- `mcp` mode runs stdio MCP server (no model loaded)
- `serve` mode runs HTTP API on port 3847

## Architecture

Two-phase LLM pipeline (only in `webui` mode):

1. **Phase 1** — `web/server.js` sends user input to grammar-forced LLM via `ROUTER_SCHEMA` (`{ intent: "search"|"chat", query: string }`). Grammar is created once via `llama.createGrammarForJsonSchema()` and cached.
2. **Phase 2** — If intent is search, feeds scraped results + strict prompt back to LLM for grounded answer. If no results, server returns fallback string directly (no model call).

Three defense layers against LLM failure:
- Greeting pre-filter (`GREETING_RE`) catches short messages before model
- Empty-result interceptor skips Phase 2
- Line-level repetition guard (`repAborter`) aborts generation if last 4 non-empty lines have ≤2 unique values

## Key files

| File | Role |
|------|------|
| `src/inference.js` | Model loading, grammar creation, `generate()` |
| `src/merger.js` | Multi-engine search with intent-based fast-path scoring |
| `web/server.js` | Web UI: session management, two-phase chat pipeline |
| `src/config.js` | All env var config (still uses `GOD_SEARCH_*` prefix) |
| `src/mcp.js` | MCP tool definitions (`scout_search`, `scout_extract`, `scout_health`) |

## Commands

```bash
node index.js webui                 # Start Web UI (loads model + Express on :3848)
node index.js mcp                   # MCP stdio server
node index.js serve                 # HTTP API on :3847
node index.js extract <url>         # Extract page text
node index.js "query"               # CLI search (JSON output)
node test/verify-engines.js         # Only test script
```

## Config

`config.json` controls model path, tokens, temperature. Env vars in `src/config.js` use `GOD_SEARCH_*` prefix:
- `GOD_SEARCH_ENABLE_BRAVE=true` — enables Brave engine (opt-in)
- `GOD_SEARCH_PORT`, `GOD_SEARCH_HOST` — HTTP API
- `GOD_SEARCH_CACHE_TTL_MS`, `GOD_SEARCH_MAX_NAV`, etc.

## Model

- Requires a `.gguf` file in `./models/`. Set path in `config.json`.
- Tested with Qwen2.5-0.5B-Instruct-Q4_K_M (~398MB) and Qwen2.5-1.5B-Instruct-Q4_K_M (~900MB).
- `contextSize: 4096` in `inference.js:41`. `maxTokens: 500` in config.
- Phase 1 temperature: 0.1 (grammar-forced, temperature is irrelevant). Phase 2: 0.5.
- Repeat penalty: `{ penalty: 1.1, frequencyPenalty: 0.15 }`.

## Conventions

- ES modules (`"type": "module"` in package.json). `import`/`export`, no `require`.
- No TypeScript, no linter, no formatter config.
- Sessions stored as JSONL in `./sessions/`. One dir per session with `meta.json` + `history.jsonl`.
- `generate(prompt, systemPrompt, options)` — third arg is object `{ onToken, grammar, temperature, repeatPenalty }`.
- MCP tool names: `scout_search`, `scout_extract`, `scout_health`.
- `slms.md` at root contains experimental model notes (ignore).
