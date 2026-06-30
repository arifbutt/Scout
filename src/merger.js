import { scoreResult, crossEngineBoost, registrableDomain } from './scoring.js';
import { updateCache } from './cache.js';
import { searchDdg } from './engines/ddg.js';
import { searchBing } from './engines/bing.js';
import { searchBrave } from './engines/brave.js';
import { searchGoogle } from './engines/google.js';
import { searchReddit } from './engines/reddit.js';
import { searchGithub } from './engines/github.js';
import { searchWikipedia } from './engines/wikipedia.js';
import { SEARCH_CONFIG } from './config.js';

const DOMAIN_MAX = 2;

const ALL_ENGINES = {
  ddg: { name: 'ddg', fn: searchDdg, kind: 'browser' },
  brave: { name: 'brave', fn: searchBrave, kind: 'browser' },
  bing: { name: 'bing', fn: searchBing, kind: 'browser' },
  reddit: { name: 'reddit', fn: searchReddit, kind: 'api' },
  wikipedia: { name: 'wikipedia', fn: searchWikipedia, kind: 'api' },
  github: { name: 'github', fn: searchGithub, kind: 'api' },
  google: { name: 'google', fn: searchGoogle, kind: 'browser' },
};

const ENGINE_ORDERS = {
  docs: ['ddg', 'google', 'bing', 'brave', 'github', 'wikipedia', 'reddit'],
  code: ['github', 'ddg', 'google', 'brave', 'bing', 'reddit', 'wikipedia'],
  discussion: ['reddit', 'ddg', 'google', 'bing', 'brave', 'github', 'wikipedia'],
  factual: ['wikipedia', 'ddg', 'google', 'bing', 'brave', 'github', 'reddit'],
  general: ['ddg', 'google', 'bing', 'brave', 'reddit', 'wikipedia', 'github'],
};

const INTENT_PROFILES = {
  docs: { minSettled: 3, minUseful: 1, usefulEngines: new Set(['ddg', 'google', 'bing']), softMs: Math.max(SEARCH_CONFIG.fastPathMs, 2200), hardMs: Math.max(SEARCH_CONFIG.fastPathMaxMs, 4500), requireHighConfidence: true },
  code: { minSettled: 3, minUseful: 1, usefulEngines: new Set(['github', 'ddg', 'google', 'bing', 'brave']), softMs: Math.max(SEARCH_CONFIG.fastPathMs, 2200), hardMs: Math.max(SEARCH_CONFIG.fastPathMaxMs, 4000), requireHighConfidence: true },
  discussion: { minSettled: 2, minUseful: 1, usefulEngines: new Set(['reddit', 'ddg', 'google', 'bing']), softMs: Math.max(SEARCH_CONFIG.fastPathMs, 1800), hardMs: Math.max(SEARCH_CONFIG.fastPathMs, 3200), requireHighConfidence: false },
  factual: { minSettled: 2, minUseful: 1, usefulEngines: new Set(['wikipedia', 'ddg', 'google', 'bing']), softMs: Math.max(SEARCH_CONFIG.fastPathMs, 1800), hardMs: Math.max(SEARCH_CONFIG.fastPathMs, 3200), requireHighConfidence: false },
  general: { minSettled: SEARCH_CONFIG.fastPathMinEngines, minUseful: 2, usefulEngines: new Set(Object.keys(ALL_ENGINES)), softMs: SEARCH_CONFIG.fastPathMs, hardMs: Math.max(SEARCH_CONFIG.fastPathMs, 3000), requireHighConfidence: false },
};

function allEnginesList() {
  return Object.values(ALL_ENGINES).filter(engine => {
    if (engine.name === 'brave' && !SEARCH_CONFIG.enableBraveByDefault) return false;
    return true;
  });
}

