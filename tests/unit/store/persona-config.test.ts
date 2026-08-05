/**
 * 会话配置 upsert 的门禁。
 *
 * ## ★ 锁的是一个真实存在过的 bug：改一个字段会静默擦掉另一个
 *
 * 原来 UPDATE 分支写的是
 * `listening = COALESCE(excluded.listening, 表.listening)`。
 * 但 `excluded.listening` 来自 `VALUES` 里的 `COALESCE(?, 0)` ——
 * 它**永远不是 NULL**，于是"没传 listening"被当成"传了 0"：
 * 用户只改了回复方式，监听就被静默关掉，数字人不再响应，
 * 而界面上没有任何提示，日志里也没有。
 *
 * `listening` 那个字段后来废弃了（管控层改成收所有消息），但**这条规则
 * 对每个字段仍然成立**，所以门禁改成在还活着的字段上验同一件事。
 *
 * 教训是通用的：`excluded.*` 拿到的是**插入分支加工过的值**，
 * 不是调用方的原始意图。想表达"这个字段没传"就必须用一个
 * 没被 COALESCE 处理过的独立参数。
 */
import { describe, expect, it } from "vitest"
import { ConversationRepository, PersonaConfigRepository } from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_785_000_000_000

function seed() {
  const vault = openTestVault()
  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId: "dingtalk",
    externalId: "cid-1",
    type: "group",
    title: "群",
    memberCount: 3,
    createdAt: NOW,
  })
  return vault
}

describe("★ 部分更新不能擦掉没传的字段", () => {
  it("★ 设了 triggerMode 之后只改 replyMode → triggerMode 不被擦回缺省", () => {
    const vault = seed()
    const configs = new PersonaConfigRepository(vault.db)

    configs.upsert("conv-1", { triggerMode: "all" }, NOW)
    expect(configs.get("conv-1")?.triggerMode).toBe("all")

    // 只改回复方式，**不传** triggerMode
    configs.upsert("conv-1", { replyMode: "auto" }, NOW + 1000)

    const after = configs.get("conv-1")
    expect(after?.replyMode).toBe("auto")
    /**
     * 擦回 `mention` 的后果：群里从"每条都处理"变成"只处理 @我"，
     * 而用户只是改了回复方式 —— 他不会想到去检查触发条件。
     */
    expect(after?.triggerMode).toBe("all")
    vault.close()
  })

  it("显式传 false 的布尔字段要真的变 false（否则就没法关了）", () => {
    const vault = seed()
    const configs = new PersonaConfigRepository(vault.db)
    configs.upsert("conv-1", { distillEnabled: true }, NOW)
    configs.upsert("conv-1", { distillEnabled: false }, NOW + 1000)
    /**
     * `COALESCE` 的经典坑：`false → 0`，而 `COALESCE(0, 旧值)` 是 0
     * （0 不是 NULL），所以这条能过。但如果有人"顺手"把 0 也当成
     * "没传"来处理，关就永远关不掉了。
     */
    expect(configs.get("conv-1")?.distillEnabled).toBe(false)
    vault.close()
  })

  it("keywords 与 personaNote 同样不被擦", () => {
    const vault = seed()
    const configs = new PersonaConfigRepository(vault.db)
    configs.upsert("conv-1", { keywords: ["发布", "上线"], personaNote: "这个群偏正式" }, NOW)
    configs.upsert("conv-1", { replyMode: "auto" }, NOW + 1000)

    const after = configs.get("conv-1")
    expect(after?.keywords).toEqual(["发布", "上线"])
    expect(after?.personaNote).toBe("这个群偏正式")
    vault.close()
  })

  it("★ 首次 upsert 用安全默认：只出草稿 + 只处理 @我", () => {
    const vault = seed()
    const configs = new PersonaConfigRepository(vault.db)
    // 只传一个无关字段
    configs.upsert("conv-1", { personaNote: "备注" }, NOW)

    const row = configs.get("conv-1")
    /**
     * ★ 默认必须是安全侧：数字人以本人身份发消息，误发不可逆。
     * "装好就开始替你说话"绝不能是默认行为。
     *
     * 注意这里**不**断言 `listening` —— 那个概念已经删了。
     * 安全性现在由两处保证：`draft` 模式（不发）+ 白名单（policy 那层）。
     */
    expect(row?.replyMode).toBe("draft")
    expect(row?.triggerMode).toBe("mention")
    vault.close()
  })

  /**
   * ★★ `yolo`（不过判定闸直接发）必须能存能读回。
   *
   * 这一层有个 runtime 白名单（`REPLY_MODES` 那个 Set，防手改过的库让整个
   * 会话列表打不开）。加新档时漏了它的表现是**静默的**：写进去了，读回来
   * 变成 `draft` —— 界面显示"只出草稿"，用户以为没保存上，
   * 而实际上库里那一行写的是 yolo。所以这条断言的是**往返**，不是写入。
   */
  it("★★ replyMode: yolo 能往返（漏了 runtime 白名单会静默退回 draft）", () => {
    const vault = seed()
    const configs = new PersonaConfigRepository(vault.db)

    configs.upsert("conv-1", { replyMode: "yolo" }, NOW)
    expect(configs.get("conv-1")?.replyMode).toBe("yolo")

    // ★ 反证：认不出的值仍然退回缺省（白名单没被改成"什么都放行"）
    vault.db
      .prepare("UPDATE dh_conversation_configs SET reply_mode = ? WHERE conversation_id = ?")
      .run("nonsense", "conv-1")
    expect(configs.get("conv-1")?.replyMode).toBe("draft")
    vault.close()
  })
})

describe("全局设置的读写", () => {
  it("坏 JSON 按缺省处理而不是抛", () => {
    const vault = seed()
    const configs = new PersonaConfigRepository(vault.db)
    vault.db
      .prepare("INSERT INTO dh_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("broken", "{不是 json", NOW)
    // 一条坏设置不该让整轮调度失败（那时用户看到的只是"没有反应"）
    expect(configs.getSetting("broken", "fallback")).toBe("fallback")
    vault.close()
  })

  it("重复 setSetting 是覆盖而不是堆行", () => {
    const vault = seed()
    const configs = new PersonaConfigRepository(vault.db)
    configs.setSetting("rateLimit", { global: 1 }, NOW)
    configs.setSetting("rateLimit", { global: 2 }, NOW + 1)
    expect(configs.getSetting<{ global: number }>("rateLimit", { global: 0 }).global).toBe(2)
    vault.close()
  })
})
