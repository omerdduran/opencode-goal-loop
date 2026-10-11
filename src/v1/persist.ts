/**
 * V1 persistence: a single atomic JSON snapshot plus an append-only ledger.
 *
 * The state file is written owner-only (0600) and the directory is created
 * 0700 because it can contain goal text and checkpoints.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { StoreSnapshot } from "../core/state.ts"

export class FilePersistence {
  readonly path: string
  readonly ledgerPath: string

  constructor(path: string) {
    this.path = path
    this.ledgerPath = `${path}.ledger.jsonl`
  }

  async load(): Promise<StoreSnapshot | undefined> {
    try {
      const raw = await readFile(this.path, "utf8")
      const parsed = JSON.parse(raw) as StoreSnapshot
      if (parsed && parsed.version === 1 && parsed.sessions) return parsed
      return undefined
    } catch {
      return undefined
    }
  }

  async save(snapshot: StoreSnapshot): Promise<void> {
    const dir = dirname(this.path)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 })
    await rename(tmp, this.path)
  }

  /** Append one lifecycle ledger line. Best-effort; never throws. */
  async appendLedger(entry: Record<string, unknown>): Promise<void> {
    try {
      const dir = dirname(this.path)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await appendFile(this.ledgerPath, `${JSON.stringify({ time: Date.now(), ...entry })}\n`, {
        mode: 0o600,
      })
    } catch {
      // ignore
    }
  }
}
