/**
 * ego 图的**纯数据逻辑**：从图库的原始行拼出「我」周围的子图。
 *
 * ## 为什么单独一个模块
 *
 * Graphin / G6 要 canvas，在 jsdom 里跑不起来 —— 所以组件本身只能靠
 * CDP 探针验。而"取谁、取多少、边怎么算、渠道怎么归"这些**判断**
 * 恰恰是最容易错的部分，它们必须能单测。
 *
 * 于是切开：这里是纯函数（输入原始行，输出子图），组件只负责画。
 * 与仓库既有的分工一致（`dashboard-data.ts` 也是这么切的）。
 *
 * ## ★ 关系是推导出来的
 *
 * 实测图库里 `entity SIMILAR_TO entity` 只有 147 条，而
 * `fact ABOUT entity` 有 9661 条 —— 也就是说"谁和谁有关系"**不能直接查**。
 * 信号是**同一条 fact 里共现**：一条 fact 同时 ABOUT 我和他，
 * 那这条 fact 就是我们之间的一次关联。`weight` = 共现的 fact 数。
 */

/** 一条 `fact -ABOUT-> entity` 的关联行。 */
export interface FactEntityLink {
  factId: string
  entityId: string
}

export interface EntityRow {
  id: string
  name: string
  type: string
  mentions: number
}

/** `fact -STATES-> message` 再 join 到会话所属渠道之后的结果。 */
export interface FactChannel {
  factId: string
  channelId: string
}

/**
 * 一跳邻居的数量上限。
 *
 * ★ 这个上限是**可读性**的要求，不是性能的：实测全图 2170 个实体，
 * 而力导向图在几百个节点以上就变成一团毛线 —— 既看不出结构，
 * 也点不准任何一个节点。24 个是"一屏能看清、且每个都点得到"的量。
 *
 * 被截掉的那些不是丢了信息：它们按共现数排在后面，也就是"偶尔一起
 * 出现过"的那些。真要顺着关系走时去检索页问（那里有 graph walk）。
 */
export const TOP_PEERS = 24

export interface EgoGraph {
  self: { id: string; name: string } | null
  nodes: Array<{
    id: string
    name: string
    type: string
    mentions: number
    hop: number
    channels: string[]
  }>
  edges: Array<{ source: string; target: string; weight: number }>
}

/**
 * 在实体表里认出「我」。
 *
 * ## ★ 判据是**本人身份里的名字**，不是硬编码
 *
 * 名字来自 `channel_self_identity.display_names_json`（钉钉侧的花名，
 * 实测这台机器上是「小周」）。写死一个名字等于把这台机器的巧合
 * 编进产品。
 *
 * 同名时取 `mention_count` 最高的那个：图里可能有同名的两个实体
 * （抽取阶段没消歧完），而"我"必然是提及数最多的那个
 * （实测本人 2658 次，远高于任何同名者）。
 *
 * 找不到返回 null —— 那时 UI 要**明说**"图里还没有你"，
 * 而不是画一张空图（后者看起来像功能坏了）。
 */
export function matchSelfEntity(
  entities: readonly EntityRow[],
  selfNames: readonly string[],
): EntityRow | null {
  const wanted = new Set(selfNames.map((n) => n.trim()).filter((n) => n !== ""))
  if (wanted.size === 0) return null
  let best: EntityRow | null = null
  for (const row of entities) {
    if (!wanted.has(row.name.trim())) continue
    if (best === null || row.mentions > best.mentions) best = row
  }
  return best
}

/**
 * 拼出 ego 图。
 *
 * @param links 全部 `fact -ABOUT-> entity` 行（只需含与我相关的那些 fact，
 *   调用方可以先按我的 fact 集合过滤以省内存）
 * @param entityById 实体表（取名字/类型/提及数）
 * @param factChannels `fact → 渠道`（一条 fact 可能来自多个会话，因此多行）
 */
