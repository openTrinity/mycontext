/**
 * EmbedServerService 生命周期：假健康探测 + 不真起 Python。
 */
import { describe, expect, it, vi } from "vitest"
import { ManualClock, createLogger } from "@mycontext/kernel"
import type { DuplexHandle, ProcessRunner } from "@mycontext/runtime-env"
import { EmbedServerService } from "../../../apps/desktop/src/main/services/embed-server.service.js"

const NOW = 1_785_000_000_000

function makeDuplex(): DuplexHandle {
  return {
    async writeLine() {},
    async close() {},
    get alive() {
      return true
    },
    pid: 4242,
  }
}

describe("EmbedServerService", () => {
  it("无 modelDir → failed，不起进程", async () => {
    const spawnDuplex = vi.fn()
    const svc = new EmbedServerService({
      clock: new ManualClock(NOW),
      logger: createLogger("test", { level: "error" }),
      processes: { spawnDuplex } as unknown as ProcessRunner,
      klRoot: "/fake/kl",
      modelDir: null,
      preparePython: async () => ({ python: "/fake/python", env: {} }),
    })
    expect(await svc.ensureReady()).toBe(false)
    expect(svc.getState()).toBe("failed")
    expect(spawnDuplex).not.toHaveBeenCalled()
  })

  it("健康探测已通 → ready，不 spawn", async () => {
    const spawnDuplex = vi.fn()
    const svc = new EmbedServerService({
      clock: new ManualClock(NOW),
      logger: createLogger("test", { level: "error" }),
      processes: { spawnDuplex } as unknown as ProcessRunner,
      klRoot: "/fake/kl",
      modelDir: "/fake/models/Qwen3-Embedding-8B",
      preparePython: async () => ({ python: "/fake/python", env: {} }),
      probeHealth: async () => true,
    })
    expect(await svc.ensureReady()).toBe(true)
    expect(svc.getState()).toBe("ready")
    expect(svc.baseUrl()).toContain("8100")
    expect(spawnDuplex).not.toHaveBeenCalled()
  })

  it("spawn 后 health 变绿 → ready", async () => {
    let healthy = false
    const spawnDuplex = vi.fn(() => {
      // 进程起来后下一拍才健康
      queueMicrotask(() => {
        healthy = true
      })
      return makeDuplex()
    })
    const clock = new ManualClock(NOW)
    const svc = new EmbedServerService({
      clock,
      logger: createLogger("test", { level: "error" }),
      processes: { spawnDuplex } as unknown as ProcessRunner,
      klRoot: "/fake/kl",
      modelDir: "/fake/models/Qwen3-Embedding-8B",
      preparePython: async () => ({ python: "/fake/python", env: process.env }),
      probeHealth: async () => healthy,
      sleep: async () => {
        clock.advance(600)
      },
    })
    expect(await svc.ensureReady()).toBe(true)
    expect(spawnDuplex).toHaveBeenCalledOnce()
    const spec = spawnDuplex.mock.calls[0]![0] as { args: string[]; env: Record<string, string> }
    expect(spec.args).toEqual(["-m", "kl_graph.utils.local_embed_server"])
    expect(spec.env["MYCONTEXT_EMBED_MODEL_DIR"]).toContain("Qwen3-Embedding-8B")
  })
})
