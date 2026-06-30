# Scout

Multi-engine web search with local LLM inference. Queries 7 search engines in parallel, routes through a local 0.5B model for intent classification and grounded answer generation. MCP, HTTP, CLI, and Web UI modes.

## Features

- **7 search engines** — DDG, Google, Bing, Brave, Reddit, GitHub, Wikipedia
- **Local LLM** — Grammar-forced JSON routing prevents garbage output from small models
- **Fast-path scoring** — Intent-aware result merging with cross-engine dedup
- **Repetition guard** — Server-side abort on token loops
- **4 modes** — MCP server, HTTP API, CLI, Web UI

## Quick start

### 1. Install dependencies
```bash
npm install
```

### 2. Download a model

Pick one and place the `.gguf` file in `./models/`:

| Model | Size | RAM | Notes |
|-------|------|-----|-------|
| **Qwen2.5-0.5B-Instruct-Q4_K_M** | ~398 MB | 4GB+ | Recommended. Balances speed and quality. |
| **Qwen2.5-1.5B-Instruct-Q4_K_M** | ~900 MB | 8GB+ | Better summarization. Slower on low-end CPUs. |

```bash
# Example: download the 0.5B model from Hugging Face
# https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF
# Save as: ./models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf
```

### 3. Point config.json to your model

```json
{
  "modelPath": "./models/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf",
  "port": 3848,
  "maxTokens": 500,
  "temperature": 0.1
}
```

### 4. Run

```bash
# Web UI (loads model + starts server)
node index.js webui

# CLI search
node index.js "cheap mini pc daraz"

# MCP server (for Claude, Cline, etc.)
node index.js mcp

# HTTP API
node index.js serve
```

## Setup after pulling

```bash
git clone https://github.com/arifbutt/Scout.git
cd Scout
npm install

# Download model (0.5B recommended for first run)
# https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf
# Place it in ./models/

# Start
node index.js webui
```

## Usage

### CLI
```bash
scout "query"
scout "query" --limit 5
scout "query" --fields=title,url --verbose
scout extract <url>
```

### Web UI
Opens on `http://localhost:3848`. Session-based chat with streaming token output, source citations, and conversation history.

### MCP
Tools: `scout_search`, `scout_extract`, `scout_health`. Connect via stdio.

### HTTP API
- `POST /search` — `{ query, limit?, engines? }`
- `POST /extract` — `{ url }`
- `GET /health`

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `SCOUT_MCP_HEALTH_TOOL` | `true` | Expose health check MCP tool |
| `GOD_SEARCH_PORT` | `3847` | HTTP API port |
| `GOD_SEARCH_CACHE_TTL_MS` | `600000` | Cache TTL |
| `GOD_SEARCH_ENABLE_BRAVE` | `false` | Enable Brave search |
| `BRAVE_SEARCH_API_KEY` | `""` | Brave API key |

config.json controls model path, max tokens (500), and temperature (0.1).

## Architecture

```
User input
  │
  ├─ Pre-filter (greetings) ───→ Canned reply
  │
  └─ Phase 1: Grammar-forced LLM
       │  Output: {"intent":"search","query":"..."}
       │
       ├─ chat ───→ Canned reply
       │
       └─ search ─→ 7 search engines (parallel, fast-path)
                    │
                    ├─ No results ─→ Server fallback
                    │
                    └─ Phase 2: LLM summarization
                         (temperature 0.5, repeatPenalty 1.1)
                         Abort guard on token loops
```

## Requirements

- Node.js 20+
- 4GB+ RAM (8GB recommended)
- A GGUF model (~400MB for 0.5B, ~900MB for 1.5B)
- No GPU required

## License

MIT
