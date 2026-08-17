/**
 * **采集面 = 学习范围 ∪ 监听范围**（v4 阶段 B）。
 *
 * ## ★★★ 这个文件锁的是什么
 *
 * 改动前采集面直接读**学习范围** —— 而那是一个**下游**的口径
 * （"什么该进学习语料"）。拿它当采集面的判据，等于让一个下游替所有下游
 * 决定"能不能拿到数据"。而另一个下游（数字分身）要的东西被挡了：
 *
 * | 情形 | 改动前 |
 * |---|---|
 * | 用户选了历史区间（`until` 在过去） | 新消息被上界挡住 → 分身**收不到** |
 * | 会话在监听范围、不在学习白名单 | 同上 |
 * | 分身**自己发的回复** | 走定向补拉 → 同一道闸 → 同样进不来 |
 *
 * ★ 第三条有放大器：`admit()` 判"该不该回"要读这个会话之前的往来。
 * 分身回过的话不在库里 → 下一轮它看不见自己说过什么。
 *
 * 五组断言：
 * ① 并集（监听里的会话必须在采集面内）；
 * ② ★ `until` 对 `attentionOnly` **豁免**（那第一个洞）；
 * ③ 下界取更宽；
 * ④ `collectsNothing` 是"两个范围都空"；
 * ⑤ ★ mode 三态在采集面上的含义与路由**不同**（`all` 不扩大采集面）。
 */
