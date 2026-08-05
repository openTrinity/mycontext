#!/usr/bin/env node
/**
 * 通过 CDP 读运行中的应用里**仪表盘真的渲染出了什么**。
 *
 * ## 为什么必须有这个探针
 *
 * 单测能证明"给定 props 时纯函数与组件行为对"，但证明不了这一页在真实
 * 应用里**装得起来**。这一轮的改动恰好全是"装不起来会一片空白"的类型：
 *
 * · 一个新 IPC 通道（`klGraphFacts`）—— 少注册一处就是 invoke 报错；
 * · 一个新 query hook（`useKlGraphFacts`）—— 方法名拼错就是空面板；
 * · Graphin 的 canvas —— jsdom 跑不起来，只有真应用能证明它画出来了；
 * · 撤掉的那一栏（「知识图谱」）—— 回退了不会有任何报错。
 *
 * 这些失败的形态都**不是**报错弹窗，而是"看起来正常但什么都没有"。
 *
 * ## ★ 四类断言，缺一不可
 *
 * ① **结构在**：两个板块、身份条、canvas、邻居列表、过滤器一行；
 * ② **数字非零**：一个"装起来了但全是 —"的页面在截图上与正常页面
 *    几乎一样，而它意味着 IPC 通了但数据没取到；
 * ③ **点了有反应**：切一次时间范围，总数必须跟着动 ——
 *    一个渲染出来却点不动的过滤器是这个项目里反复出现的那类失效；
 * ④ **★ 联动看得见**：点邻居列表一行 → 事实标题带上那个名字
 *    **且**联动带变成「正在看 … 的事实」。
 *
 * ④ 是这一轮加的，而它锁的是一个特殊的失效：联动在代码上**通了**
 * （`entityFocus` 提到了页面级），但用户反馈说「我点个图谱的点我很难
 * 感知到下面会有筛选的感觉」—— 一个通了却看不见的联动等于没通，
 * 而它与"根本没接"在截图和日志上完全一样。所以两半都要断言：
 * 结果真的筛了（标题），以及这件事被说出来了（联动带）。
 *
 * 只读：点侧栏、过滤器与邻居行，不改任何数据。
 * ⚠️ 跑在 vault 副本上（这一页会显示真实人名）。
 *
 * ★ 真实人名不出机器：邻居名的比对全在页内 `evaluate` 里做，
 * 只把布尔结果与字符长度带回来（见下面那段联动断言）。
 *
 * 用法：先带 --remote-debugging-port=<port> 起应用，再跑本脚本。
 */
const PORT = process.argv[2] ?? "9334"

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = targets.find((t) => t.type === "page")
if (!page) throw new Error("未找到渲染进程页面，应用是否已启动？")

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true })
  socket.addEventListener("error", reject, { once: true })
})

let id = 0
const pending = new Map()
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data)
  const handler = pending.get(message.id)
  if (handler) {
    pending.delete(message.id)
    handler(message)
  }
})

