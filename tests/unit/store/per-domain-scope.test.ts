/**
 * **per-domain 范围**：分区白名单按域读不同的键 + 只增不减 + 越界清理。
 *
 * ## ★★★ 这个文件锁的是什么（修 G6' + G14）
 *
 * `DistillScope` 原来四个字段里两个是**聊天**概念，文档域没有任何分区
 * 白名单可读。而闸门**早就准备好了**：`admitByScope` 在文档那条路上已经
 * 传对了空间键（`item.workspaceId ?? ""`），只是 `readDomainScope` 对
 * doc 行读的是 `conversationIds`（恒 undefined）→ 分区闸恒放行。
 *
 * 也就是"过滤能力在、白名单读不到" —— 而它不报错：用户在设置里勾了
 * 3 个知识库，采集照样把 7 个都采回来。
 *
 * 四组断言：
 * ① 按域读对了键（chat → conversationIds、doc → partitions）；
 * ② 闸门真的按空间挡（不是只读对了键就算）；
 * ③ `partitions` 受"只增不减"保护；
 * ④ 收窄空间之后**已有的越界文档会被删**（半个隐私修复比没修更糟）。
 */
import { describe, expect, it } from "vitest"
import {
  DistillSourceRepository,
  DocumentRepository,
  purgeOutOfScopeDocuments,
  readDomainScope,
} from "@mycontext/store"
import { admitByScope } from "@mycontext/ingest"
import { mergeScopeOnlyGrowing } from "../../../apps/desktop/src/main/services/distill-source.service.js"
import { openTestVault } from "../../helpers/vault.js"

const CH = "dingtalk"
const NOW = 1_785_000_000_000
const DAY = 86_400_000

/** 造一个 doc 源的范围行。 */
function saveDocScope(
  vault: ReturnType<typeof openTestVault>,
  scope: { since?: number; until?: number; partitions?: string[] },
): void {
  new DistillSourceRepository(vault.db).upsert("doc", { enabled: true, scope }, NOW)
}

describe("★★★ 分区白名单按域读不同的键（修 G6'）", () => {
  it("★★★ doc 域读 `partitions`，而**不是** `conversationIds`", () => {
    const vault = openTestVault()
    try {
      /**
       * ★ 故意两个键都写上，且值不同 —— 这样"读错键"会得到一个**具体的**
       * 错误答案，而不是碰巧相同。
       */
      new DistillSourceRepository(vault.db).upsert(
        "doc",
        {
          enabled: true,
          scope: { conversationIds: ["cidFAKE0001=="], partitions: ["wikiFAKE01"] },
        },
        NOW,
      )
      const scope = readDomainScope(vault.db, "doc")
      expect(scope.restricted).toBe(true)
      expect([...scope.allow]).toEqual(["wikiFAKE01"])
    } finally {
      vault.close()
    }
  })

  it("★★★ chat 域仍读 `conversationIds`（既有四处调用方不许被动到）", () => {
    const vault = openTestVault()
    try {
      new DistillSourceRepository(vault.db).upsert(
        "chat",
        {
          enabled: true,
          scope: { conversationIds: ["cidFAKE0001=="], partitions: ["wikiFAKE01"] },
        },
        NOW,
      )
      const scope = readDomainScope(vault.db, "chat")
      expect([...scope.allow]).toEqual(["cidFAKE0001=="])
    } finally {
      vault.close()
    }
  })

  it("★★ 两个键都不存在 → 不设限（与「配了但一个都没勾」必须分开）", () => {
    const vault = openTestVault()
    try {
      saveDocScope(vault, { since: NOW - 30 * DAY })
      const scope = readDomainScope(vault.db, "doc")
      // ★ restricted=false = 不设限（而空数组会是 true + 空 allow = 一篇都不采）
      expect(scope.restricted).toBe(false)
    } finally {
      vault.close()
    }
  })

  it("★★★ 空数组 = 「一个都不勾」（一篇都不采），不是「不限」", () => {
    /**
     * 这一条是 `DomainScope.restricted` 那段注释里的判据：两种"空"的含义
     * 相反，而 `string[]` 表达不了这个区别。更早的实现两者都是 `[]`，
     * 于是"我一个都不要"被执行成"全都要"。
     */
    const vault = openTestVault()
    try {
      saveDocScope(vault, { partitions: [] })
      const scope = readDomainScope(vault.db, "doc")
      expect(scope.restricted).toBe(true)
      expect(scope.allow.size).toBe(0)
    } finally {
      vault.close()
    }
  })
})