function detectQueryIntent(query) {
  const lower = query.toLowerCase();
  if (/\b(reddit|discussion|forum|thread|threads|opinion|opinions|community|communities|compare|vs\.?|versus)\b/.test(lower)) return 'discussion';
  if (/\b(github|gitlab|repo|repository|repositories|source code|implementation|implementations|example code|examples)\b/.test(lower)) return 'code';
  if (/\b(docs?|documentation|documentations|api|sdk|reference|references|guide|guides|handbook|manual|tutorial|tutorials|library|libraries|integration|integrations)\b/.test(lower)) return 'docs';
  if (/^(what is|who is|define|definition of|history of|list of)\b/.test(lower) || /\b(wikipedia|meaning|definition|history)\b/.test(lower)) return 'factual';
  return 'general';
}

function orderEnginesForIntent(engines, intent) {
  const order = ENGINE_ORDERS[intent] || ENGINE_ORDERS.general;
  const rank = new Map(order.map((name, index) => [name, index]));
  return [...engines].sort((a, b) => (rank.get(a.name) ?? 99) - (rank.get(b.name) ?? 99));
}

function resultSignal(result) {
  try {
    const url = new URL(result.url);
    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    return { hostname, domain: registrableDomain(result.url), path: url.pathname || '/', score: result.score ?? 0 };
  } catch { return { hostname: '', domain: '', path: '/', score: result.score ?? 0 }; }
}

const DOC_HOST_RE = /^(docs|developer|developers|api)\./i;
const DOC_PATH_RE = /^\/(docs|documentation|api|reference|guide|guides|manual|tutorial|tutorials|library|integrations?|providers?)(\/|$)/i;
const DOC_REGISTRY_HOSTS = new Set(['docs.rs', 'pkg.go.dev', 'pypi.org', 'npmjs.com', 'crates.io']);
const KNOWN_OFFICIAL_DOMAINS = new Set(['anthropic.com', 'openai.com', 'ollama.com', 'langchain.com', 'nodejs.org', 'rust-lang.org', 'python.org', 'mozilla.org', 'go.dev', 'npmjs.com', 'pypi.org', 'crates.io']);
const CODE_HOSTS = new Set(['github.com', 'gitlab.com']);
const DISCUSSION_HOSTS = new Set(['reddit.com']);
const FACTUAL_HOSTS = new Set(['wikipedia.org']);

function isOfficialish(signal) {
  return DOC_HOST_RE.test(signal.hostname) || DOC_PATH_RE.test(signal.path) || DOC_REGISTRY_HOSTS.has(signal.hostname) || DOC_REGISTRY_HOSTS.has(signal.domain) || KNOWN_OFFICIAL_DOMAINS.has(signal.hostname) || KNOWN_OFFICIAL_DOMAINS.has(signal.domain);
}

function isHighConfidenceResult(result, intent) {
  const signal = resultSignal(result);
  const officialish = isOfficialish(signal);
  if (intent === 'docs') { if (DISCUSSION_HOSTS.has(signal.domain) || FACTUAL_HOSTS.has(signal.domain)) return false; if (CODE_HOSTS.has(signal.domain)) return false; return officialish; }
  if (intent === 'code') return CODE_HOSTS.has(signal.domain) || officialish || signal.score >= 18;
  if (intent === 'discussion') return DISCUSSION_HOSTS.has(signal.domain) || signal.score >= 14;
  if (intent === 'factual') return FACTUAL_HOSTS.has(signal.domain) || officialish || signal.score >= 14;
  return signal.score >= 18 || (result.engines?.length ?? 0) > 1;
}