import { describe, expect, it } from "vitest"
import {
  AttentionScopeRepository,
  DistillSourceRepository,
  isWithinCollectionWindow,
  readCollectionRequest,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const CH = "dingtalk"
const NOW = 1_785_000_000_000
const DAY = 86_400_000
const A = "cidFAKE0001=="
const B = "cidFAKE0002=="

type Vault = ReturnType<typeof openTestVault>

/** 写学习范围。 */
function learning(
  vault: Vault,
  scope: { since?: number; until?: number; conversationIds?: string[] },
): void {
  new DistillSourceRepository(vault.db).upsert("chat", { enabled: true, scope }, NOW)
}

/** 写监听范围（含 mode）。 */
function attention(
  vault: Vault,
  ids: readonly string[],
  mode: "unset" | "all" | "explicit",
  enabledAt = NOW,
): void {
  const repo = new AttentionScopeRepository(vault.db)
  if (mode !== "unset") repo.setMode(CH, mode, NOW)
  if (ids.length > 0) {
    repo.add(
      CH,
      ids.map((conversationExternalId) => ({ conversationExternalId, enabledAt, source: "user" })),
      NOW,
    )
  }
}

describe("★★★ 并集：监听范围里的会话必须在采集面内", () => {
  it("★★★ 学习白名单只有 A、监听名单有 B → 采集面是 {A, B}", () => {
    const vault = openTestVault()
    try {
      learning(vault, { conversationIds: [A] })
      attention(vault, [B], "explicit")
      const request = readCollectionRequest(vault.db, "chat", CH)
      expect(request.restricted).toBe(true)
      expect([...request.allow].sort()).toEqual([A, B].sort())
      // ★ B 是"只因监听而在面内"的 —— 它不受 until 约束（见下一组）
      expect([...request.attentionOnly]).toEqual([B])
    } finally {
      vault.close()
    }
  })

  it("★★★ 学习范围一个都没勾、但监听了 B → **仍要拉**（不是 collectsNothing）", () => {
    /**
     * 改动前这个组合会让整趟不采（学习范围空 ⇒ `collectsNothing`），
     * 而那 3 个群正是用户明确要分身盯的。
     */
    const vault = openTestVault()
    try {
      learning(vault, { conversationIds: [] })
      attention(vault, [B], "explicit")
      const request = readCollectionRequest(vault.db, "chat", CH)
      expect(request.collectsNothing).toBe(false)
      expect([...request.allow]).toEqual([B])
    } finally {
      vault.close()
    }
  })

  it("★★ 学习范围不设限 → 采集面也不设限（监听名单是它的子集）", () => {
    const vault = openTestVault()
    try {
      learning(vault, { since: NOW - 30 * DAY })
      attention(vault, [B], "explicit")
      const request = readCollectionRequest(vault.db, "chat", CH)
      expect(request.restricted).toBe(false)
      // ★ 不设限时那两个集合无意义 —— 不许在这里塞一个具体列表
      expect(request.allow.size).toBe(0)
      expect(request.attentionOnly.size).toBe(0)
    } finally {
      vault.close()
    }
  })
})

describe("★★★ `until` 对 attentionOnly 豁免（那第一个洞）", () => {
  it("★★★ 用户选「学到 30 天前」，而 B 在监听 → B 的**新消息仍要拉**", () => {
    /**
     * ## 这是那三个洞里最实际的一个
     *
     * 用户选「学到 7 月 30 日」而仍在盯某个群。若采集面照搬学习范围的
     * `until`，那个群的新消息**全部被挡** —— 而用户的两个选择
     * 都没有要求这件事发生。
     */
    const vault = openTestVault()
    try {
      learning(vault, { conversationIds: [A], until: NOW - 30 * DAY })
      attention(vault, [B], "explicit")
      const request = readCollectionRequest(vault.db, "chat", CH)

      // ★ B（只因监听在面内）的今天的消息 → 放行
      expect(isWithinCollectionWindow(request, B, NOW)).toBe(true)
      // ★★ A（在学习白名单里）的今天的消息 → 被上界挡住（那是学习范围的意思）
      expect(isWithinCollectionWindow(request, A, NOW)).toBe(false)
      // ★ 而 A 在窗内的仍然放行
      expect(isWithinCollectionWindow(request, A, NOW - 40 * DAY)).toBe(true)
    } finally {
      vault.close()
    }
  })

  it("★★★ 反证：若 attentionOnly 也卡上界 → 监听会话的新消息全被挡", () => {
    /**
     * 这一条把那个洞的形状显式化：`attentionOnly` 为空时（也就是
     * "监听会话恰好都在学习白名单里"），上界对它照样生效 ——
     * 那是对的。而它**不在**白名单里时必须豁免。
     */
    const vault = openTestVault()
    try {
      // B 同时在两个范围里 → 它不是 attentionOnly
      learning(vault, { conversationIds: [A, B], until: NOW - 30 * DAY })
      attention(vault, [B], "explicit")
      const request = readCollectionRequest(vault.db, "chat", CH)
      expect(request.attentionOnly.size).toBe(0)
      // ★ 那时 B 也受上界约束（它在学习白名单里，用户说了学到那天为止）
      expect(isWithinCollectionWindow(request, B, NOW)).toBe(false)
    } finally {
      vault.close()
    }
  })
})

describe("★★★ 下界取更宽（min）", () => {
  it("★★★ 学习 since 比 enabledAt 晚 → 取学习的（更早、更宽）", () => {
    const vault = openTestVault()
    try {
      learning(vault, { conversationIds: [A], since: NOW - 90 * DAY })
      attention(vault, [B], "explicit", NOW - 10 * DAY)
      const request = readCollectionRequest(vault.db, "chat", CH)
      expect(request.since).toBe(NOW - 90 * DAY)
    } finally {
      vault.close()
    }
  })

  it("★★★ enabledAt 比学习 since 早 → 取 enabledAt", () => {
    /**
     * ★ 这个组合真实存在：`enabled_at` 只能**变早**（MIN 语义），
     * 所以一个反复开关过的监听会话可能有一个很早的起点。
     */
    const vault = openTestVault()
    try {
      learning(vault, { conversationIds: [A], since: NOW - 10 * DAY })
      attention(vault, [B], "explicit", NOW - 90 * DAY)
      const request = readCollectionRequest(vault.db, "chat", CH)
      expect(request.since).toBe(NOW - 90 * DAY)
    } finally {
      vault.close()
    }
  })

  it("★★ 学习显式选了「不限」（null）→ 最宽，不被 enabledAt 收窄", () => {
    const vault = openTestVault()
    try {
      learning(vault, { conversationIds: [A] })
      attention(vault, [B], "explicit", NOW - 10 * DAY)
      const request = readCollectionRequest(vault.db, "chat", CH)
      // ★ 缺 since 键 = 用户选了不限 → readDomainScope 给 null
      expect(request.since).toBeNull()
    } finally {
      vault.close()
    }
  })
})

describe("★★★ mode 三态在采集面上的含义与路由**不同**", () => {
  it("★★★ mode=all → **不扩大**采集面（它盯的是「已学习的」，天然是子集）", () => {
    /**
     * ## 这一条防的是一次超范围采集
     *
     * `all` 的语义是"盯**全部已学习的**会话" —— 它的范围天然是学习范围的
     * 子集。误判成"扩大到全部会话"会让一个选了"盯全部"的用户被采
     * **全部聊天历史**，而他的学习范围可能只勾了 3 个群。
     */
    const vault = openTestVault()
    try {
      learning(vault, { conversationIds: [A] })
      // ★ 名单里有 B，但 mode 是 all —— 那时名单本身不该扩大采集面
      attention(vault, [B], "all")
      const request = readCollectionRequest(vault.db, "chat", CH)
      expect([...request.allow]).toEqual([A])
      expect(request.attentionOnly.size).toBe(0)
    } finally {
      vault.close()
    }
  })

  it("★★★ mode=unset（存量库）→ 不扩大（用户没表过态）", () => {
    const vault = openTestVault()
    try {
      learning(vault, { conversationIds: [A] })
      attention(vault, [B], "unset")
      const request = readCollectionRequest(vault.db, "chat", CH)
      expect([...request.allow]).toEqual([A])
    } finally {
      vault.close()
    }
  })

  it("★★ 关掉的监听会话（active=0）→ 不再扩大采集面", () => {
    /**
     * "以后别管它"包含"别再为它去拉" —— 它的历史已经在库里了。
     */
    const vault = openTestVault()
    try {
      learning(vault, { conversationIds: [A] })
      attention(vault, [B], "explicit")
      new AttentionScopeRepository(vault.db).disable(CH, B, NOW)
      const request = readCollectionRequest(vault.db, "chat", CH)
      expect([...request.allow]).toEqual([A])
    } finally {
      vault.close()
    }
  })
})

describe("★★★ 非 chat 域不读监听范围（那个耦合没有收益）", () => {
  it("★★★ doc 域：采集面 = 学习范围（分身盯的是消息，不是文档）", () => {
    const vault = openTestVault()
    try {
      new DistillSourceRepository(vault.db).upsert(
        "doc",
        { enabled: true, scope: { partitions: ["wikiFAKE01"] } },
        NOW,
      )
      attention(vault, [B], "explicit")
      const request = readCollectionRequest(vault.db, "doc", CH)
      expect([...request.allow]).toEqual(["wikiFAKE01"])
      expect(request.attentionOnly.size).toBe(0)
    } finally {
      vault.close()
    }
  })
})

describe("★★★ 接线：采集面真的被用了", () => {
  it("★★★ `persist()` 走 collectionRequest，而**不再**走 readDomainScope", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    // ★ 闸门读采集面
    expect(src).toContain("this.collectionRequest()")
    // ★★ 且上界按会话判（attentionOnly 豁免）
    expect(src).toContain("isWithinCollectionWindow(request")
  })

  it("★★★ 定向补拉之后必须驱动一次 cycle（否则秒级退化成 2 分钟）", async () => {
    /**
     * 取消快通道之后投递只剩 changelog 那一条。而 `refreshConversation`
     * （event stream / 探针触发）原来落库就返回 —— 投递要等下一轮
     * `tickPull`（2 分钟）。
     *
     * 不补这一行的话 event stream 带来的秒级优势整个消失。
     */
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("apps/desktop/src/main/services/ingest.service.ts", "utf8")
    const refreshBody = src.slice(
      src.indexOf("async refreshConversation("),
      src.indexOf("private async reconcileStale("),
    )
    expect(refreshBody).toContain("runSharedConsumersOnce()")
    // ★ 只在真有新消息时跑（changed === 0 那轮 changelog 里没有新 seq）
    expect(refreshBody).toContain("if (changed > 0)")
  })
})
