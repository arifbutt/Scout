import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AGENT_CONFIG, APP } from './config.js';
import { withCache } from './cache.js';
import { cacheStats } from './cache.js';
import { runSearch } from './merger.js';
import { extractPage } from './extractor.js';
import { browserStatus, closeBrowser } from './browser.js';
import { noteError, noteExtractComplete, noteExtractStart, noteHealthRequest, noteSearchComplete, noteSearchStart, runtimeSnapshot } from './runtime.js';

export function createMcpServer() {
  const server = new McpServer({ name: APP.name, version: APP.version });

  server.tool(
    'scout_search',
    {
      query: z.string().min(1).describe('Search query'),
      limit: z.number().int().min(1).max(20).optional().default(10).describe('Maximum results to return (1\u201320, default 10)'),
      engines: z.array(z.enum(['ddg', 'bing', 'brave', 'google', 'reddit', 'github', 'wikipedia'])).optional().describe('Specific engines to use (default: all 7)'),
      verbose: z.boolean().optional().default(false).describe('Include engine stats, timing, and score breakdown'),
    },
    async ({ query, limit, engines, verbose }) => {
      try {
        const startedAt = Date.now();
        noteSearchStart(query);
        const cacheOpts = { limit, engines };
        const result = await withCache(query, cacheOpts, () => runSearch(query, { limit, engines, _cacheOpts: cacheOpts }));
        noteSearchComplete({ elapsedMs: Date.now() - startedAt, engineErrors: result.engineStats?.errors || {} });

        const output = { query, results: result.results, total: result.results.length, partial: !!result.partial };
        if (verbose || result.fromCache) {
          if (result.fromCache) output.cached = true;
          if (verbose) { output.elapsed_ms = result.elapsed_ms; output.engines = result.engineStats; }
        }
        output.meta = { app: APP, cache: cacheStats() };

        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
      } catch (err) {
        noteError('mcp.scout_search', err);
        console.error('[scout_search] error:', err);
        return { content: [{ type: 'text', text: JSON.stringify({ query, results: [], error: err.message }, null, 2) }], isError: true };
      }
    }
  );

  server.tool(
    'scout_extract',
    { url: z.string().url().describe('URL to extract full content from') },
    async ({ url }) => {
      try {
        const startedAt = Date.now();
        noteExtractStart(url);
        const result = await extractPage(url);
        noteExtractComplete({ elapsedMs: Date.now() - startedAt });
        result.meta = { app: APP };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        noteError('mcp.scout_extract', err);
        console.error('[scout_extract] error:', err);
        return { content: [{ type: 'text', text: JSON.stringify({ url, error: err.message }, null, 2) }], isError: true };
      }
    }
  );

  if (AGENT_CONFIG.exposeHealthTool) {
    server.tool(
      'scout_health',
      {},
      async () => {
        try {
          noteHealthRequest();
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', ready: true, app: APP, browser: browserStatus(), cache: cacheStats(), runtime: runtimeSnapshot() }, null, 2) }] };
        } catch (err) {
          noteError('mcp.scout_health', err);
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: err.message }, null, 2) }], isError: true };
        }
      }
    );
  }

  return server;
}

export async function startMcp() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] scout MCP server running on stdio');

  process.on('SIGINT', async () => { await closeBrowser(); process.exit(0); });
  process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });
}