function intentScoreAdjustment(result, intent) {
  const signal = resultSignal(result);
  const officialish = isOfficialish(signal);
  if (intent === 'docs') {
    let d = 0;
    if (officialish) d += 8;
    if (KNOWN_OFFICIAL_DOMAINS.has(signal.hostname) || KNOWN_OFFICIAL_DOMAINS.has(signal.domain)) d += 6;
    if (CODE_HOSTS.has(signal.domain)) d -= 8;
    if (DISCUSSION_HOSTS.has(signal.domain)) d -= 10;
    if (FACTUAL_HOSTS.has(signal.domain)) d -= 4;
    return d;
  }
  if (intent === 'code') {
    let d = 0;
    if (CODE_HOSTS.has(signal.domain)) d += 10;
    if (officialish) d += 3;
    if (KNOWN_OFFICIAL_DOMAINS.has(signal.hostname) || KNOWN_OFFICIAL_DOMAINS.has(signal.domain)) d += 2;
    if (DISCUSSION_HOSTS.has(signal.domain)) d -= 6;
    return d;
  }
  if (intent === 'discussion') {
    let d = 0;
    if (DISCUSSION_HOSTS.has(signal.domain)) d += 10;
    if (CODE_HOSTS.has(signal.domain)) d -= 4;
    if (FACTUAL_HOSTS.has(signal.domain)) d -= 2;
    return d;
  }
  if (intent === 'factual') {
    let d = 0;
    if (FACTUAL_HOSTS.has(signal.domain)) d += 10;
    if (officialish) d += 3;
    if (KNOWN_OFFICIAL_DOMAINS.has(signal.hostname) || KNOWN_OFFICIAL_DOMAINS.has(signal.domain)) d += 2;
    if (DISCUSSION_HOSTS.has(signal.domain)) d -= 4;
    if (CODE_HOSTS.has(signal.domain)) d -= 4;
    return d;
  }
  return 0;
}

function usefulCompletedCount(engineMap, intent) {
  const profile = INTENT_PROFILES[intent] || INTENT_PROFILES.general;
  let count = 0;
  for (const [engine, results] of engineMap) {
    if (!profile.usefulEngines.has(engine)) continue;
    if (Array.isArray(results) && results.length > 0) count++;
  }
  return count;
}

function hasHighConfidence(engineMap, intent) {
  for (const results of engineMap.values()) {
    for (const result of results.slice(0, 3)) {
      if (isHighConfidenceResult(result, intent)) return true;
    }
  }
  return false;
}

function shouldResolveFastPath({ intent, engineMap, engineErrors, attempted, elapsedMs }) {
  const profile = INTENT_PROFILES[intent] || INTENT_PROFILES.general;
  const settled = engineMap.size + engineErrors.size;
  const useful = usefulCompletedCount(engineMap, intent);
  const confident = hasHighConfidence(engineMap, intent);
  if (settled >= attempted.length) return true;
  if (elapsedMs >= profile.hardMs) return true;
  if (settled < profile.minSettled) return false;
  if (useful < profile.minUseful) return false;
  if (profile.requireHighConfidence && !confident) return false;
  return elapsedMs >= profile.softMs || confident;
}

function buildEngineStats(engineMap, engineErrors, attempted) {
  const counts = {};
  const completed = [];
  const failed = [];
  const errors = {};
  for (const name of attempted) {
    if (engineMap.has(name)) { completed.push(name); counts[name] = engineMap.get(name).length; continue; }
    if (engineErrors.has(name)) { failed.push(name); counts[name] = 0; errors[name] = engineErrors.get(name); }
  }
  const pending = attempted.filter(name => !completed.includes(name) && !failed.includes(name));
  return { attempted, completed, failed, pending, counts, errors };
}