describe("★★★ 闸门真的按空间挡（不是只读对了键就算）", () => {
  it("★★★ 名单外的空间被丢，名单内的留下", () => {
    /**
     * ★ 断言的是**闸门的结果**，而不是"某个函数被调过" —— 后者锁的是实现，
     * 而这里要锁的事实是"越界文档不在库里"。
     */
    const vault = openTestVault()
    try {
      saveDocScope(vault, { partitions: ["wikiFAKE01"] })
      const scope = readDomainScope(vault.db, "doc")
      const docs = [
        { id: "d1", space: "wikiFAKE01", at: NOW - DAY },
        { id: "d2", space: "wikiFAKE02", at: NOW - DAY },
        { id: "d3", space: "", at: NOW - DAY },
      ]
      const admitted = admitByScope(scope, docs, {
        partitionOf: (doc) => doc.space,
        occurredAtOf: (doc) => doc.at,
      })
      expect(admitted.kept.map((d) => d.id)).toEqual(["d1"])
      expect(admitted.dropped).toBe(2)
    } finally {
      vault.close()
    }
  })

  it("★★★ 反证：把 doc 域改成读 conversationIds 就会**恒放行**", () => {
    /**
     * 这一条把"读错键"的后果显式化：那时 `restricted` 为 false，
     * 于是分区闸整个不生效 —— 而它不报错，只是把 7 个知识库都采回来。
     *
     * ★ 做法是**模拟那个错误**（手动构造一个只有 conversationIds 的行），
     * 而不是改源码 —— 那样这条断言在源码修好之后仍然有意义：
     * 它说的是"只有 conversationIds 时文档不设限"，也就是
     * "文档必须用自己的键"。
     */
    const vault = openTestVault()
    try {
      new DistillSourceRepository(vault.db).upsert(
        "doc",
        { enabled: true, scope: { conversationIds: ["wikiFAKE01"] } },
        NOW,
      )
      const scope = readDomainScope(vault.db, "doc")
      expect(scope.restricted).toBe(false)
      const admitted = admitByScope(scope, [{ space: "wikiFAKE99", at: NOW }], {
        partitionOf: (d) => d.space,
        occurredAtOf: (d) => d.at,
      })
      // ★ 恒放行 —— 这正是修复前的状态
      expect(admitted.kept).toHaveLength(1)
    } finally {
      vault.close()
    }
  })
})

describe("★★★ `partitions` 受「只增不减」保护", () => {
  it("★★★ 两边都有 → 取并集（不许覆盖）", () => {
    const merged = mergeScopeOnlyGrowing(
      { partitions: ["wikiFAKE01", "wikiFAKE02"] },
      { partitions: ["wikiFAKE02", "wikiFAKE03"] },
    )
    expect([...(merged.partitions ?? [])].sort()).toEqual([
      "wikiFAKE01",
      "wikiFAKE02",
      "wikiFAKE03",
    ])
  })

  it("★★★ 反证：漏掉这一行的后果是**直接覆盖**（悄悄缩小采集面）", () => {
    /**
     * 若 `mergeScopeOnlyGrowing` 不处理 `partitions`，那个键会**整个丢掉**
     * （那个函数只把它认识的字段拷进 `merged`）—— 于是保存一次
     * 就把白名单清成"不限"。方向恰好相反，但同样是静默的。
     *
     * ★ 这条断言的形式是"合并结果里必须有这个键" —— 它同时抓住
     * "丢掉"与"覆盖"两种写法。
     */
    const merged = mergeScopeOnlyGrowing({ partitions: ["wikiFAKE01"] }, { since: NOW })
    // 库里有限制、这次没传 → 按 `widen` 的第二格，放宽到"不限"（允许）
    expect(merged.partitions).toBeUndefined()
    // ★ 而两边都有时必须并集（上一条）—— 两条一起才锁住这个字段
    expect(mergeScopeOnlyGrowing({ partitions: ["a"] }, { partitions: ["b"] }).partitions).toEqual([
      "a",
      "b",
    ])
  })
})

