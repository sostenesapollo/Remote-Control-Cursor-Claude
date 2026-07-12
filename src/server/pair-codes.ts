import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

/**
 * Pairing codes: short, human-readable, one-time-use.
 *
 * Flow:
 *   1. Extension generates a code via /api/pair/code (or locally) and shows it.
 *   2. Client (web/mobile) submits the code to /api/pair.
 *   3. Server validates + consumes the code, returns a long-lived session token.
 *   4. Session token used for socket.io + HTTP auth (existing WebappSessionStore).
 *
 * Codes expire after PAIR_CODE_TTL_MS. Single-use: consumed on first successful
 * redemption. Persisted so they survive server restarts (the extension spawns
 * the server as a child; restarts during dev are common).
 */

const PAIR_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PENDING_CODES = 16;

export interface PairCodeEntry {
  code: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

export interface PairCodeStore {
  /** Generate a fresh code, persist it, return it. */
  generate(): string;
  /** Validate + consume a code. Returns true if the code was valid and unused. */
  consume(code: string): boolean;
  /** Peek without consuming (for /health diagnostics). */
  peek(code: string): PairCodeEntry | undefined;
  /** Active (unconsumed, unexpired) codes — for diagnostics. */
  active(): PairCodeEntry[];
}

export function createPairCodeStore(dataDir: string): PairCodeStore {
  const filePath = join(dataDir, 'pair-codes.json');
  const entries = new Map<string, PairCodeEntry>();

  function load(): void {
    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { codes?: unknown };
      if (!Array.isArray(data.codes)) return;
      const now = Date.now();
      for (const c of data.codes) {
        if (!isEntryShape(c)) continue;
        if (c.expiresAt < now || c.consumed) continue;
        entries.set(c.code, c);
      }
    } catch {
      // ignore corrupt/missing
    }
  }

  function save(): void {
    try {
      mkdirSync(dataDir, { recursive: true });
      const arr = [...entries.values()];
      writeFileSync(filePath, JSON.stringify({ codes: arr }) + '\n', 'utf-8');
    } catch (e) {
      console.error('[pair-codes] Failed to persist:', e);
    }
  }

  load();

  function purgeExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const [k, v] of entries) {
      if (v.expiresAt < now || v.consumed) {
        entries.delete(k);
        changed = true;
      }
    }
    if (changed) save();
  }

  function generateCode(): string {
    // 6 chars from Crockford-base32-like alphabet (no 0/O/1/I ambiguity)
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXY3456789';
    const bytes = randomBytes(6);
    let out = '';
    for (let i = 0; i < 6; i++) {
      out += alphabet[bytes[i] % alphabet.length];
    }
    // Format as XXX-XXX for readability
    return out.slice(0, 3) + '-' + out.slice(3);
  }

  return {
    generate(): string {
      purgeExpired();
      // Rotate: don't allow more than MAX pending codes
      while (entries.size >= MAX_PENDING_CODES) {
        const oldest = [...entries.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (oldest) entries.delete(oldest.code);
        else break;
      }
      const code = generateCode();
      const now = Date.now();
      const entry: PairCodeEntry = {
        code,
        createdAt: now,
        expiresAt: now + PAIR_CODE_TTL_MS,
        consumed: false,
      };
      entries.set(code, entry);
      save();
      return code;
    },

    consume(code: string): boolean {
      purgeExpired();
      const normalized = code.trim().toUpperCase();
      const entry = entries.get(normalized);
      if (!entry) return false;
      if (entry.consumed) return false;
      if (entry.expiresAt < Date.now()) {
        entries.delete(normalized);
        save();
        return false;
      }
      entry.consumed = true;
      entries.delete(normalized);
      save();
      return true;
    },

    peek(code: string): PairCodeEntry | undefined {
      purgeExpired();
      return entries.get(code.trim().toUpperCase());
    },

    active(): PairCodeEntry[] {
      purgeExpired();
      return [...entries.values()];
    },
  };
}

function isEntryShape(x: unknown): x is PairCodeEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return typeof e.code === 'string'
    && typeof e.createdAt === 'number'
    && typeof e.expiresAt === 'number'
    && typeof e.consumed === 'boolean';
}