function normalizeUrlForDedup(url) {
  try {
    const u = new URL(url);
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref']) u.searchParams.delete(p);
    return `${u.protocol}//${u.hostname.replace(/^www\./i, '')}${u.pathname}${u.search}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

function decodeEntities(str) {
  return str.replace(/&#x200B;/gi, '').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&nbsp;/gi, ' ').replace(/\s{2,}/g, ' ').trim();
}

function mergeEngineResults(engineMap, query, limit, intent = 'general') {
  const groups = new Map();
  for (const [engine, results] of engineMap) {
    for (const r of results) {
      const key = normalizeUrlForDedup(r.url);
      if (groups.has(key)) {
        const g = groups.get(key);
        g.engines.push(engine);
        if (r.snippet.length > g.snippet.length) g.snippet = r.snippet;
        if (r.url.length < g.url.length) g.url = r.url;
      } else {
        groups.set(key, { title: r.title, url: r.url, snippet: r.snippet, engines: [engine] });
      }
    }
  }

  const scored = [...groups.values()].map(g => {
    const baseScore = scoreResult(query, g.url, g.title, g.snippet);
    const boost = crossEngineBoost(g.engines.length);
    return { ...g, score: baseScore + boost + intentScoreAdjustment(g, intent), domain: registrableDomain(g.url) };
  });

  scored.sort((a, b) => b.score - a.score);

  const domainCounts = new Map();
  const final = [];
  for (const r of scored) {
    if (final.length >= limit) break;
    const domain = r.domain || 'unknown';
    const count = domainCounts.get(domain) ?? 0;
    if (count >= DOMAIN_MAX) continue;
    domainCounts.set(domain, count + 1);
    final.push({
      title: decodeEntities(r.title).slice(0, 120),
      url: r.url,
      snippet: decodeEntities(r.snippet).slice(0, 300),
      score: r.score,
      engines: r.engines,
      rank: final.length + 1,
    });
  }
  return final;
}

export async function runSearch(query, opts = {}) {
  const limit = opts.limit ?? 10;
  const intent = detectQueryIntent(query);
  const allowedEngines = opts.engines ? new Set(opts.engines) : null;
  const engines = orderEnginesForIntent(
    allowedEngines ? allEnginesList().filter(e => allowedEngines.has(e.name)) : allEnginesList(),
    intent,
  );
  const attempted = engines.map(engine => engine.name);

  const startTime = Date.now();
  const engineMap = new Map();
  const engineErrors = new Map();

  const promises = engines.map(async ({ name, fn }) => {
    try {
      const results = await fn(query, limit + 5);
      engineMap.set(name, results);
      console.error(`[merger] ${name}: ${results.length} results`);
    } catch (err) {
      engineErrors.set(name, err.message);
      console.error(`[merger] ${name} failed: ${err.message}`);
    }
  });

  while (true) {
    const elapsedMs = Date.now() - startTime;
    if (shouldResolveFastPath({ intent, engineMap, engineErrors, attempted, elapsedMs })) break;
    await new Promise(r => setTimeout(r, SEARCH_CONFIG.fastPathPollMs));
  }

  const fastPathResults = mergeEngineResults(engineMap, query, limit, intent);
  const fastPathElapsed = Date.now() - startTime;
  const fastPathEngineCount = engineMap.size;
  const fastPathStats = buildEngineStats(engineMap, engineErrors, attempted);
  const settledCount = fastPathStats.completed.length + fastPathStats.failed.length;
  console.error(`[merger] fast-path(${intent}): ${settledCount}/${engines.length} settled, ${fastPathResults.length} results, ${fastPathElapsed}ms`);

  if (opts.awaitBackground) {
    await Promise.allSettled(promises);
    const finalStats = buildEngineStats(engineMap, engineErrors, attempted);
    return { results: mergeEngineResults(engineMap, query, limit, intent), partial: finalStats.pending.length > 0 || finalStats.failed.length > 0, engineStats: finalStats, elapsed_ms: Date.now() - startTime, intent };
  }

  if (settledCount < engines.length && opts._cacheOpts) {
    Promise.allSettled(promises).then(() => {
      const finalStats = buildEngineStats(engineMap, engineErrors, attempted);
      if (engineMap.size > fastPathEngineCount || finalStats.failed.length !== fastPathStats.failed.length) {
        const betterResults = mergeEngineResults(engineMap, query, limit, intent);
        updateCache(query, opts._cacheOpts, { results: betterResults, partial: finalStats.pending.length > 0 || finalStats.failed.length > 0, engineStats: finalStats, elapsed_ms: Date.now() - startTime, intent });
        console.error(`[merger] background update: ${betterResults.length} results`);
      }
    });
  }

  return { results: fastPathResults, partial: fastPathStats.pending.length > 0 || fastPathStats.failed.length > 0, engineStats: fastPathStats, elapsed_ms: fastPathElapsed, intent };
}
