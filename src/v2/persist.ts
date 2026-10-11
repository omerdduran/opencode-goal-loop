/**
 * V2 persistence backed by the plugin-scoped `ctx.storage` JSON store.
 */

import type { StoreSnapshot } from "../core/state.ts"
import type { V2Storage } from "./context.ts"

export class V2Persistence {
  private readonly storage: V2Storage
  private readonly key: string

  constructor(storage: V2Storage, key = "state") {
    this.storage = storage
    this.key = key
  }

  async load(): Promise<StoreSnapshot | undefined> {
    try {
      const value = await this.storage.get(this.key)
      if (value && typeof value === "object" && (value as StoreSnapshot).version === 1) {
        return value as StoreSnapshot
      }
    } catch {
      // ignore
    }
    return undefined
  }

  async save(snapshot: StoreSnapshot): Promise<void> {
    await this.storage.set(this.key, snapshot)
  }
}
