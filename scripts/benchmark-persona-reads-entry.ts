import { performance } from "node:perf_hooks"
import Database from "better-sqlite3"
import { ManualClock, createLogger } from "@mycontext/kernel"
import { staticLlmProvider } from "@mycontext/llm"
import { PersonaService } from "../apps/desktop/src/main/services/persona.service.js"

export interface PersonaReadBenchmark {
  attachMs: number
  snapshotMs: number
  conversationsMs: number
  draftsMs: number
  repeatedSnapshotMs: number
  repeatedConversationsMs: number
  conversationCount: number
  draftCount: number
}

export function benchmarkPersonaReads(dbPath: string): PersonaReadBenchmark {
  const db = new Database(dbPath)
  const service = new PersonaService({
    clock: new ManualClock(Date.now()),
    logger: createLogger("PersonaReadBenchmark", { level: "error" }),
    llmProvider: staticLlmProvider(null),
    getWindow: () => null,
  })
  const timed = <T>(work: () => T): { value: T; elapsedMs: number } => {
    const started = performance.now()
    const value = work()
    return { value, elapsedMs: Math.round(performance.now() - started) }
  }
  try {
    const attached = timed(() => service.attach(db))
    const snapshot = timed(() => service.snapshot())
    const conversations = timed(() => service.conversations())
    const drafts = timed(() => service.drafts())
    const repeatedSnapshot = timed(() => service.snapshot())
    const repeatedConversations = timed(() => service.conversations())
    return {
      attachMs: attached.elapsedMs,
      snapshotMs: snapshot.elapsedMs,
      conversationsMs: conversations.elapsedMs,
      draftsMs: drafts.elapsedMs,
      repeatedSnapshotMs: repeatedSnapshot.elapsedMs,
      repeatedConversationsMs: repeatedConversations.elapsedMs,
      conversationCount: conversations.value.length,
      draftCount: drafts.value.length,
    }
  } finally {
    db.close()
  }
}
