import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFile } from "fs/promises";
import { withCache } from "../src/cache.js";
import { runSearch } from "../src/merger.js";
import { extractPage } from "../src/extractor.js";
import { loadModel, generate, isModelLoaded, getRouterGrammar } from "../src/inference.js";
import { createSession, getSession, listSessions, appendMessage, getHistory, deleteSession } from "../src/session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, "..", "config.json");

async function loadConfig() {
  const raw = await readFile(configPath, "utf-8");
  return JSON.parse(raw);
}

function isLowQuality(r) {
  const snippet = r.snippet || "";
  if (snippet.length < 15) return true;
  return false;
}

function pickBest(results) {
  return results
    .filter(r => !isLowQuality(r))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "...";
}

function cleanOutput(text) {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*Source \d+:.*$/gm, "")
    .replace(/^\s*\[?\d+\]?\s*$/gm, "")
    .trim();
}

function buildCompressedHistory(history) {
  if (!history || history.length === 0) return "";

  const recent = history.slice(-4);
  const searchQueries = [];
  let lastAction = null;

  for (const entry of recent) {
    if (entry.searchQuery) {
      searchQueries.push(entry.searchQuery);
    }
  }

  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].role === "user") {
      lastAction = recent[i].searchQuery ? "search" : "chat";
      break;
    }
  }

  const parts = [];
  if (searchQueries.length > 0) {
    parts.push("[PREV_QUERIES: " + searchQueries.join(" | ") + "]");
  }
  if (lastAction) {
    parts.push("[LAST_ACTION: " + lastAction + "]");
  }

  return parts.join("\n") + "\n";
}

function simulateStream(text, sendEvent) {
  for (let i = 0; i < text.length; i += 4) {
    sendEvent("token", { token: text.slice(i, i + 4) });
  }
}

const GREETING_RE = /^(hi|hello|hey|yo|ok|okay|hey there|thanks|thank you|ty)$/i;
const CHAT_REPLY = "Hi! I'm a search assistant. Ask me to look something up on the web.";
const NO_RESULTS_REPLY = "I searched the web but couldn't find any relevant pages to answer that query.";
const ROUTER_SYSTEM = "You are a routing function. Determine if the user needs web information (intent: search) or is just chatting (intent: chat). For search intents, provide a concise search query. For follow-up questions, include context from previous queries.";

const PHASE2_SYSTEM = "You are a strict, factual QA system. Answer the user's request using ONLY the provided SEARCH RESULTS.\n\nCRITICAL RULES:\n1. Rely ONLY on facts directly stated in the SEARCH RESULTS. Do not invent details, brands, or specifications.\n2. COUNT the items in the search results. If the user requests N options but the results contain fewer, list ONLY what exists and say how many were found versus requested.\n3. Never reference external products not in the search results. If the results mention mini PCs, do not list laptops.\n4. Be brief, direct, and factual. No chatty filler. Do not repeat the same information.\n5. If you catch yourself repeating, stop immediately.";