function evaluate(expression) {
  const messageId = (id += 1)
  return new Promise((resolve, reject) => {
    pending.set(messageId, (message) => {
      if (message.error) return reject(new Error(JSON.stringify(message.error)))
      const result = message.result?.result
      if (result?.subtype === "error") return reject(new Error(result.description))
      resolve(result?.value)
    })
    socket.send(
      JSON.stringify({
        id: messageId,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    )
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 事实面板顶部的「共 N 条」。读不到时返回 null（而不是 0 —— 那是个真实的值）。 */
function readFactTotal() {
  return evaluate(`(() => {
    const m = document.body.innerText.match(/共\\s*([0-9,]+)\\s*条/)
    return m ? Number(m[1].replace(/,/g, "")) : null
  })()`)
}

/** 点侧栏里含某段文字的入口。返回是否点到。 */
async function openModule(label) {
  return evaluate(`(() => {
    const nodes = [...document.querySelectorAll("button, a")]
    const hit = nodes.find((n) => (n.textContent ?? "").includes(${JSON.stringify(label)}))
    if (!hit) return false
    hit.click()
    return true
  })()`)
}

const problems = []

try {
  // 侧栏可能是收起的（导航项那时不在 DOM 里）—— 先展开，
  // 否则脚本会报"找不到入口"，而那是脚本自己的问题。
  await evaluate(`(() => {
    const toggle = [...document.querySelectorAll("button")]
      .find((n) => (n.getAttribute("aria-label") ?? "").includes("展开侧边栏"))
    if (toggle) toggle.click()
    return true
  })()`)
  await sleep(1000)

  // ── 仪表盘：现在是唯一的一页 ──────────────────────────────
  if ((await openModule("仪表盘")) !== true) throw new Error("侧栏里没找到「仪表盘」入口")
  await sleep(3000)

  /**
   * ★ 先把上一次跑留下的实体筛选清掉 —— 否则**探针自己不可重跑**。
   *
   * 这一条是实测踩到的：探针末尾会点一行邻居（联动断言），而那个选中
   * 状态留在页面上。再跑一次时开头的两条断言就直接红了 ——
   * 「联动提示 无」（提示句被状态带换掉了，那是**正确**行为）与
   * 「读不到共 N 条」（标题变成了"关于 X 的 N 条事实"）。
   *
   * 一个只在新鲜页面上才绿的门禁比没有门禁更糟：第二次跑出来的红
   * 指向两个完全无辜的地方，而人会以为是自己刚写的代码坏了。
   *
   * 点「看全部」而不是刷新页面：刷新要重新等 IPC 与建图，而这个按钮
   * 就是产品里清筛选的那个出口 —— 顺带证明它真的能清。
   */
  const cleared = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('[role="status"] button')]
      .find((n) => (n.textContent ?? "").trim() === "看全部")
    if (!btn) return "already-clean"
    btn.click()
    return "cleared"
  })()`)
  if (cleared === "cleared") {
    await sleep(2000)
    console.log("（清掉了上一次跑留下的实体筛选）")
  }

  /**
   * ★ 时间范围也要复位 —— 同一个"探针不可重跑"的坑，另一半。
   *
   * 下面那条过滤器断言要"从近 30 天切到近 7 天，总数必须变小"。而上一次
   * 跑正是把它切到了近 7 天并留在那里，于是第二次跑时 5459 → 5459 ——
   * 报出来的是「过滤器没生效」，一个完全错误的结论（过滤器好得很，
   * 是探针自己没复位）。
   */
  const rangeReset = await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button[aria-pressed]")]
      .find((n) => (n.textContent ?? "").trim() === "近 30 天")
    if (!btn) return "not-found"
    if (btn.getAttribute("aria-pressed") === "true") return "already"
    btn.click()
    return "reset"
  })()`)
  if (rangeReset === "reset") {
    await sleep(2500)
    console.log("（把时间范围复位到近 30 天）")
  }

  /**
   * ★ 侧栏里**不能**再有「知识图谱」。
   *
   * 这是撤栏那件事的门禁。断言"没有"很容易变成一句空话，所以同时
   * 数一遍导航项 —— 于是"撤掉了图谱"与"侧栏整个没渲染"能区分开。
   */
  const nav = await evaluate(`(() => {
    const items = [...document.querySelectorAll("aside button, nav button, aside a")]
      .map((n) => (n.textContent ?? "").trim())
      .filter((t) => t.length > 0 && t.length < 12)
    return {
      hasGraphEntry: items.some((t) => t.includes("知识图谱")),
      labels: [...new Set(items)],
    }
  })()`)
  if (nav.hasGraphEntry) {
    problems.push("侧栏里又出现了「知识图谱」入口 —— 应该整块并进仪表盘")
  }
  for (const must of ["仪表盘", "数字分身", "搜索", "运行状态"]) {
    if (!nav.labels.some((t) => t.includes(must))) {
      problems.push(`侧栏少了「${must}」—— 撤图谱那一栏时删多了`)
    }
  }
  console.log(`侧栏：${nav.labels.filter((t) => t.length <= 6).join(" / ")}`)

  const dash = await evaluate(
    `(() => {
    const text = document.body.innerText
    /**
     * 主数字与小指标用**比例数字**（规范：tabular-nums 只给要纵向对齐的
     * 列）—— 所以不能再用 tabular-nums 当锚点。改用字号类：
     * hero 是 text-[48px]，stat tile 是 text-[28px]，小指标是 text-[18px]。
     */
    const pick = (cls) =>
      [...document.querySelectorAll("span")]
        .filter((n) => n.className.includes(cls))
        .map((n) => (n.textContent ?? "").trim())
    const hero = pick("text-[48px]")
    const tiles = pick("text-[28px]")
    const minis = pick("text-[18px]")

    /** 分布条：内层填充块带行内 width 百分比（primitives.tsx 的几何） */
    const bars = [...document.querySelectorAll("span")].filter((n) =>
      (n.style.width ?? "").endsWith("%"),
    )
    /** 事实列表的卡片 —— 每条是一个 li */
    const factItems = [...document.querySelectorAll("li")].filter((n) =>
      n.className.includes("rounded-[var(--radius-lg)]"),
    )
    /**
     * 时间范围那一排预设。
     *
     * ★ 必须按**文案**认，不能只按 aria-pressed 收。
     *
     * 这一页上带 aria-pressed 的按钮有三类：4 个时间范围、5 个事实
     * 类型（分布条本身就是过滤器）、还有一个侧栏的开关 —— 实测一共 10 个。
     * 反证时抓到过："至少 4 个" 与 "选中恰好 1 个" 两条都是靠这 10 个
     * 凑出来的，把时间范围整排删掉它们照样绿。
     *
     * （这段注释刻意不用反引号：它在一个模板字符串里面，一个反引号
     * 就会把整个表达式截断 —— 而报错指向的是几十行之后的地方。）
     */
    const RANGE_LABELS = ["近 7 天", "近 30 天", "近 90 天", "全部"]
    const ranges = [...document.querySelectorAll("button[aria-pressed]")]
      .map((n) => ({
        text: (n.textContent ?? "").trim(),
        on: n.getAttribute("aria-pressed") === "true",
      }))
      .filter((r) => RANGE_LABELS.includes(r.text))
    /** 事实类型那一组（分布条可点）—— 与范围分开数，否则两者互相掩护 */
    const typeRows = [...document.querySelectorAll("button[aria-pressed]")].filter((n) =>
      ["决策", "指派", "因果", "状态", "一般"].some((t) => (n.textContent ?? "").startsWith(t)),
    )
    return {
      /**
       * ★ 现在只有**一个** Section 标题 —— 「它认识的人与事」。
       *
       * 「它从聊天里读出了什么」并进了它（那条因果跨不过板块边界，
       * 见 dashboard-module.tsx）；而「我的数字分身」并进了**身份卡**
       * （那四个数与"它是谁"是同一个主语的两半 —— 分开时两处各写了
       * 一遍「在盯着新消息」与「N 个会话可自动回」）。
       *
       * （这段注释刻意不用反引号 —— 它在一个模板字符串里面。）
       */
      hasSections: ["它认识的人与事"].filter((s) => text.includes(s)),
      /** 已合并/已删的板块标题不该再作为**标题**出现 */
      removedSections: ["知识管道", "画像蒸馏", "它从聊天里读出了什么"].filter((s) =>
        text.includes(s),
      ),
      /**
       * ★★ 身份卡：我 → 我的分身 + 分身那四个数，全在一张卡里。
       *
       * 这一条是用户反馈的第一句（原来整页看不到"这是谁的数据、
       * 谁在替我回消息"），第二轮又要求把它与分身的数字**合起来**。
       *
       * ★ 按**结构**认（身份卡那个容器里的文本），不按整页 include：
       * 侧栏底部也有我的名字与头像，用整页文本会**假绿** ——
       * 把整张卡删掉它照样过。锚点用身份三态那句话（只有这一处有），
       * 再取它最近的圆角卡容器（身份卡的根）。
       */
      identityCard: (() => {
        const marker = [...document.querySelectorAll("span")].find((n) =>
          ["本人身份已确认", "本人身份待确认", "读取身份"].some((s) =>
            (n.textContent ?? "").startsWith(s),
          ),
        )
        /**
         * 往上找身份卡的根。
         *
         * ★ 不用 closest("div.rounded-[...]") —— Tailwind 的方括号类名
         * 在 CSS 选择器里非法（实测抛 "is not a valid selector"，而报错
         * 指向探针自己，看起来像页面坏了）。手动往上走并读 className。
         */
        let scope = null
        for (let n = marker?.parentElement ?? null; n !== null; n = n.parentElement) {
          const cls = (n.className ?? "").toString()
          if (cls.includes("radius-lg") && cls.includes("bg-[var(--bg-card-z1)]")) {
            scope = n
            break
          }
        }
        const scopeText = (scope?.textContent ?? "").trim()
        return {
          found: scope !== null,
          /**
           * ★★ 两个"人像位"：我的头像 + 分身形象。
           *
           * 判据**不能**数 img/svg。第一版这么写，结果在 vault 副本上
           * 报「形象只有 1 个」—— 而 UI 完全正确：Avatar 在没有缓存头像
           * 时回落成一个**首字母 span**（一个色块 + 文字），
           * 只有分身的 PersonaFigure 是 img。
           *
           * 也就是说那个判据测的是"这台机器上恰好有没有头像文件"，
           * 而不是"这张卡对不对"。换成按**形状**认。
           *
           * ★ 认 corner-squircle 而不是原来的 rounded-full：头像已经从
           * 纯圆改成方形四圆角，而那个类名是这个形状的稳定标记
           * （半径值按尺寸变，rounded-[9px] 这种硬编码数字不能当判据）。
           * 改动前这一行会静默匹配 0 个 —— 那正是"校验器跟着实现漂移"
           * 的典型形态：它不会报错，只会不再检查任何东西。
           *
           * （这段注释刻意不用反引号 —— 它在一个模板字符串里面。）
           */
          avatarSlots: [...(scope?.querySelectorAll("span, img") ?? [])].filter((n) =>
            (n.className ?? "").toString().includes("corner-squircle"),
          ).length,
          figureSlots: [...(scope?.querySelectorAll("span, img") ?? [])].filter((n) =>
            (n.className ?? "").toString().includes("radius-md"),
          ).length,
          /**
           * ★ 四个数与身份**在同一张卡里**。
           *
           * 这一条锁的正是这一轮的改动：它们原来在一屏之下的另一个
           * Section 里。判据是那四个 label 都出现在这个容器的文本里。
           */
          tilesInside: ["待我确认", "可自动回复", "正在排队", "常驻会话"].filter((s) =>
            scopeText.includes(s),
          ).length,
          text: scopeText.slice(0, 60),
        }
      })(),
      /**
       * ★ 渠道范围那枚筹码在**主数字那一行**，不在身份卡里。
       *
       * 判据：含渠道名的那个元素的最近祖先里有 48px 的主数字 ——
       * 也就是它与主数字在同一个块里。写成"页面上有钉钉"是空的
       * （侧栏、事实卡里都可能出现渠道名）。
       */
      scopeChip: (() => {
        const hero = [...document.querySelectorAll("span")].find((n) =>
          n.className.includes("text-[48px]"),
        )
        const heroBlock = hero?.parentElement ?? null
        const heroText = (heroBlock?.textContent ?? "").trim()
        return { nextToHero: /钉钉|飞书/.test(heroText), text: heroText.slice(0, 60) }
      })(),
      /**
       * ★★ 同一句话不能在一屏上出现两次。
       *
       * 这一条来自真机截图：上一版「在盯着新消息」出现两遍（身份条 +
       * Section 的 subtitle），「可自动回」与「可自动回复」是同一个
       * whitelistCount 的两种说法。读者会去找它们的区别，而其实没有 ——
       * 那正是"看起来不高级"的具体来源：信息没有归位。
       */
      duplicates: {
        watching: (text.match(/在盯着新消息/g) ?? []).length,
        /** 旧文案「N 个会话可自动回」不该再出现（它与那张卡重复） */
        whitelistPhrase: (text.match(/个会话可自动回(?!复)/g) ?? []).length,
      },
      /**
       * ★ 联动带：没选中时那句提示，或选中后那条状态带。
       *
       * 它是"点了图上的点会怎样"这件事的**唯一**书面说明 ——
       * 缺了就回到"用户得自己试出来"的状态。
       */
      hasBridgeHint: text.includes("点图上任意一个点"),
      /** ★ Graphin 的画布：G6 v5 画在 canvas 上，装不起来就没有这个元素 */
      canvasCount: document.querySelectorAll("canvas").length,
      comingSoon: text.includes("暂未开放"),
      rawKeys: /modules\\.[a-z]+\\.(label|description)/.test(text),
      /** 事实面板漏出的 key（graph 命名空间那一批） */
      rawGraphKeys: /\\b(range30|searchPlaceholder|factsTotal|neighborsTitle)\\b/.test(text),
      hero,
      tileCount: tiles.length,
      miniCount: minis.length,
      nonZeroMini: minis.filter((v) => v !== "—" && v !== "0").length,
      barCount: bars.length,
      factCount: factItems.length,
      rangeCount: ranges.length,
      rangeActive: ranges.filter((r) => r.on).length,
      typeRowCount: typeRows.length,
      /** 事实类型翻成了中文（没翻会看到 STATUS/DECISION 原文） */
      translatedFactTypes: ["状态", "决策", "指派"].filter((s) => text.includes(s)),
      /** 邻居列表在（图看结构、列表看排名，缺一半就不直观了） */
      hasNeighbors: text.includes("直接关联"),
      emptyHint: text.includes("还没有可展示的关系图"),
    }
  })()`,
  )

  if (dash.comingSoon) problems.push("仪表盘显示「暂未开放」—— 模块没接上")
  if (dash.rawKeys) problems.push("仪表盘漏出原样的 i18n key")
  if (dash.rawGraphKeys) problems.push("事实面板漏出 graph 命名空间的原样 key")
  if (dash.hasSections.length < 1) {
    problems.push(`仪表盘缺分组：只找到 ${dash.hasSections.join("/")}`)
  }
  if (dash.removedSections.length > 0) {
    problems.push(`仪表盘又出现了技术板块：${dash.removedSections.join("/")}（应该已删/已合并）`)
  }
  /**
   * ★★ 身份卡 —— 用户反馈的第一条 + 第二轮的"合起来"。
   *
   * 原来整页看不到"这是**谁**的数据、**谁**在替我回消息"，而数字分身
   * 以本人身份发消息，那两件事是这个产品的前提。
   *
   * 四条各锁一个独立的失效：
   * · `found` —— 整张卡没渲染（回到反馈之前的状态）；
   * · `figureCount >= 2` —— 我的头像 + 分身形象**两个**。
   *   只有 1 个的形态是分身没起名字（那时形象位是个中性占位方块）；
   * · `tilesInside === 4` —— 四个数**在这张卡里**。这一条锁的是
   *   这一轮的改动：它们原来在一屏之下的另一个 Section 里，
   *   而那种排法让"它是谁"与"它在干什么"看起来是两件事；
   * · `scopeChip.nextToHero` —— 渠道范围与主数字同一行，不在身份卡里。
   */
  if (!dash.identityCard.found) {
    problems.push("顶部没有身份卡 —— 看不到这是谁的数据、谁在替我回消息")
  } else {
    if (dash.identityCard.avatarSlots < 1) {
      problems.push("身份卡上没有我的头像位（Avatar 那个圆形）")
    }
    if (dash.identityCard.figureSlots < 1) {
      problems.push("身份卡上没有分身的形象位（PersonaFigure 那个圆角方形）")
    }
    if (dash.identityCard.tilesInside !== 4) {
      problems.push(
        `分身那四个数没都在身份卡里（找到 ${dash.identityCard.tilesInside}/4）——` +
          " 它们与「它是谁」是同一个主语的两半",
      )
    }
  }
  if (!dash.scopeChip.nextToHero) {
    problems.push(
      `渠道范围不在主数字那一行（读到「${dash.scopeChip.text}」）——` +
        " 它是整页的取值范围，不是某个人的属性",
    )
  }
  /**
   * ★★ 同一句话不能在一屏上出现两次。
   *
   * 真机截图抓到的：上一版「在盯着新消息」两遍、「N 个会话可自动回」
   * 与「可自动回复 N」是同一个字段的两种说法。这一条是那次重复的门禁 ——
   * 它会随缺陷变化（把 Section 加回来就立刻红）。
   */
  if (dash.duplicates.watching > 1) {
    problems.push(`「在盯着新消息」在一屏上出现了 ${dash.duplicates.watching} 次（应恰好 1 次）`)
  }
  if (dash.duplicates.whitelistPhrase > 0) {
    problems.push("「N 个会话可自动回」又出现了 —— 它与「可自动回复」那张卡是同一个数")
  }
  /**
   * ★★ 联动带那句提示。
   *
   * 它是"点图上的点 → 下面只看关于他的事实"这条**暗线**的唯一书面说明。
   * 缺了就回到用户反馈的原状：「我点个图谱的点我很难感知到下面会有筛选的感觉」。
   */
  if (!dash.hasBridgeHint) {
    problems.push("图与事实之间没有联动提示 —— 点图上的点会筛下面这件事没写出来")
  }
  /**
   * ★ 主数字必须有且**只有一个**。
   *
   * 规范：hero number 一个视图一个。两个的话读者不知道该看哪个，
   * 而 0 个意味着 `HeroStat` 没装起来（那时这一页退回一堆等大的卡）。
   */
  if (dash.hero.length !== 1) problems.push(`主数字应恰好 1 个，实际 ${dash.hero.length} 个`)
  if (dash.hero[0] === "—" || dash.hero[0] === "0") {
    problems.push(`主数字是空值（${dash.hero[0]}）—— 采集数据没读到`)
  }
  if (dash.tileCount < 4) problems.push(`指标卡太少（${dash.tileCount}），StatTile 没装起来？`)
  if (dash.nonZeroMini < 3) {
    problems.push(`主数字旁的小指标几乎全空（非零 ${dash.nonZeroMini}/${dash.miniCount}）`)
  }
  /**
   * ★ 关系图必须真的画出来。
   *
   * Graphin / G6 v5 画在 canvas 上 —— jsdom 里跑不起来，所以这是唯一
   * 能证明"图真的渲染了"的检查。缺 canvas 的形态是一个空白的圆角框，
   * 而那与"还没建图"的降级态在截图上几乎一样。
   */
  if (dash.canvasCount === 0) {
    problems.push("仪表盘里没有 canvas —— 关系图（Graphin）没装起来")
  }
  if (dash.emptyHint) problems.push("关系图显示空态 —— ego 图没读到数据")
  if (!dash.hasNeighbors) problems.push("图旁边没有邻居列表 —— 只有图就答不了「谁最重要」")
  /**
   * ★ 分布条：实体类型（≥3）+ 事实类型（5）。
   *
   * 这两组是从原来那一栏搬过来的东西 —— 少了就说明"撤栏"变成了"删功能"。
   */
  if (dash.barCount < 6) problems.push(`分布条太少（${dash.barCount} 条）—— 类型分布没搬过来`)
  if (dash.translatedFactTypes.length < 2) {
    problems.push(`事实类型没翻成中文（找到 ${dash.translatedFactTypes.join("/")}）`)
  }
  /**
   * ★ 过滤器一行：时间范围预设 + 恰好一个选中。
   *
   * `aria-pressed` 全 false 意味着"当前是哪个范围"读不出来，
   * 而那时用户不知道自己在看多久之内的东西。
   */
  /** 恰好 4 个（近 7/30/90 天 + 全部）—— 多了少了都说明那一排被改过 */
  if (dash.rangeCount !== 4) {
    problems.push(`时间范围预设应恰好 4 个，实际 ${dash.rangeCount} 个`)
  }
  /**
   * ★ 事实类型也必须**可点** —— 分布条同时是过滤器。
   *
   * 只画不能点的话它就只是一张图，而"我只想看决策"这个需求
   * 就又没有入口了。5 个类型对应 5 个可点的行。
   */
  if (dash.typeRowCount !== 5) {
    problems.push(`可点的事实类型行应 5 个，实际 ${dash.typeRowCount} 个（分布条不是过滤器了？）`)
  }
  if (dash.rangeActive !== 1) {
    problems.push(`时间范围选中项应恰好 1 个，实际 ${dash.rangeActive} 个`)
  }
  /**
   * ★ 事实列表非空。
   *
   * 这一条证明 `klGraphFacts` 这条新 IPC 真的通了 —— 而它失败的形态
   * 是一个只有过滤器的空面板，看起来像"这个月没有事实"。
   */
  if (dash.factCount < 5) problems.push(`事实列表太短（${dash.factCount} 条）—— 检索 IPC 没通？`)

  console.log(
    `仪表盘：分组 ${dash.hasSections.length}/1，主数字 ${dash.hero[0]}，指标卡 ${dash.tileCount}，` +
      `小指标 ${dash.nonZeroMini}/${dash.miniCount} 非零，canvas ${dash.canvasCount}`,
  )
  console.log(
    `  身份卡：头像位 ${dash.identityCard.avatarSlots}，形象位 ${dash.identityCard.figureSlots}，四个数在卡内 ` +
      `${dash.identityCard.tilesInside}/4；渠道范围在主数字那行 ` +
      `${dash.scopeChip.nextToHero ? "是" : "否"}；联动提示 ${dash.hasBridgeHint ? "有" : "无"}`,
  )
  console.log(
    `  图谱那一块：分布条 ${dash.barCount}，邻居列表 ${dash.hasNeighbors ? "有" : "无"}；` +
      `事实面板：${dash.factCount} 条，范围预设 ${dash.rangeCount}（选中 ${dash.rangeActive}）`,
  )

  // ── 事实检索真的会筛 ──────────────────────────────────────
  /**
   * ★ 切一次时间范围，总数必须**真的变小**。
   *
   * 只断言"过滤器在那儿"是不够的 —— 一个渲染出来但点了没反应的
   * 过滤器是这个项目里反复出现的那类失效（"点了没反应"）。
   *
   * ★ 用「近 7 天」而不是「全部」当对照。
   *
   * 本机图库的事实全落在同一个月里（实测近 30 天 6665 条 = 全部 6665 条），
   * 所以拿「全部」比对时两个数相等 —— 那时"过滤器没生效"与"数据恰好
   * 都在窗口内"完全分不开，断言等于空的。「近 7 天」实测 5807 条，
   * 是一个真子集。
   */
  const totalBefore = await readFactTotal()
  const clicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button[aria-pressed]")]
      .find((n) => (n.textContent ?? "").trim() === "近 7 天")
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (clicked !== true) {
    problems.push("找不到「近 7 天」这个时间范围预设")
  } else {
    await sleep(2500)
    const totalAfter = await readFactTotal()
    if (totalBefore === null || totalAfter === null) {
      problems.push(`读不到「共 N 条」（前 ${totalBefore} 后 ${totalAfter}）`)
    } else if (totalAfter >= totalBefore) {
      /**
       * ★ 这里必须是**严格**小于。
       *
       * 相等就是"点了没反应"—— 而近 7 天必然是近 30 天的真子集
       * （除非图里所有事实都在最近一周，那本身也值得让门禁红一次）。
       */
      problems.push(
        `切到「近 7 天」后总数没变小（${totalBefore} → ${totalAfter}）—— 过滤器没生效？`,
      )
    } else {
      console.log(`  过滤器生效：近 30 天 ${totalBefore} 条 → 近 7 天 ${totalAfter} 条`)
    }
  }

  // ── ★★ 联动真的通了：点图旁边那一行 → 下面按他筛 ──────────
  /**
   * ★ 这一条是这次改动的**核心断言**，而原来的探针完全没测联动。
   *
   * 用户反馈的原话是「我点个图谱的点我很难感知到下面会有筛选的感觉」——
   * 而代码上联动**是通的**（`dashboard-module.tsx` 的 `entityFocus`）。
   * 也就是说这是一个"通了但看不见"的联动，而那与"根本没通"在截图上
   * 长得一样。所以要同时锁两件事：
   *   ① 点完之后事实列表标题里出现**那个人的名字**（联动真的通）；
   *   ② 联动带从提示句变成「正在看 … 的事实」（联动**看得见**）。
   *
   * ★ 名字全程留在页内，不回传、不打印。
   *
   * 邻居名是真实人名（本机图库），而 `check:no-local-data` 那道门禁
   * 就是在挡这个。所以比对写在 `evaluate` 的表达式里，只把
   * 布尔结果与一个脱敏长度带回来 —— 断言强度不变，名字不出机器。
   */
  const linkage = await evaluate(`(() => {
    const rows = [...document.querySelectorAll("li > button[title]")].filter((n) =>
      n.className.includes("rounded-[var(--radius-sm)]"),
    )
    const row = rows[0]
    if (!row) return { clicked: false }
    // 名字是那一行里 flex-1 的那个 span（类型色点在它左边、次数在右边）
    const nameNode = [...row.querySelectorAll("span")].find((n) =>
      n.className.includes("flex-1"),
    )
    const name = (nameNode?.textContent ?? "").trim()
    if (name === "") return { clicked: false }
    row.click()
    // 名字只留在闭包里 —— 下一步比对也在页内做
    window.__mycontextProbePickedName = name
    return { clicked: true, nameLength: name.length, rowCount: rows.length }
  })()`)

  if (linkage?.clicked !== true) {
    problems.push("邻居列表里点不到任何一行 —— 联动的入口没了")
  } else {
    await sleep(2500)
    const after = await evaluate(`(() => {
      const name = window.__mycontextProbePickedName ?? ""
      const text = document.body.innerText
      /**
       * ① 事实列表标题带上了他的名字（zh 的 factsAbout 是
       *    「关于「X」的 N 条事实」）—— 这是"下面真的按他筛了"。
       * ② 联动带变成实心状态带（role=status 的那一条），
       *    且里面也有他的名字 —— 这是"这件事看得见"。
       */
      const bridge = document.querySelector('[role="status"]')
      const bridgeText = (bridge?.textContent ?? "").trim()
      return {
        titleHasName: text.includes("关于「" + name + "」的"),
        bridgeIsActive: bridgeText.includes("正在看") && bridgeText.includes(name),
        // 提示句必须**换掉**（两条同时在场等于没切换）
        hintGone: !text.includes("点图上任意一个点"),
        // 清除筛选的出口还在（否则用户被锁在这个筛选里）
        hasClear: bridgeText.includes("看全部"),
      }
    })()`)
    if (after?.titleHasName !== true) {
      problems.push("点了邻居那一行，事实列表标题没带上他的名字 —— 联动没通")
    }
    if (after?.bridgeIsActive !== true) {
      problems.push("联动带没变成「正在看 … 的事实」—— 联动通了但用户看不见")
    }
    if (after?.hintGone !== true) {
      problems.push("选中之后那句「点图上任意一个点」还在 —— 联动带没切换状态")
    }
    if (after?.hasClear !== true) {
      problems.push("联动带上没有「看全部」—— 用户被锁在这个筛选里出不来")
    }
    if (after?.titleHasName === true && after?.bridgeIsActive === true) {
      console.log(
        `  联动通了：点邻居列表第 1 行（共 ${linkage.rowCount} 行）→ ` +
          `事实标题与联动带都带上了那个名字（${linkage.nameLength} 字，按门禁不外传）`,
      )
    }
  }

  if (problems.length > 0) {
    console.error("\n★ 探针发现问题：")
    for (const p of problems) console.error(`  · ${p}`)
    process.exit(1)
  }
  console.log("\n仪表盘一页装下了全部：分身状态 + ego 图 + 邻居排名 + 可检索的事实，数字非零。")
} finally {
  socket.close()
}