export function buildEgoGraph(input: {
  self: EntityRow | null
  links: readonly FactEntityLink[]
  entityById: ReadonlyMap<string, EntityRow>
  factChannels: readonly FactChannel[]
  topPeers?: number
}): EgoGraph {
  const { self, links, entityById } = input
  const limit = input.topPeers ?? TOP_PEERS
  if (self === null) return { self: null, nodes: [], edges: [] }

  /** `factId → 该 fact 涉及的实体集合`。共现就是从这里读出来的。 */
  const entitiesByFact = new Map<string, Set<string>>()
  for (const link of links) {
    const set = entitiesByFact.get(link.factId)
    if (set === undefined) entitiesByFact.set(link.factId, new Set([link.entityId]))
    else set.add(link.entityId)
  }

  /** `factId → 渠道集合`。 */
  const channelsByFact = new Map<string, Set<string>>()
  for (const row of input.factChannels) {
    const set = channelsByFact.get(row.factId)
    if (set === undefined) channelsByFact.set(row.factId, new Set([row.channelId]))
    else set.add(row.channelId)
  }

  /** 与我共现的实体 → 共现的 fact 数 + 渠道。 */
  const peerWeight = new Map<string, number>()
  const peerChannels = new Map<string, Set<string>>()
  const selfChannels = new Set<string>()
  /** 我参与的那些 fact —— 二跳（邻居之间的边）只在这个集合里找。 */
  const myFacts: string[] = []

  for (const [factId, members] of entitiesByFact) {
    if (!members.has(self.id)) continue
    myFacts.push(factId)
    const channels = channelsByFact.get(factId)
    if (channels !== undefined) for (const c of channels) selfChannels.add(c)
    for (const other of members) {
      if (other === self.id) continue
      peerWeight.set(other, (peerWeight.get(other) ?? 0) + 1)
      if (channels !== undefined) {
        const set = peerChannels.get(other)
        if (set === undefined) peerChannels.set(other, new Set(channels))
        else for (const c of channels) set.add(c)
      }
    }
  }

  /**
   * 取前 N 个邻居。
   *
   * 排序键第二位是**实体 id**而不是随手的稳定性：共现数相同时
   * 顺序必须确定，否则同一份数据两次渲染会给出不同的图
   * （节点位置会跳，用户会以为数据变了）。
   */
  const peers = [...peerWeight.entries()]
    .filter(([id]) => entityById.has(id))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
  const peerIds = new Set(peers.map(([id]) => id))

  const nodes: EgoGraph["nodes"] = [
    {
      id: self.id,
      name: self.name,
      type: self.type,
      mentions: self.mentions,
      hop: 0,
      channels: [...selfChannels].sort(),
    },
    ...peers.map(([id, weight]) => {
      const row = entityById.get(id)
      return {
        id,
        name: row?.name ?? id,
        type: row?.type ?? "Unknown",
        // 用实体表里的总提及数（节点大小按它），不是共现数（那是边的粗细）
        mentions: row?.mentions ?? weight,
        hop: 1,
        channels: [...(peerChannels.get(id) ?? [])].sort(),
      }
    }),
  ]

  /** 我 ↔ 每个邻居。 */
  const edges: EgoGraph["edges"] = peers.map(([id, weight]) => ({
    source: self.id,
    target: id,
    weight,
  }))

  /**
   * ★ 二跳：邻居**之间**的边。只加边，**不加节点**。
   *
   * 这是 ego 图比一张列表强的地方 —— "这些人之间也在一起做事"
   * 那个结构只有画出来才看得见。加节点的话就又回到毛线团了。
   *
   * 只在我参与的 fact 里找：那保证了这条边确实与我有关
   * （否则会把两个邻居在别处的关系也拉进来，而那不是我的 ego 图）。
   *
   * ## ★ 实测：这一段在当前数据上几乎不产出边，而那是**对的**
   *
   * 抽取阶段产出的 fact 绝大多数只关联 1-2 个实体（实测 856 条里
   * 366 条一个、488 条两个、**只有 2 条**超过两个）。也就是说
   * "邻居之间的边"在这份数据里天然稀疏 —— 这不是 bug，
   * 而是 kl 的 fact 粒度决定的（一条事实通常就是"A 对 B 做了什么"）。
   *
   * 留着这段逻辑的理由：`kl improve`（优化图谱）会补 SIMILAR_TO 与
   * 消歧，之后多实体 fact 会变多；而更重要的是**不能靠造边来让图好看** ——
   * 图上没有边就意味着数据里没有那个关系，那是诚实的。
   */
  const pairWeight = new Map<string, number>()
  for (const factId of myFacts) {
    const members = [...(entitiesByFact.get(factId) ?? [])].filter((id) => peerIds.has(id)).sort()
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const key = `${members[i] ?? ""} ${members[j] ?? ""}`
        pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1)
      }
    }
  }
  for (const [key, weight] of pairWeight) {
    const [source, target] = key.split(" ")
    if (source === undefined || target === undefined) continue
    edges.push({ source, target, weight })
  }

  return { self: { id: self.id, name: self.name }, nodes, edges }
}

