import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, "..", "config.json");

let _llama = null;
let _model = null;
let _context = null;
let _seq = null;
let _loaded = false;
let _routerGrammar = null;

export const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    intent: { enum: ["search", "chat"] },
    query: { type: "string" }
  }
};

async function loadConfig() {
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { modelPath: "./models/qwen.gguf", maxTokens: 300, temperature: 0.7 };
  }
}

export async function loadModel() {
  if (_loaded) return;
  const config = await loadConfig();
  const modelPath = join(__dirname, "..", config.modelPath);

  console.error("[inference] loading model from", modelPath);
  _llama = await getLlama();
  _model = await _llama.loadModel({ modelPath });
  _context = await _model.createContext({ contextSize: 4096, sequences: 4 });
  _seq = _context.getSequence();
  _loaded = true;
  console.error("[inference] model loaded");
}

export async function getRouterGrammar() {
  if (!_llama) throw new Error("Llama not initialized. Load model first.");
  if (!_routerGrammar) {
    _routerGrammar = await _llama.createGrammarForJsonSchema(ROUTER_SCHEMA);
  }
  return _routerGrammar;
}

export function isModelLoaded() {
  return _loaded;
}

export async function generate(prompt, systemPrompt, options = {}) {
  if (!_loaded) throw new Error("Model not loaded");

  const { onToken, grammar, temperature, repeatPenalty } = options;

  _seq.clearHistory();

  const config = await loadConfig();
  const session = new LlamaChatSession({
    contextSequence: _seq,
    systemPrompt: systemPrompt || "You are a helpful assistant.",
    autoDisposeSequence: false,
  });

  let fullText = "";
  try {
    const promptOptions = {
      temperature: temperature ?? config.temperature,
      maxTokens: config.maxTokens,
      onTextChunk(chunk) {
        fullText += chunk;
        onToken?.(chunk);
      },
    };
    if (grammar) {
      promptOptions.grammar = grammar;
    }
    if (repeatPenalty) {
      promptOptions.repeatPenalty = repeatPenalty;
    }
    await session.prompt(prompt, promptOptions);
  } finally {
    session.dispose();
  }

  return fullText;
}

export async function unloadModel() {
  if (_seq) { _seq.dispose(); _seq = null; }
  if (_context) { _context.dispose(); _context = null; }
  if (_model) { _model.dispose(); _model = null; }
  _llama = null;
  _routerGrammar = null;
  _loaded = false;
  console.error("[inference] model unloaded");
}
