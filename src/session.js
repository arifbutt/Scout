import { mkdir, readFile, writeFile, readdir, rm } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(__dirname, "..", "sessions");
const MAX_HISTORY = 20;

async function ensureDir() {
  if (!existsSync(SESSIONS_DIR)) await mkdir(SESSIONS_DIR, { recursive: true });
}

function now() {
  return new Date().toISOString();
}

function sessionPath(id) {
  return join(SESSIONS_DIR, id);
}

function metaPath(id) {
  return join(SESSIONS_DIR, id, "meta.json");
}

function historyPath(id) {
  return join(SESSIONS_DIR, id, "history.jsonl");
}

function genId() {
  return randomUUID().slice(0, 8);
}

export async function createSession(title) {
  await ensureDir();
  const id = genId();
  const dir = sessionPath(id);
  await mkdir(dir, { recursive: true });
  const meta = { id, title: title || "New Chat", created: now(), updated: now(), messageCount: 0 };
  await writeFile(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

export async function getSession(id) {
  try {
    const raw = await readFile(metaPath(id), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listSessions() {
  await ensureDir();
  const entries = await readdir(SESSIONS_DIR, { withFileTypes: true });
  const sessions = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const meta = await getSession(entry.name);
      if (meta) sessions.push(meta);
    }
  }
  sessions.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
  return sessions;
}

export async function appendMessage(id, entry) {
  const meta = await getSession(id);
  if (!meta) throw new Error("Session not found");

  const line = JSON.stringify({ ...entry, timestamp: now() }) + "\n";
  await writeFile(historyPath(id), line, { flag: "a" });

  meta.messageCount++;
  meta.updated = now();
  if (meta.messageCount === 1 && entry.role === "user") {
    meta.title = entry.content.slice(0, 60) + (entry.content.length > 60 ? "..." : "");
  }
  await writeFile(metaPath(id), JSON.stringify(meta, null, 2));
}

export async function getHistory(id, limit = MAX_HISTORY) {
  try {
    const raw = await readFile(historyPath(id), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function deleteSession(id) {
  const dir = sessionPath(id);
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function getLastSearch(id) {
  const history = await getHistory(id, 10);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].searchQuery) return history[i].searchQuery;
  }
  return null;
}