/**
 * 节点半径：按提及数**对数**缩放。
 *
 * ★ 线性会让小节点消失：实测本人 2658 次而边缘实体 9 次，差 300 倍 ——
 * 线性映射下后者是一个亚像素的点。对数之后 2658 与 9 的半径差约 3 倍，
 * 既保留了"谁更重要"的信息，又让每个节点都点得到。
 */
export function nodeRadius(mentions: number, hop: number): number {
  const base = hop === 0 ? 26 : 10
  const grow = Math.log10(Math.max(1, mentions) + 1) * 4
  return Math.round(base + grow)
}

/**
 * hover tooltip 的 HTML。
 *
 * ## ★ 为什么这是一个纯函数而不是内联在 G6 的 options 里
 *
 * 它踩过两个坑，**两个都表现为"hover 出一个空白浮窗"而不报错** ——
 * 也就是只能靠在真应用里划过一个节点才发现。抽出来之后它可以单测：
 *
 * ### ① 字段在 `model.data` 里，不在 model 上
 *
 * G6 传给 `getContent` 的是 `getElementData()` 的返回值，即**节点模型**
 * `{id, data, style}` —— 不是我们塞进 `data` 的那一层。实测 dump：
 * `{"id":"b49f…","data":{"name":"孙芳","typeLabel":"人",…},"style":{…}}`。
 * 读 `model["name"]` 全是 `undefined`，于是拼出几个空 div。
 *
 * ### ② 返回的 HTML 必须只有**一个根节点**
 *
 * `@antv/component` 的实现是
 * `const e=document.createElement("div"); e.innerHTML=t; return e.childNodes[0]`
 * —— **只取第一个子节点**。返回三个并列的 `<div>` 时后两个直接丢。
 *
 * 所以：从 `data` 取值 + 包一个根节点。取不到名字时返回**空串**，
 * 让 G6 走 `if(!content) return` 那条路 —— "完全没有 tooltip"
 * 一眼看得出是坏了，而"一个空白浮窗"看起来像渲染层的问题。
 */
export function tooltipHtml(model: Record<string, unknown> | undefined): string {
  if (model === undefined) return ""
  const item = (model["data"] ?? {}) as Record<string, unknown>
  const esc = (value: unknown) =>
    String(value ?? "").replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
    )
  const name = String(item["name"] ?? "")
  if (name === "") return ""
  /**
   * ★ 人名必须转义：这些是**真实人名与系统名**（用户自己的聊天记录），
   * 而这里产出的是 HTML 字符串。一个名字里有 `<` 就会破坏结构 ——
   * 不是安全问题（数据是本机的），但表现是"某些人的 tooltip 是空的"。
   */
  const rows = [
    `<div style="font-weight:600;margin-bottom:2px">${esc(name)}</div>`,
    `<div style="opacity:.7">${esc(item["typeLabel"])} · ${esc(item["mentionsLabel"])}</div>`,
  ]
  if (String(item["channels"] ?? "") !== "") {
    rows.push(`<div style="opacity:.7">${esc(item["channels"])}</div>`)
  }
  // ★ 单一根节点（见上面 ②）—— 并列的兄弟节点会被丢掉
  return `<div style="font-size:12px;line-height:1.5">${rows.join("")}</div>`
}
