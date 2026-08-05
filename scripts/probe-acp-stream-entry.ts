/**
 * ACP 流的原始 dump —— 只用 agent-runtime 的原语，不经 PersonaService。
 *
 * 判据：`session/prompt` 响应回来时，我们攒到的 text_delta 拼起来是不是
 * 一个**完整**的 JSON。截断的话这里能看到确切的最后一条 update。
 */
import { delimiter } from "node:path"
import { createLogger, systemClock } from "@mycontext/kernel"
import {
  AcpClient,
  AcpSupervisor,
  McpAuth,
  buildOpencodeSpawn,
  createReverseHandlers,
  mapSessionUpdate,
  resolveGatewayModelConfig,
} from "@mycontext/agent-runtime"
import { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"

export async function runAcpProbe(input: {
  env: Record<string, string>
  workspaceRoot: string
  skillsDir: string
  klRoot: string
  klPort: number
  prompt: string
}): Promise<{
  updates: { kind: string; preview: unknown }[]
  collected: string
  collectedAtResponse: string
  stopReason: unknown
  rawLines: string[]
}> {
  const logger = createLogger("Probe", { level: "error" })
  const processes = new ProcessRunner(logger.child("Proc"))
  const runtime = new RuntimeEnv({ binDir: input.workspaceRoot, env: input.env })
  const resolved = runtime.tryResolveOpencode()
  if (resolved === null) throw new Error("opencode 未找到")

  const modelConfig = resolveGatewayModelConfig(input.env)
  if (modelConfig === null) throw new Error("没有网关配置")

  const baseEnv = {
    ...input.env,
    PATH: `${input.klRoot}${delimiter}${input.env["PATH"] ?? ""}`,
    KL_SERVER_PORT: String(input.klPort),
  }
  const hardened = buildOpencodeSpawn({
    baseEnv,
    modelConfig,
    allowKlCommand: true,
    skillPaths: [input.skillsDir],
  })

  const updates: { kind: string; preview: unknown }[] = []
  const rawLines: string[] = []
  const chunks: string[] = []

  const handlers = createReverseHandlers({ kind: "persona", onToolAudit: () => {} })

  const transport = processes.spawnDuplex({
    executable: resolved.path,
    args: hardened.args,
    env: hardened.env,
    cwd: input.workspaceRoot,
    onLine: (line: string) => {
      rawLines.push(line.slice(0, 4000))
      client.handleLine(line)
    },
    onStderr: () => {},
    onExit: () => {},
  })

  const client = new AcpClient({
    transport,
    logger: logger.child("Acp"),
    onNotification: (method, params) => {
      if (method !== "session/update") return
      const update = (params as { update?: { sessionUpdate?: string } })?.update
      updates.push({ kind: update?.sessionUpdate ?? "?", preview: update })
      for (const event of mapSessionUpdate(params, "turn_1")) {
        if (event.type === "text_delta") chunks.push(event.text)
      }
    },
    reverseHandlers: {
      "session/request_permission": (params) =>
        handlers.requestPermission(params as { toolName: string }),
      "fs/read_text_file": (params) =>
        handlers.readTextFile({
          path: (params as { path?: string }).path ?? "",
          workspaceRoot: input.workspaceRoot,
        }),
      "fs/write_text_file": () => handlers.writeTextFile(),
    },
    requestTimeoutMs: 120_000,
  })

  await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  })

  const supervisor = new AcpSupervisor({
    client,
    mcpAuth: new McpAuth({ clock: systemClock }),
    mcpPort: 47_999,
    logger: logger.child("Sup"),
    hostToolsEnabled: false,
    onSessionIdChanged: () => {},
    beginReplaySuppression: () => () => {},
  })

  const ensured = await supervisor.ensureSession({
    id: "probe",
    acpSessionId: null,
    cwd: input.workspaceRoot,
    kind: "persona",
    scopeId: "probe",
  })

  const stopReason = await client.request("session/prompt", {
    sessionId: ensured.acpSessionId,
    prompt: [{ type: "text", text: input.prompt }],
  })

  // ★ 判据：响应 resolve 的那一刻攒到了多少 vs 再等 1.5 秒后攒到了多少。
  // 两者不同 = 通知在响应之后才到，也就是 PersonaAcp 那一行读早了。
  const collectedAtResponse = chunks.join("")
  await new Promise((r) => setTimeout(r, 1500))
  const collected = chunks.join("")
  await transport.close().catch(() => undefined)
  return { updates, collected, collectedAtResponse, stopReason, rawLines }
}