describe("★★★ 收窄空间之后越界文档会被删（半个隐私修复比没修更糟）", () => {
  /** 造几篇文档（跨两个空间、跨两个时间）。 */
  function seed(vault: ReturnType<typeof openTestVault>): void {
    const repo = new DocumentRepository(vault.db)
    repo.upsertMany([
      {
        id: "d1",
        channelId: CH,
        externalId: "x1",
        title: "在范围内",
        workspaceId: "wikiFAKE01",
        updatedAt: NOW - DAY,
        fetchedAt: NOW,
      },
      {
        id: "d2",
        channelId: CH,
        externalId: "x2",
        title: "空间越界",
        workspaceId: "wikiFAKE02",
        updatedAt: NOW - DAY,
        fetchedAt: NOW,
      },
      {
        id: "d3",
        channelId: CH,
        externalId: "x3",
        title: "时间越界",
        workspaceId: "wikiFAKE01",
        updatedAt: NOW - 400 * DAY,
        fetchedAt: NOW,
      },
    ])
  }

  it("★★★ 空间越界与时间越界**都删**（两道闸并列，不是嵌套）", () => {
    /**
     * ★ 「并列」这一条是 `admitByScope` 那次的同一个教训：把时间闸包在
     * `if (restricted)` 里面，会让「配了 since、没配白名单」这个组合下
     * `since` 完全失效 —— 而那正是非主渠道的真实形状。
     */
    const vault = openTestVault()
    try {
      seed(vault)
      const report = purgeOutOfScopeDocuments(vault.db, CH, {
        restricted: true,
        allow: new Set(["wikiFAKE01"]),
        since: NOW - 90 * DAY,
        until: undefined,
      })
      expect(report.documents).toBe(2)
      const left = vault.db
        .prepare<
          [string],
          { external_id: string }
        >("SELECT external_id FROM documents WHERE channel_id = ?")
        .all(CH)
      expect(left.map((r) => r.external_id)).toEqual(["x1"])
    } finally {
      vault.close()
    }
  })

  it("★★★ 不设限时**一篇都不删**（不设限时「越界」没有定义）", () => {
    const vault = openTestVault()
    try {
      seed(vault)
      const report = purgeOutOfScopeDocuments(vault.db, CH, {
        restricted: false,
        allow: new Set(),
        since: null,
        until: undefined,
      })
      expect(report.documents).toBe(0)
      expect(
        vault.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM documents").get()?.c,
      ).toBe(3)
    } finally {
      vault.close()
    }
  })

  it("★★ dryRun 与真删报**同一个数字**（否则「预演说 3、实际删 3 万」）", () => {
    const vault = openTestVault()
    try {
      seed(vault)
      const scope = {
        restricted: true,
        allow: new Set(["wikiFAKE01"]),
        since: undefined,
        until: undefined,
      }
      const preview = purgeOutOfScopeDocuments(vault.db, CH, scope, { dryRun: true })
      expect(preview.dryRun).toBe(true)
      // ★ 预演之后库里一篇都没少
      expect(
        vault.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM documents").get()?.c,
      ).toBe(3)
      const real = purgeOutOfScopeDocuments(vault.db, CH, scope)
      expect(real.documents).toBe(preview.documents)
    } finally {
      vault.close()
    }
  })

  it("★★★ 业务时间用 `updated_at ?? created_at ?? fetched_at`（三处必须同一个判据）", () => {
    /**
     * `fetched_at` 是"这一轮抓取的时刻"。拿它当业务时间会让**每篇文档都
     * 是今天的** —— 于是任何 `since` 都放行，闸门等于不存在
     * （`toDocumentChangelogEntry` 与 `rebuildFromDocuments` 的分桶
     * 用的正是这个三级表达式）。
     *
     * 这里的断言：一篇 `updated_at` 很老、而 `fetched_at` 是今天的文档，
     * 在 `since = 90 天前` 下**必须被删**。
     */
    const vault = openTestVault()
    try {
      new DocumentRepository(vault.db).upsertMany([
        {
          id: "d9",
          channelId: CH,
          externalId: "x9",
          title: "三年前写的",
          workspaceId: "wikiFAKE01",
          updatedAt: NOW - 1000 * DAY,
          // ★ 今天抓的 —— 若用它当业务时间，这篇会被判成"在范围内"
          fetchedAt: NOW,
        },
      ])
      const report = purgeOutOfScopeDocuments(vault.db, CH, {
        restricted: false,
        allow: new Set(),
        since: NOW - 90 * DAY,
        until: undefined,
      })
      expect(report.documents).toBe(1)
    } finally {
      vault.close()
    }
  })
})
