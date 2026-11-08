import fs from "node:fs";
import path from "node:path";
import { config, debug } from "./config.js";

export interface SavedImage {
  path: string;
  width?: number;
  height?: number;
  bytes: number;
}

export interface TurnRecord {
  job_id: string;
  kind: "generate" | "edit" | "fetch";
  prompt: string;
  status: string;
  images: SavedImage[];
  text?: string;
  at: string;
}

export interface ChatRecord {
  chat_id: string;
  url: string;
  title?: string;
  label?: string;
  created_at: string;
  updated_at: string;
  turns: TurnRecord[];
}

interface StateFile {
  version: 1;
  chats: Record<string, ChatRecord>;
}

/** Tiny JSON store so chats (and their images) survive restarts and the agent can come back to them. */
export class StateStore {
  private data: StateFile = { version: 1, chats: {} };
  private timer: NodeJS.Timeout | null = null;

  constructor(private file = config.statePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw?.chats) this.data = raw;
    } catch {
      /* first run */
    }
  }

  getChat(id: string): ChatRecord | undefined {
    return this.data.chats[id];
  }

  listChats(): ChatRecord[] {
    return Object.values(this.data.chats).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  upsertChat(id: string, patch: Partial<ChatRecord> & { url: string }): ChatRecord {
    const now = new Date().toISOString();
    const existing = this.data.chats[id];
    const rec: ChatRecord = existing
      ? { ...existing, ...stripUndefined(patch), updated_at: now }
      : ({ chat_id: id, created_at: now, updated_at: now, turns: [], ...stripUndefined(patch) } as ChatRecord);
    this.data.chats[id] = rec;
    this.scheduleSave();
    return rec;
  }

  addTurn(id: string, turn: TurnRecord): void {
    const rec = this.data.chats[id];
    if (!rec) return;
    const i = rec.turns.findIndex((t) => t.job_id === turn.job_id);
    if (i >= 0) rec.turns[i] = turn;
    else rec.turns.push(turn);
    rec.updated_at = new Date().toISOString();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      debug("state save failed", err);
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
