#!/usr/bin/env node
/**
 * 生成算法团队联调所需的 KL_* 环境变量。
 *
 * 读 `shared/handoff.json`（由应用在登录后写出）而不是让人手填：
 * 端口是随机的、token 是随机的，手填必然过期。
 *
 * 用法：
 *   eval "$(node scripts/kl-env.mjs)"          # 注入当前 shell
 *   node scripts/kl-env.mjs --json             # 看结构
 *
 * `--data-dir` 可覆盖 handoff 里的默认值（他们可能想把索引放别处）。
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * handoff.json 的位置。
 *
 * 开发态 userData 目录名与打包态不同（见 apps/desktop/.../paths.ts），
 * 两个都试 —— 联调时用的通常是开发态。
 */
function findHandoff() {
  const explicit = process.env["MYCONTEXT_HANDOFF"]
  if (explicit !== undefined && explicit !== "" && existsSync(explicit)) return explicit

  const appSupport = join(homedir(), "Library", "Application Support")
  for (const appName of ["MyContextDevelop", "MyContext"]) {
    const candidate = join(appSupport, appName, "shared", "handoff.json")
    if (existsSync(candidate)) return candidate
  }
  return null
}

const path = findHandoff()
if (path === null) {
  console.error(
    [
      "未找到 handoff.json。",
      "它由应用在**登录后**写出（Feed Server 的端口与 token 那时才确定）。",
      "请先启动应用并登录，或用 MYCONTEXT_HANDOFF=<path> 指定。",
    ].join("\n"),
  )
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(path, "utf8"))
const dataDirOverride = process.argv.includes("--data-dir")
  ? process.argv[process.argv.indexOf("--data-dir") + 1]
  : undefined

const env = {
  // 共享根目录：kl 的 config.py 有从它推导两个路径的兜底（我们加的，只加不改）
  MYCONTEXT_SHARED_DIR: manifest.shared.root,
  KL_DWS_EXPORT_DIR: manifest.shared.dwsExportDir,
  KL_DATA_DIR: dataDirOverride ?? manifest.shared.klDataDir,
  // embedding 网关：给的是"能让他们自己算"的配置，不是我们算好的向量
  // （维度不同，给了也用不了 —— 见对接文档的 embedding 边界一节）
  KL_EMBED_BASE_URL: manifest.embedding.baseUrl,
  KL_EMBED_MODEL: manifest.embedding.model,
  // LLM 网关：他们的抽取阶段用。★ 模型名是**裸名**，不带 provider 前缀 ——
  // 他们的 llm_extractor.py:200 会自己拼 `anthropic/{model}`，
  // 传全名会二次拼接成 model_not_found，而那个错被吞掉并写进缓存
  // （退出码 0、看起来跑完了、什么都没抽出来）。
  KL_LLM_BASE_URL: manifest.llm?.baseUrl ?? "",
  KL_LLM_MODEL: manifest.llm?.model ?? "",
  // 我们的增量接口
  MYCONTEXT_FEED_URL: manifest.feed.baseUrl,
  MYCONTEXT_FEED_TOKEN: manifest.feed.token,
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ source: path, env, embeddingDim: manifest.embedding.dim }, null, 2))
} else {
  // token 会被 eval 注入到 shell 环境里 —— 刻意不打注释说明它是什么，
  // 避免有人把整段输出贴到 issue 里。
  for (const [key, value] of Object.entries(env)) {
    console.log(`export ${key}=${JSON.stringify(value)}`)
  }
  console.log(`# KL_EMBED_API_KEY 与 ANTHROPIC_AUTH_TOKEN 需自行提供（我们不转发密钥）`)
  if (manifest.llm?.modelNote) console.log(`# 注意：${manifest.llm.modelNote}`)
  console.log(`# 来源：${path}`)
}
