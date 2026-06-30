import { createServer } from 'http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { HTTP_CONFIG } from './config.js';
import { withCache } from './cache.js';
import { cacheStats } from './cache.js';
import { runSearch } from './merger.js';
import { extractPage } from './extractor.js';
import { browserStatus } from './browser.js';
import { runtimeSnapshot } from './runtime.js';
import { createMcpServer } from './mcp.js';

const mcpTransports = new Map();

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

async function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve(null); }
    });
  });
}

export async function startHttp() {
  const mcpServer = createMcpServer();

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // MCP SSE — establish event stream
    if (url.pathname === '/sse' && req.method === 'GET') {
      const transport = new SSEServerTransport('/message', res);
      const sessionId = transport.sessionId;
      mcpTransports.set(sessionId, transport);
      res.on('close', () => {
        mcpTransports.delete(sessionId);
        console.error(`[sse] client ${sessionId} disconnected`);
      });
      await mcpServer.connect(transport);
      console.error(`[sse] client ${sessionId} connected`);
      return;
    }

    // MCP message — receive JSON-RPC from client
    if (url.pathname === '/message' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || !mcpTransports.has(sessionId)) {
        jsonResponse(res, 404, { error: 'No active SSE session for this sessionId' });
        return;
      }
      const transport = mcpTransports.get(sessionId);
      await transport.handlePostMessage(req, res);
      return;
    }

    // REST API routes
    if (url.pathname === '/health' && req.method === 'GET') {
      jsonResponse(res, 200, { status: 'ok', ready: true, browser: browserStatus(), cache: cacheStats(), runtime: runtimeSnapshot() });
      return;
    }

    if (url.pathname === '/openapi.json' && req.method === 'GET') {
      jsonResponse(res, 200, { openapi: '3.0.0', info: { title: 'scout', version: '1.0.0' }, paths: { '/search': { post: { summary: 'Search the web', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, engines: { type: 'array', items: { type: 'string' } } } } } } } } }, '/extract': { post: { summary: 'Extract page content', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' } } } } } } } }, '/health': { get: { summary: 'Health check' } } } });
      return;
    }

    if (url.pathname === '/search' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body || !body.query) { jsonResponse(res, 400, { error: 'query is required' }); return; }
      try {
        const { query, limit = 10, engines } = body;
        const cacheOpts = { limit, engines };
        const result = await withCache(query, cacheOpts, () => runSearch(query, { limit, engines, _cacheOpts: cacheOpts }));
        jsonResponse(res, 200, { query, results: result.results, total: result.results.length, partial: !!result.partial, meta: { cache: cacheStats() } });
      } catch (err) {
        jsonResponse(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/extract' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body || !body.url) { jsonResponse(res, 400, { error: 'url is required' }); return; }
      try {
        const result = await extractPage(body.url);
        jsonResponse(res, 200, result);
      } catch (err) {
        jsonResponse(res, 500, { error: err.message });
      }
      return;
    }

    jsonResponse(res, 404, { error: 'not found' });
  });

  server.listen(HTTP_CONFIG.port, HTTP_CONFIG.host, () => {
    console.error(`[http] scout listening on http://${HTTP_CONFIG.host}:${HTTP_CONFIG.port}`);
    console.error(`[http] MCP SSE: http://${HTTP_CONFIG.host}:${HTTP_CONFIG.port}/sse`);
    console.error(`[http] REST API: /health, /search, /extract`);
  });
}
