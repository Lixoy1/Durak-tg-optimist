import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PlayerStats {
  userId: string;
  username: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  rating: number;
}

export interface UserSettings {
  userId: string;
  trumpPosition: 'left' | 'right';
  soundEnabled: boolean;
}

interface StoragePayload {
  version: 1;
  stats: Record<string, PlayerStats>;
  settings: Record<string, UserSettings>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validStats(value: unknown): value is PlayerStats {
  if (!isRecord(value)) return false;
  return typeof value.userId === 'string' && typeof value.username === 'string' &&
    Number.isSafeInteger(value.games) && (value.games as number) >= 0 &&
    Number.isSafeInteger(value.wins) && (value.wins as number) >= 0 &&
    Number.isSafeInteger(value.losses) && (value.losses as number) >= 0 &&
    Number.isSafeInteger(value.draws) && (value.draws as number) >= 0 &&
    typeof value.rating === 'number' && Number.isFinite(value.rating) && value.rating >= 0 && value.rating <= 5;
}

function validSettings(value: unknown): value is UserSettings {
  return isRecord(value) && typeof value.userId === 'string' &&
    (value.trumpPosition === 'left' || value.trumpPosition === 'right') &&
    typeof value.soundEnabled === 'boolean';
}

/** Synchronous JSON store. Writes use same-directory temp files followed by atomic rename. */
export class PersistentStore {
  private readonly filePath: string | null;
  private readonly stats = new Map<string, PlayerStats>();
  private readonly settings = new Map<string, UserSettings>();
  private closed = false;

  constructor(filePath: string | null = process.env.STORAGE_FILE ?? null) {
    this.filePath = filePath;
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!isRecord(parsed)) throw new Error('Storage root must be an object');
      if (isRecord(parsed.stats)) {
        for (const [key, value] of Object.entries(parsed.stats)) {
          if (validStats(value)) this.stats.set(key, { ...value });
        }
      }
      if (isRecord(parsed.settings)) {
        for (const [key, value] of Object.entries(parsed.settings)) {
          if (validSettings(value)) this.settings.set(key, { ...value });
        }
      }
    } catch (error) {
      // Keep the service available, but do not silently overwrite the damaged file until a write occurs.
      console.warn('[storage] could not load existing store file:', error instanceof Error ? error.message : 'unknown');
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('PersistentStore is closed.');
  }

  private flushToDisk(): void {
    this.assertOpen();
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload: StoragePayload = {
      version: 1,
      stats: Object.fromEntries([...this.stats].map(([key, value]) => [key, { ...value }])),
      settings: Object.fromEntries([...this.settings].map(([key, value]) => [key, { ...value }])),
    };
    const tempPath = `${this.filePath}.tmp.${process.pid}`;
    try {
      writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tempPath, this.filePath);
    } catch (error) {
      throw new Error(`Не удалось сохранить хранилище ${this.filePath}: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  public ensurePlayer(userId: string, username: string): PlayerStats {
    this.assertOpen();
    if (!userId.trim()) throw new Error('userId must not be empty');
    const cleanName = username.trim().slice(0, 64) || 'Игрок';
    let entry = this.stats.get(userId);
    if (!entry) {
      entry = { userId, username: cleanName, games: 0, wins: 0, losses: 0, draws: 0, rating: 0.1 };
      this.stats.set(userId, entry);
      this.flushToDisk();
    } else if (cleanName !== 'Игрок' && entry.username !== cleanName) {
      entry.username = cleanName;
      this.flushToDisk();
    }
    return { ...entry };
  }

  public recordMatchOutcome(userId: string, username: string, outcome: 'WIN' | 'LOSS' | 'DRAW'): PlayerStats {
    const current = this.ensurePlayer(userId, username);
    current.games += 1;
    if (outcome === 'WIN') {
      current.wins += 1;
      current.rating = Math.min(5, Number((current.rating + 0.2).toFixed(2)));
    } else if (outcome === 'LOSS') {
      current.losses += 1;
      current.rating = Math.max(0.1, Number((current.rating - 0.1).toFixed(2)));
    } else {
      current.draws += 1;
      current.rating = Math.min(5, Number((current.rating + 0.05).toFixed(2)));
    }
    this.stats.set(userId, current);
    this.flushToDisk();
    return { ...current };
  }

  public getLeaderboard(limit = 15): PlayerStats[] {
    this.assertOpen();
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.min(100, Math.trunc(limit))) : 15;
    return [...this.stats.values()]
      .sort((a, b) => b.wins - a.wins || b.rating - a.rating || a.games - b.games)
      .slice(0, safeLimit)
      .map((item) => ({ ...item }));
  }

  public getSettings(userId: string): UserSettings {
    this.assertOpen();
    const existing = this.settings.get(userId);
    return existing ? { ...existing } : { userId, trumpPosition: 'right', soundEnabled: true };
  }

  public saveSettings(userId: string, patch: { trumpPosition?: 'left' | 'right'; soundEnabled?: boolean }): UserSettings {
    this.assertOpen();
    if (!userId.trim()) throw new Error('userId must not be empty');
    const current = this.getSettings(userId);
    const updated: UserSettings = {
      userId,
      trumpPosition: patch.trumpPosition ?? current.trumpPosition,
      soundEnabled: patch.soundEnabled ?? current.soundEnabled,
    };
    this.settings.set(userId, updated);
    this.flushToDisk();
    return { ...updated };
  }

  public close(): void {
    if (this.closed) return;
    this.flushToDisk();
    this.closed = true;
  }
}
