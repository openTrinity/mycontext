/**
 * 真跑一轮**文档采集**（会真的调 DWS CLI，消耗接口配额）。
 *
 * ## 为什么需要它
 *
 * 文档链路有三段各自会静默失败的地方，而它们只在真数据上暴露：
 *
 * ① **列举**：`wiki node list` 只给直接子节点，不递归的话拿到的文档数
 *    接近 0 —— 而那是一个**空结果**，不是报错；
 * ② **正文**：`doc read` 对表格 / 脑图给不出 markdown，按后缀过滤错了就是
 *    每轮白烧几十次 CLI 调用（各 0.3-0.8s）而结果永远是空；
 * ③ **时间**：drive 给 ISO 带偏移的串、wiki 给 epoch ms 数字 —— 少吃一种
 *    的表现是 `updated_at` 为 null，而下游按时间窗过滤会漏掉它。
 *
 * 三者都不会抛异常。所以这个脚本的判据是**数字**：列到几篇、其中几篇
 * 有正文、时间解析成功率多少。
 *
 * 走的是与生产**完全相同**的 `plugin.documents` + `persistDocuments`，
 * 不是另一套实现。
 */
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createDingTalkPlugin } from "@mycontext/channels"
import { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"
import { newId, persistDocuments, sha256 } from "@mycontext/ingest"
import { DocumentRepository, openStore, VAULT_MIGRATIONS } from "@mycontext/store"

export interface DocsProbeOptions {
  dbPath?: string | undefined
  /** 最多补几篇正文（每篇一次 CLI 调用） */
  bodies: number
  /**
   * 应用目录（内含 `dws/` profile）。不传时用 MyContextDevelop 的默认位置。
   * 探针跑在 vault 副本上时**必须**指对，否则 DWS 是未登录状态。
   */
  dwsConfigDir?: string | undefined
  onProgress?: ((line: string) => void) | undefined
}

export interface DocsProbeReport {
  dbPath: string
  listed: number
  truncated: boolean
  changed: number
  bodiesFetched: number
  /** 库里总篇数 / 其中有正文的 */
  total: number
  withBody: number
  /** 时间解析成功率（updated_at 非空的比例） —— 见文件头第 ③ 点 */
  withUpdatedAt: number
  byOrigin: Record<string, number>
  byExtension: Record<string, number>
  /** 抽样几篇有正文的（标题 + 正文长度），肉眼确认不是空壳 */
  samples: { title: string; extension: string | null; chars: number }[]
}

function findVault(explicit?: string): string {
  if (explicit !== undefined && explicit !== "") return explicit
  const appSupport = join(homedir(), "Library", "Application Support")
  let best = -1
  let picked: string | null = null
  for (const appName of [
    "MyContextDevelop",
    "MyContextDev",
    "MyContext",
    "InklingsDevelop",
    "InklingsDev",
    "Inklings",
  ]) {
    const vaultsDir = join(appSupport, appName, "vaults")
    if (!existsSync(vaultsDir)) continue
    for (const entry of readdirSync(vaultsDir)) {
      const candidate = join(vaultsDir, entry, "core.sqlite")
      if (!existsSync(candidate)) continue
      try {
        const handle = openStore({ path: candidate, migrations: VAULT_MIGRATIONS })
        const row = handle.db
          .prepare<[], { c: number }>("SELECT count(*) AS c FROM raw_records")
          .get()
        handle.close()
        if ((row?.c ?? 0) > best) {
          best = row?.c ?? 0
          picked = candidate
        }
      } catch {
        // 打不开 / 老 schema —— 跳过
      }
    }
  }
  if (picked === null) throw new Error("未找到任何 vault。先登录一次应用，或用 --db 指定。")
  return picked
}

export async function runDocsProbe(options: DocsProbeOptions): Promise<DocsProbeReport> {
  const dbPath = findVault(options.dbPath)
  const log = options.onProgress ?? ((): void => {})
  log(`vault: ${dbPath}`)

  const store = openStore({ path: dbPath, migrations: VAULT_MIGRATIONS })
  const clock = { now: () => Date.now() }
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, context?: unknown) =>
      log(`  ⚠ ${message} ${context === undefined ? "" : JSON.stringify(context)}`),
    error: (message: string) => log(`  ✗ ${message}`),
    child: () => logger,
  }

  /**
   * 与生产同一套 runtime：binDir / dwsConfigDir 都指向应用的真实目录，
   * 否则会另起一个 DWS profile（等于未登录）—— 与 backfill-entry 同一个理由。
   */
  /**
   * ★ DWS 的 profile 目录**不能**从 dbPath 推。
   *
   * 推导只在"库还在应用目录里"时成立；而探针经常跑在 **vault 副本**上
   * （拷到 /tmp，避免对着每天在用的库写）—— 那时推出来的 dwsConfigDir
   * 指向 /tmp/dws，等于一个全新的未登录 profile，报 `not_authenticated`。
   *
   * 所以允许显式传（`--dws-config`），并默认落回**应用的真实目录**
   * 而不是 dbPath 的兄弟目录。
   */
  const appDir =
    options.dwsConfigDir !== undefined && options.dwsConfigDir !== ""
      ? options.dwsConfigDir
      : join(homedir(), "Library", "Application Support", "MyContextDevelop")
  const runtime = new RuntimeEnv({
    binDir: join(process.cwd(), "apps/desktop/resources/bin"),
    dwsChannel: process.env["MYCONTEXT_DWS_CHANNEL"] ?? "",
    dwsConfigDir: join(appDir, "dws"),
  })
  const processes = new ProcessRunner(logger as never)
  const plugin = createDingTalkPlugin({
    runtime,
    processes,
    logger: logger as never,
    openExternal: () => Promise.resolve(),
  })
  const documents = plugin.documents
  if (documents === undefined) throw new Error("插件没有 documents 能力 —— 接线断了")

  const channelId = plugin.meta.id
  const deps = { db: store.db, clock, logger: logger as never }

  log("① 列举（wiki 全量递归 + drive 首页）…")
  const listed = await documents.list({})
  log(`   列到 ${String(listed.items.length)} 篇，truncated=${String(listed.truncated)}`)

  let changed = 0
  if (listed.items.length > 0) {
    const now = clock.now()
    const result = persistDocuments(deps, {
      raw: [
        {
          id: newId(now),
          channelId,
          resource: "doc",
          externalId: "",
          payload: listed.rawPayload,
          payloadHash: sha256(listed.rawPayload),
          source: "dws-cli",
          fetchedAt: now,
        },
      ],
      documents: listed.items.map((item) => ({
        id: newId(item.updatedAt ?? now),
        channelId,
        externalId: item.externalId,
        origin: item.origin,
        title: item.title,
        docType: item.docType,
        extension: item.extension,
        url: item.url,
        workspaceId: item.workspaceId,
        contentText: item.contentText,
        updatedAt: item.updatedAt,
        createdAt: item.createdAt,
        fetchedAt: now,
      })),
    })
    changed = result.changed.length
    log(`   落库：变化 ${String(changed)} / 未变 ${String(result.unchanged)}`)
  }

  log(`② 补正文（最多 ${String(options.bodies)} 篇）…`)
  const repo = new DocumentRepository(store.db)
  let bodiesFetched = 0
  for (const row of repo.listMissingBody(channelId, options.bodies)) {
    const body = await documents.body({ externalId: row.externalId, extension: row.extension })
    const now = clock.now()
    persistDocuments(deps, {
      raw:
        body.rawPayload === null
          ? []
          : [
              {
                id: newId(now),
                channelId,
                resource: "doc.body",
                externalId: row.externalId,
                payload: body.rawPayload,
                payloadHash: sha256(body.rawPayload),
                source: "dws-cli",
                fetchedAt: now,
              },
            ],
      documents: [
        {
          id: row.id,
          channelId,
          externalId: row.externalId,
          contentText: body.contentText,
          fetchedAt: now,
        },
      ],
    })
    const mark = body.contentText === null ? "—" : `${String(body.contentText.length)} 字`
    log(`   ${(row.title ?? "(无标题)").slice(0, 30)} [${row.extension ?? "?"}] → ${mark}`)
    if (body.contentText !== null) bodiesFetched += 1
  }

  const stat = <T extends string>(sql: string): Record<T, number> => {
    const out = {} as Record<T, number>
    for (const row of store.db.prepare<[], { k: string | null; n: number }>(sql).all()) {
      out[(row.k ?? "(null)") as T] = row.n
    }
    return out
  }

  const report: DocsProbeReport = {
    dbPath,
    listed: listed.items.length,
    truncated: listed.truncated,
    changed,
    bodiesFetched,
    total: repo.count(),
    withBody: repo.countWithBody(),
    withUpdatedAt:
      store.db
        .prepare<
          [],
          { n: number }
        >("SELECT count(*) AS n FROM documents WHERE updated_at IS NOT NULL")
        .get()?.n ?? 0,
    byOrigin: stat("SELECT origin AS k, count(*) AS n FROM documents GROUP BY origin"),
    byExtension: stat(
      "SELECT extension AS k, count(*) AS n FROM documents GROUP BY extension ORDER BY n DESC",
    ),
    samples: store.db
      .prepare<[], { title: string | null; extension: string | null; chars: number }>(
        `SELECT title, extension, length(content_text) AS chars
           FROM documents WHERE content_text IS NOT NULL AND content_text != ''
          ORDER BY chars DESC LIMIT 5`,
      )
      .all()
      .map((r) => ({ title: r.title ?? "(无标题)", extension: r.extension, chars: r.chars })),
  }
  store.close()
  return report
}