export async function startWebUi() {
  const config = await loadConfig();
  const app = express();

  app.use(express.json());
  app.use(express.static(join(__dirname)));

  app.get("/api/status", (req, res) => {
    res.json({ modelLoaded: isModelLoaded(), config: { port: config.port } });
  });

  app.get("/api/sessions", async (req, res) => {
    const sessions = await listSessions();
    res.json(sessions);
  });

  app.post("/api/sessions", async (req, res) => {
    const session = await createSession();
    res.json(session);
  });

  app.delete("/api/sessions/:id", async (req, res) => {
    await deleteSession(req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/chat", async (req, res) => {
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });

    let session = sessionId ? await getSession(sessionId) : null;
    if (!session) session = await createSession();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendEvent = (type, data) => {
      res.write("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n");
    };

    sendEvent("session", { sessionId: session.id });

    try {
      const trimmed = message.trim();

      // Step 1: Pre-filter greetings (zero model inference)
      if (trimmed.length < 6 && GREETING_RE.test(trimmed)) {
        await appendMessage(session.id, { role: "user", content: message });
        await appendMessage(session.id, { role: "assistant", content: CHAT_REPLY });
        sendEvent("status", { phase: "generating" });
        simulateStream(CHAT_REPLY, sendEvent);
        sendEvent("done", { text: CHAT_REPLY, sources: [], sessionId: session.id });
        res.end();
        return;
      }

      // Step 2: Phase 1 — Grammar-forced JSON routing
      const history = await getHistory(session.id);
      const compressedHistory = buildCompressedHistory(history);

      sendEvent("status", { phase: "thinking" });

      const grammar = await getRouterGrammar();
      const phase1Prompt = compressedHistory + "INPUT: " + message;
      let rawOutput = "";
      await generate(phase1Prompt, ROUTER_SYSTEM, {
        onToken: function(t) { rawOutput += t; },
        grammar: grammar,
      });

      let parsed;
      try {
        parsed = JSON.parse(rawOutput.trim());
      } catch {
        parsed = { intent: "search", query: message };
      }

      const searchQuery = parsed.intent === "search" && parsed.query ? parsed.query : null;

      if (searchQuery) {
        // Step 3: Search pipeline
        await appendMessage(session.id, { role: "user", content: message, searchQuery: searchQuery });

        sendEvent("status", { phase: "search" });

        const cacheOpts = { limit: 8 };
        const searchResult = await withCache(searchQuery, cacheOpts, function() {
          return runSearch(searchQuery, { limit: 8, _cacheOpts: cacheOpts });
        });

        const sources = pickBest(searchResult.results);

        // Step 4: Empty-result interceptor
        if (sources.length === 0) {
          await appendMessage(session.id, { role: "assistant", content: NO_RESULTS_REPLY });
          sendEvent("status", { phase: "generating" });
          simulateStream(NO_RESULTS_REPLY, sendEvent);
          sendEvent("done", { text: NO_RESULTS_REPLY, sources: [], sessionId: session.id });
          res.end();
          return;
        }

        sendEvent("sources", { sources: sources });

        var contexts = [];
        for (var i = 0; i < sources.length; i++) {
          sendEvent("status", { phase: "reading " + (i + 1) + "/" + sources.length });
          try {
            const page = await extractPage(sources[i].url);
            if (page && page.content) {
              contexts.push({ title: page.title, url: sources[i].url, text: truncate(page.content, 800) });
            } else {
              contexts.push({ title: sources[i].title, url: sources[i].url, text: truncate(sources[i].snippet, 500) });
            }
          } catch {
            contexts.push({ title: sources[i].title, url: sources[i].url, text: truncate(sources[i].snippet, 500) });
          }
        }

        sendEvent("status", { phase: "generating" });

        const resultsBlock = contexts.map(function(c, i) {
          return "--- START SOURCE [" + (i + 1) + "] ---\nURL: " + c.url + "\nTITLE: " + c.title.trim() + "\nCONTENT EXCERPT: " + c.text.replace(/\s+/g, ' ').trim() + "\n--- END SOURCE [" + (i + 1) + "] ---";
        }).join("\n\n");

        const phase2UserPrompt = compressedHistory + "SEARCH RESULTS:\n" + resultsBlock + "\n\nQuestion: " + message + "\nassistant:";

        var fullText = "";
        var repAborter = new AbortController();
        const REP_WINDOW = 4;

        await generate(phase2UserPrompt, PHASE2_SYSTEM, {
          onToken: function(t) {
            fullText += t;
            sendEvent("token", { token: t });

            // Line-level repetition guard
            var lines = fullText.split("\n").filter(function(l) { return l.trim().length > 0; });
            if (lines.length >= REP_WINDOW) {
              var recent = lines.slice(-REP_WINDOW);
              var unique = new Set(recent.map(function(l) { return l.trim(); }));
              if (unique.size <= 2) {
                fullText += "\n\n[Response truncated: output was repeating]";
                sendEvent("token", { token: "\n\n[Response truncated: output was repeating]" });
                repAborter.abort();
              }
            }
          },
          temperature: 0.5,
          repeatPenalty: {
            penalty: 1.1,
            frequencyPenalty: 0.15,
          },
          signal: repAborter.signal,
          stopOnAbortSignal: true,
        });

        const urls = contexts.map(function(c) { return { title: c.title, url: c.url }; });
        const clean = cleanOutput(fullText);
        await appendMessage(session.id, { role: "assistant", content: clean });
        sendEvent("done", { text: clean, sources: urls, sessionId: session.id });
      } else {
        // Step 5: Chat intent fallback (no search performed)
        await appendMessage(session.id, { role: "user", content: message });
        await appendMessage(session.id, { role: "assistant", content: CHAT_REPLY });
        sendEvent("status", { phase: "generating" });
        simulateStream(CHAT_REPLY, sendEvent);
        sendEvent("done", { text: CHAT_REPLY, sources: [], sessionId: session.id });
      }
    } catch (err) {
      console.error("[webui] chat error:", err);
      sendEvent("error", { error: err.message });
    }
    res.end();
  });

  app.get("/api/model/load", async (req, res) => {
    try { await loadModel(); res.json({ status: "loaded" }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  const port = config.port || 3848;
  app.listen(port, function() {
    console.error("[webui] http://localhost:" + port);
  });
}
