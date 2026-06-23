/**
 * singgah — dynamic name registry.
 *
 * Maps a friendly subdomain name to a tunnel port. Unlike the deterministic
 * port↔name matrix in ../shared/names.mjs, these names are chosen by the client
 * at request time, so the proxy can no longer derive the port from the name —
 * it must remember the mapping. That's exactly what this is: a small, in-memory
 * Map with a TTL, persisted to a JSON file so routes survive a proxy restart
 * (the SSH tunnels themselves outlive the proxy, terminating at sshd).
 *
 * The port remains the source of truth and the security boundary: the proxy
 * validates that every registered port falls inside the addressable window
 * before it ever calls register(), so a forged name can't reach :22 or a db.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';

export interface Entry {
  port: number;
  /** Epoch millis after which the entry is considered stale. */
  expiresAt: number;
}

export class Registry {
  private byName = new Map<string, Entry>();
  private readonly file: string;
  private readonly ttlMs: number;

  constructor(file: string, ttlMs: number) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.load();
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, Entry>;
      const now = Date.now();
      for (const [name, e] of Object.entries(data)) {
        if (e && typeof e.port === 'number' && typeof e.expiresAt === 'number' && e.expiresAt > now) {
          this.byName.set(name, e);
        }
      }
    } catch {
      /* no registry file yet — start empty */
    }
  }

  private persist(): void {
    const obj: Record<string, Entry> = {};
    for (const [name, e] of this.byName) obj[name] = e;
    // Best-effort, non-blocking: a lost write only costs us a route on restart.
    fsp.writeFile(this.file, JSON.stringify(obj)).catch(() => {});
  }

  /** Drop expired entries. Returns true if anything changed. */
  sweep(): boolean {
    const now = Date.now();
    let changed = false;
    for (const [name, e] of this.byName) {
      if (e.expiresAt <= now) {
        this.byName.delete(name);
        changed = true;
      }
    }
    if (changed) this.persist();
    return changed;
  }

  /**
   * Bind `name` → `port`. Refreshes the TTL.
   * @returns true on success; false if the name is already taken by a *different*
   *          live port (the caller should retry with a new name).
   */
  register(name: string, port: number): boolean {
    this.sweep();
    const existing = this.byName.get(name);
    if (existing && existing.port !== port) return false;

    // One name per active port: evict any other name pointing at this port so a
    // reconnect (or port reuse) doesn't leave a stale alias behind.
    for (const [n, e] of this.byName) {
      if (e.port === port && n !== name) this.byName.delete(n);
    }

    this.byName.set(name, { port, expiresAt: Date.now() + this.ttlMs });
    this.persist();
    return true;
  }

  release(name: string): void {
    if (this.byName.delete(name)) this.persist();
  }

  /** @returns the port for `name`, or null if absent/expired. */
  resolve(name: string): number | null {
    const e = this.byName.get(name);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      this.byName.delete(name);
      this.persist();
      return null;
    }
    return e.port;
  }

  list(): Array<{ name: string; port: number }> {
    this.sweep();
    return [...this.byName].map(([name, e]) => ({ name, port: e.port }));
  }
}
