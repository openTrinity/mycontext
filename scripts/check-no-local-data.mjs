#!/usr/bin/env node
/**
 * 门禁：**本地/用户数据不得进 git**。
 *
 * ## 为什么必须是门禁而不是"注意一下"
 *
 * 这一条已经真的发生过。2026-07-30 审计发现已推送的 `origin/main` 里有
 * **3 个真实 `openConversationId`**（逐个在本地 vault 里核对过确实存在），
 * 以及若干真实同事姓名，来源是"照真实响应写 fixture"这个本来正确的做法
 * 漏了脱敏那一步。
 *
 * ★ 顺带一个自证：这段注释里原本抄了一个真实 cid 当例子，
 * 结果本脚本第一次跑就把**自己**报了出来。举例也不能用真值 ——
 * 这正说明"拿真实值去比对"这个判据是对的。
 *
 * 泄漏的形态与正常代码**完全一样** —— 一个 base64 串看不出它是真的还是
 * 编的，所以只有拿本地库去比对才能发现。而 review 时没人会去比对。
 *
 * ## 判据：与**本地 vault** 逐个比对
 *
 * 不用正则猜"像不像真 ID"（`cid` 开头的编造串会误报，编号型真 ID 会漏报），
 * 而是直接读本地 vault 的 `conversations` / `messages`，
 * 拿真实值去已跟踪文件里搜。真实值在那里 = 泄漏，没有歧义。
 *
 * 没有 vault 时**跳过而不失败**：同事的机器上可能还没登录过，
 * 而门禁在那种环境下红了只会教人忽略它。CI 上同理。
 *
 * ## 白名单只放"确认过的假阳性"
 *
 * 短字符串（`lyz` 出现在 `analyze` 里、`Ric` 出现在 `fldRichId` 里）
 * 与钉钉自带的系统会话名（`工作通知` / `会议室预订`）不是个人数据。
 * 每一条都写清了为什么 —— 白名单不写理由等于给后来的人一个后门。
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"

const root = resolve(import.meta.dirname, "..")
const require = createRequire(import.meta.url)

/**
 * 确认过的假阳性。
 *
 * 判据是"这个串在库里恰好也是某个显示名，但文件里那处不是它" ——
 * 每条都核对过上下文。
 */
const ALLOWLIST = new Set([
  // `lyz` 出现在 "minirag_query2kwd (query_analyze_prompt.py" 里
  "lyz",
  // `Ric` 出现在 aitable 的 `fldRichId` 字段名里
  "Ric",
  // 钉钉自带的系统会话名，不是个人数据（vendor 文档里大量出现）
  "工作通知",
  "会议室预订",
  "待办助手",
  /**
   * ★ 平台级系统服务的名字，且**被 SQL 直接匹配** —— 不能化名。
   *
   * `persona_conversation_exclusions` 那个视图靠标题把系统助手排除掉
   * （`LIKE '%助手'` / `GLOB '公益[0-9]*小时'`，见 v13/v15）。
   * 而对应的测试 fixture 必须字面命中那些 pattern，否则它验的是
   * "一个不会被匹配的标题没被排除" —— 一条永远绿的空用例。
   *
   * 这几个与上面三个同类：全公司每个人的钉钉里都有，不是个人数据。
   * 判据是"换个人也一样" —— 同事姓名与私聊标题不满足它，仍然要拦。
   */
  "日历助手",
  "BuildBot",
  "公益3小时",
  /**
   * ★ 确认过的假阳性：这三个是英文短词/上游商标，恰好也是某 vault 的显示名。
   *
   * · `mini` —— 出现在 "minimum" / "mini-batch" 里（多处代码与 vendor 文档）；
   * · `Grace` —— 出现在 `replayGraceMs` 这个字段名里（agent-runtime）；
   * · `MuleRun` —— 只在 `kl-graph/`（上游，我们不改）里作示例实体名出现，
   *   而随包分发的那份 skill 已由 `sync:kl-skill` 净化（见 check:kl-skill-sync）。
   * 判据同上："换个人也一样" —— 这三个都不是个人数据。
   */
  "mini",
  "Grace",
  "MuleRun",
  // `Testing` —— 出现在 en/settings.json 的 "Testing…" 按钮文案里，是 UI 字符串，
  // 恰好也是某 vault 的显示名。同类假阳性：换个人也一样。
  "Testing",
  /**
   * ★ 中文技术词，恰好也是某 vault 的显示名（两字花名）。
   *
   * `前向` 只出现在 `scripts/check-migration-checksums.mjs` 的注释里，
   * 写的是「**前向**保护由 ① 承担」——「前向兼容」这个意义上的技术词，
   * 与人无关。判据同上："换个人也一样"。
   *
   * ★ 这类两字中文词会越来越多地误命中：`CJK_NAME_MIN_LENGTH` 是 2，
   * 而两个汉字的技术词（前向 / 增量 / 水位 …）在本仓库的中文注释里到处都是。
   * 加白名单时必须把**出现位置连同上下文**写下来，否则下一个人无法复核
   * ——「某处出现过」不足以证明它不是人名。
   */
  "前向",
  /**
   * ★ `以行` —— **跨词边界的切片**，与上面 `不开`/`两半` 那一批同类。
   *
   * 唯一命中在 `apps/desktop/src/renderer/features/persona/channel-emoji.ts:230`
   * 的注释里：「所**以行**为上等同于"不认识"」——「所以」+「行为」的相邻两字，
   * 不是一个词，更不是人名。判据同上："换个人也一样"。
   */
  "以行",
  /**
   * ★ `起起` —— **叠词动词的相邻两字**，与上面 `以行` 同类。
   *
   * 唯一命中在 `apps/desktop/src/main/services/data-plane.service.ts:235`
   * 的注释里：「`attach` 重跑一遍把它们**起起**来」——「起起来」这个
   * 「把 X 起起来」的口语说法，是动词不是人名。
   *
   * ★ 复核方式（下一个人要能重做）：
   * `grep -n 起起 apps packages scripts tests` 只有那一处，且它在一句
   * 描述"未绑身份时挂库但不起定时器"的注释里。判据同上："换个人也一样"。
   */
  "起起",
  /**
   * ★ 英文技术词，恰好也是某 vault 的显示名（花名）。逐个核对过上下文：
   *
   * · `Mark` —— 只出现在 `Markdown` / `brand-mark` / `markdown-body` 这类
   *   标识符里（实测 20 处命中，`grep -o "Mark[a-zA-Z]*"` 全是 `Markdown`）；
   * · `Pipe` —— 只出现在 `pipeline` / `Pipeline` 里（实测 10 处，多在 kl-graph）。
   *
   * 判据同上面几条："换个人也一样" —— 这两个词在任何同类代码库里都会出现，
   * 与是谁的 vault 无关。而把它们当泄漏会逼人去改 `Markdown` 这种标识符，
   * 那只会教人忽略这个门禁。
   */
  "Mark",
  "Pipe",
  /**
   * ★ `Alex` —— 同类假阳性，但理由与上面两个略不同，所以单独一条。
   *
   * 命中的 2 处都在**人名截断的示例**里（`张小明 Alexis（主用钉）`，
   * 用于验证长显示名的 truncate 行为）—— 那是化名，不是真人。
   *
   * ⚠️ 代价要写明：真有同事叫 Alex 时，门禁不再对**这个名字**报警。
   * 可接受的理由与文件头一致 —— 4 字母英文名的撞词率高到会让门禁长期
   * 红着，而"长期红着的门禁等于没有门禁"。
   */
  "Alex",
  /**
   * ★ `Sunny` —— 命中在**第三方依赖里的模型清单**（`vendor/python/.../litellm`
   * 的 huggingface 模型名列表，形如 `Sunnydx/BillCipherBot`），是别人仓库的
   * 副本，不是我们写的内容。
   *
   * 同类判据："换个人也一样" —— 那份清单在任何人的 clone 里都一样。
   * （原先这条注释写的是 `vendor/dws/workspace` 下的上游文档，那个目录
   * 已随 dws 改走 npm 而删除；重新 grep 确认了真实命中位置。）
   */
  "Sunny",
  /**
   * ★★ 以下是**放宽中文名长度下限之后**新出现的假阳性（见 CJK_NAME_MIN_LENGTH）。
   *
   * 把下限从 4 降到 2 让门禁第一次能看见中文姓名，代价是 2 字中文串会
   * 大量撞上普通词 —— 因为**花名本来就常常取自普通词**。逐条核对过命中上下文，
   * 全部是中文行文里的正常词组，与"谁的 vault"无关（判据仍是"换个人也一样"）：
   *
   * · `容易` / `健康` / `明明` / `彼此` / `一位` / `眼镜` —— 「最容易被忽略的一条」
   *   「kl 明明健康地跑在 8200」这类注释行文；
   * · `不开` / `不相` / `两半` / `为新` / `得清` / `然为` / `里未` / `可原` /
   *   `可明` / `不流` / `单从` / `行单` / `行一` / `敛一` / `与仪` / `关关` /
   *   `道意` / `时痕` / `方中` / `方安` / `宽居` / `游目` / `述而` / `修辞` /
   *   `词元` / `有运` —— 都是**跨词边界的切片**：「两半刻意分开」「表单从库里回填」
   *   「每行一个 JSON」「收敛一次」「它与仪表盘」「限宽居中」「不是修辞」等；
   * · `库克` —— 出现在 `把算法团队的仓库克隆到 ~/gits/kl-graph`（仓库**克**隆）;
   * · `张超` —— 出现在 `单张超 2MB 的跳过`（单张图片**超**过 2MB）;
   * · `卫昭` —— 只出现在 `kl-skill-sanitize.mjs` 的**化名值** `卫昭明` 里，
   *   那正是脱敏后的结果，不是泄漏源；
   * · `小王` / `王强` / `小明` / `李强` —— 这几个是仓库里**刻意选的占位名**
   *   （测试与文案里的「示例人」），恰好也是某 vault 里的花名。
   *   留着它们比换掉更好：换成别的名字仍然可能撞上另一个人，
   *   而"明显是占位名"这个性质本身就是脱敏的目的。
   * · `钉钉` —— 渠道产品名（106 处），是**组织名**列撞上的：某 vault 的
   *   `corp_name` 恰好就是渠道自带的默认组织名。它不是个人数据。
   */
  "容易",
  "健康",
  "明明",
  "彼此",
  "一位",
  "眼镜",
  "不开",
  "不相",
  "两半",
  "为新",
  "得清",
  "然为",
  "里未",
  "可原",
  "可明",
  "不流",
  "单从",
  "行单",
  "行一",
  "敛一",
  "与仪",
  "关关",
  "道意",
  "时痕",
  "方中",
  "方安",
  "宽居",
  "游目",
  "述而",
  "修辞",
  "词元",
  "有运",
  "库克",
  "张超",
  "卫昭",
  "小王",
  "王强",
  "小明",
  /**
   * ★★ 以下 5 个是 **`kl-graph/`（上游算法仓，本仓库不改它）** 里的占位名，
   * 恰好也是某 vault 的显示名。逐个核对过命中位置：
   *
   * · `李强` / `杨帆` —— `README.md` 的命令示例（`./kl path "李强" "杨帆"`）
   *   与 `tests/test_mention_extraction.py` 的 @提及解析固件；
   * · `李娜` —— `tests/test_loader_context_rendering.py` 的长引用截断固件
   *   （`"@李娜 [图片消息] " + "很长的内容" * 80`）、`ingest/pipeline.py` 与
   *   `query/query_rewrite.py` 的 docstring 示例；
   * · `刘洋` —— `test_mention_extraction.py` 的嵌套括号用例
   *   （`_clean_mention("刘洋(刘洋)")`）；
   * · `Chris` —— `ingest/llm_extractor.py` 的英文名示例。
   *
   * 判据与上面那批占位名一致："换个人也一样" —— 这些固件在任何人的 clone 里
   * 都长这样，与是谁的 vault 无关。而它们所在的目录是上游代码，
   * 本仓库不改（同 `MuleRun` 那条的处理）。
   *
   * ⚠️ 代价要写明：真有同事叫这几个名字时，门禁不再对**这些名字**报警。
   * 可接受的理由同文件头 —— 长期红着的门禁等于没有门禁。
   */
  "李强",
  "杨帆",
  "李娜",
  "刘洋",
  "Chris",
  "钉钉",
  /**
   * ★ 同一类假阳性：**中文注释里的词被切断**后恰好等于某 vault 的花名。
   *
   * 这一批是在一次全仓门禁复跑里浮出来的（172 处命中，全部落在
   * 我们自己写的中文注释上）。逐个核对过上下文，每一个都能指出它
   * 真正属于哪个词 —— 也就是说这些串在文件里根本不是"一个名字"：
   *
   * · `程中` —— "流式过程**中**"（`过程中` 被切开）；
   * · `明与` —— "声**明与**执行器"；
   * · `时静` —— "那**时静**默重试"、"未登录**时静**默 no-op"；
   * · `有明` —— "终态、**有明**确文案"；
   * · `列里` —— "消息仍留在队**列里**"；
   * · `逻辑` —— "判定**逻辑**"（91 处，最常见的技术词之一）；
   * · `拦截` —— "混合内容**拦截**"、"PAT **拦截**"；
   * · `毕竟` / `达方` —— 同类的连词与词尾切断。
   *
   * 判据与上面几批一致："换个人也一样" —— 这些词出现在这里的原因是
   * 中文技术写作，与是谁在用这台机器无关。把它们化名反而会把注释写坏。
   *
   * ★ 代价照 `CJK_NAME_MIN_LENGTH` 那段注释说的接受：2 字中文必然有噪音，
   * 而漏掉一个真名不可逆。所以是"逐个确认后放行"，不是"把下限调回 4"。
   */
  "毕竟",
  "程中",
  "达方",
  "拦截",
  "列里",
  "逻辑",
  "明与",
  "时静",
  "有明",
  /**
   * ★ 第二批，同一成因（中文注释里的词被切断）。各自的归属词：
   *
   * · `方程` —— "从超椭圆**方程**直接采样"；
   * · `了行` —— "是否真的改到**了行**"；
   * · `前风` —— "不匹配当**前风**格的键"；
   * · `上白` —— "没有任何叫得**上白**名单的条件"；
   * · `少东` —— "它掌握了我多**少东**西"；
   * · `言可` —— "断**言可**能命中一句注释"；
   * · `明合` —— "所以它能证**明合**并真的发生了"；
   * · `新世` —— "**新世**界：干活的就是 server 自己"；
   * · `正中` —— "塞一条消息落在空洞**正中**间"；
   * · `意归` —— "所有来**意归**到 `other_ask`"（vendor 上游文档）。
   *
   * ★★ 与它们一起被报出来的另外两个命中**没有**进白名单 ——
   * 那两个出现在 fixture 与断言里、形态就是"一个人名"，
   * 而不是被切断的词。按 CLAUDE.md「不确定是真的还是编的就当成真的」，
   * 它们已改成另外的化名（保留长度与字符集）。
   * 这条边界就是这份白名单的判据：**是词的碎片就放行，是名字就换掉。**
   *
   * ★ 注意这里刻意**不写**那两个串本身 —— 它们撞的是本机 vault 的真花名，
   * 写进注释等于把门禁刚拦下来的值又请回仓库（第一版这么写过，
   * 于是门禁下一轮把这个文件自己报了出来，那正是它该做的事）。
   */
  "方程",
  "了行",
  "前风",
  "上白",
  "少东",
  "言可",
  "明合",
  "新世",
  "正中",
  "意归",
  /**
   * ★ `Carol` —— 英文占位名三件套 `Alice` / `Bob` / `Carol` 的第三个，
   * 只出现在 `kl-graph/`（上游算法仓，本仓库不改）的单测 fixture 里
   * （`Entity(name="Carol")`、`entity_id_from_name("Carol")`、
   * `get_entity_by_name("Carol")`）。它恰好也撞上某 vault 的显示名，
   * 但它在文件里是**测试占位**、不是谁的数据 —— 判据同上：
   * "换个人也一样"，Alice/Bob/Carol 在任何人的 clone 里都长这样。
   *
   * ★ 与那两个**中文真名**不同（它们在脱敏映射表里、已在
   * `test_global_search_cli.py` 换成同字数化名）：`Carol` 是通用英文占位。
   * 这条边界仍是这份白名单的判据：**通用占位放行，真名换掉。**
   *
   * ★ 刻意**不写**那两个真名本身 —— 写进注释等于把门禁刚拦下来的值又
   * 请回仓库（本文件上面那批注释就栽过：写了真串，下一轮门禁把自己报了出来）。
   */
  "Carol",
])

/** 太短的串误报率过高（两三个字在任何中文文档里都会撞上）。 */
const MIN_LENGTH = 4

/**
 * ★★ 中文姓名的**单独判据** —— 补的是一个让门禁对中文名几乎完全失明的缺口。
 *
 * 上面的 `MIN_LENGTH = 4` 对付的是英文短词撞词（`lyz` 在 `analyze` 里），
 * 那个理由本身没错。但它顺带把**2~3 字的中文姓名整类**排除掉了 ——
 * 而中文名绝大多数正好是 2~3 字。也就是说这个门禁最该防的那一类数据
 * （同事姓名、本人姓名）恰好是它看不见的一类。
 *
 * 实测后果：一次开源前的审计在已跟踪文件里找到本人姓名（出现在
 * `tests/unit/store/self-identity-guard.test.ts` 的 4 处）与若干真实同事名，
 * 而门禁**全绿**。它比对了 10 万个值，其中一个都不是这些名字。
 *
 * 判据分两档而不是简单把 MIN_LENGTH 降到 2：
 *
 * · 纯中文串放宽到 2 字（`CJK_NAME_MIN_LENGTH`）；
 * · 含 ASCII 的串仍然要 4 字（英文短词撞词率太高，降下来门禁会长期红）。
 *
 * 代价要写明：2 字中文串会撞上普通词（`健康` / `容易` / `明明` 都可能
 * 恰好是某人的花名），于是命中里必然有噪音。这个代价是**故意**接受的 ——
 * 漏掉一个真名的代价不可逆，而多看几行误报只是麻烦。误报逐个确认后
 * 进 `ALLOWLIST` 并写清理由。
 */
const CJK_NAME_MIN_LENGTH = 2

/** 纯中日韩字符（不含 ASCII）—— 这类串才享受放宽后的长度下限。 */
const CJK_ONLY = /^[㐀-䶿一-鿿぀-ヿ]+$/

/** 这个值够不够长到值得比对。 */
function longEnough(text) {
  return text.length >= (CJK_ONLY.test(text) ? CJK_NAME_MIN_LENGTH : MIN_LENGTH)
}

/**
 * 要找的 userData 目录名。
 *
 * ★★ 含**改名前**的旧目录名，这一条是踩到之后加的。
 *
 * 全量 rebrand 把 `resolveAppName` 从 `Inklings*` 改成 `MyContext*`，
 * 而门禁这边跟着改了之后就**再也找不到本机的 vault** —— 因为盘上那三个目录
 * （`Inklings` / `InklingsDev` / `InklingsDevelop`）是改名**之前**跑出来的，
 * 里面装着真实聊天数据。
 *
 * 于是门禁打印"本机没有 vault（未登录过应用）"然后 `exit 0`。
 * 那正是这个文件开头警告过的形态：**它最该工作的时刻恰好是它静默失效的时刻**
 * —— 一次把仓库推去开源之前的检查，报告成功，而比对集是空的。
 *
 * 旧名字必须一直留着：用户不会因为我们改了品牌就把老数据删掉，
 * 而"老目录里的真实数据"与"新目录里的"同样不能进 git。
 */
const APP_DIR_NAMES = [
  "MyContextDevelop",
  "MyContextDev",
  "MyContext",
  // ↓ rebrand 之前的目录名（盘上仍然有，且装着真实数据）
  "InklingsDevelop",
  "InklingsDev",
  "Inklings",
]

/**
 * 本机**全部** vault 的路径。
 *
 * ★★ 返回全部而不是第一个 —— 这一条是踩到之后改的。
 *
 * 原来是 `findVault()`：命中第一个就 return。而本机有 4 个 vault
 * （3 个旧目录 + 1 个新目录，各自跑过不同时期的数据），单个 vault 只能提供
 * 460~876 个比对值，**合并起来是 3149 个**。
 *
 * 后果是真的漏了：`tests/fixtures/dingtalk-real-payloads.ts` 里有 4 个真值
 * （一个 37 字符的 openDingTalkId、两个真实 cid、一个真实群名），
 * 它们只存在于**第二个** vault 里 —— 门禁拿第一个 vault 比，报「通过」。
 * 而那个文件的头注释还写着"已脱敏"。
 *
 * 「只比一个库」是个隐蔽的判据缺口：它不报错、不跳过，就是**看得比你以为的少**。
 */
function findAllVaults() {
  const appSupport = join(homedir(), "Library", "Application Support")
  const found = []
  for (const appName of APP_DIR_NAMES) {
    const vaultsDir = join(appSupport, appName, "vaults")
    if (!existsSync(vaultsDir)) continue
    for (const entry of readdirSync(vaultsDir)) {
      const candidate = join(vaultsDir, entry, "core.sqlite")
      if (existsSync(candidate) && statSync(candidate).size > 0) found.push(candidate)
    }
  }
  return found
}

const dbPaths = findAllVaults()
if (dbPaths.length === 0) {
  console.log("本地数据泄漏检查跳过：本机没有 vault（未登录过应用）")
  process.exit(0)
}

/**
 * ★ 到了这里 vault 是**存在**的 —— 于是"打不开"必须是红的，不能跳过。
 *
 * 这一条是踩到之后改的。原本 ABI 不匹配（刚跑过 `pnpm dev`，模块还是
 * Electron ABI）时打一行"跳过"就 `exit 0`，理由是"那不是代码问题"。
 * 理由本身没错，但结论错了：
 *
 * ```
 * 本地数据泄漏检查跳过：打不开 vault（The module '/Users/…/node_mo）
 * ```
 *
 * 这行字出现在**一次提交前的最后一道检查**里，而它的退出码是 0。
 * 也就是说：本机有真实数据、门禁没跑、命令报告成功。而这个门禁的
 * 全部意义就是挡住那次提交 —— 它最该工作的时刻，恰好是它静默失效的时刻。
 *
 * 「没有 vault」跳过是对的（同事机器上没登录过，无从比对）；
 * 「有 vault 但打不开」是**这台机器上门禁失效**，必须让人看见。
 * 报错里直接给出修法，因为它只有一个原因与一个解。
 */
let Database
try {
  Database = require("better-sqlite3")
} catch (error) {
  console.error(
    "✗ 本地数据泄漏检查**没能跑起来**：加载 better-sqlite3 失败" +
      `（${error instanceof Error ? error.message.slice(0, 80) : "unknown"}）\n` +
      "  本机有 vault，所以这不能当作通过 —— 先跑 `node scripts/rebuild-node.mjs`。",
  )
  process.exit(1)
}

/**
 * 从**所有** vault 取真实标识，合并成一份。
 *
 * 每一类都是"出现在文件里就等于泄漏"的东西。
 * 逐个库累加而不是只读一个：合并后 3149 个值，单库只有 460~876
 * （漏掉的那 4 个真值只存在于第二个库里，见 findAllVaults 的注释）。
 */
function collect() {
  const out = new Map()
  const add = (kind, value) => {
    if (typeof value !== "string") return
    const text = value.trim()
    if (!longEnough(text) || ALLOWLIST.has(text)) return
    if (!out.has(text)) out.set(text, kind)
  }

  for (const dbPath of dbPaths) {
    let db
    try {
      db = new Database(dbPath, { readonly: true })
    } catch (error) {
      console.error(
        "✗ 本地数据泄漏检查**没能跑起来**：打不开 vault" +
          `（${error instanceof Error ? error.message.slice(0, 80) : "unknown"}）\n` +
          "  常见原因是 better-sqlite3 还是 Electron ABI（刚跑过 pnpm dev）——\n" +
          "  跑 `node scripts/rebuild-node.mjs` 再来。本机有 vault，跳过等于门禁失效。",
      )
      process.exit(1)
    }
    /**
     * ★ 逐条查询各自 try —— 不同 vault 的 schema 版本不同。
     *
     * 实测本机 4 个 vault 里有一个还没有 `conversations` 表（它是更早的迁移
     * 版本跑出来的，只建到一半就没再用过）。一条 `no such table` 让整个门禁
     * **崩溃退出**，而它本该继续去查其余三个库 —— 那比"少查一个库"糟得多：
     * 崩溃时一个结论都给不出来。
     *
     * 判据是"能查到的就查"：缺表说明这个库里没有那一类数据，不是错误。
     */
    const each = (sql, handle) => {
      try {
        for (const row of db.prepare(sql).all()) handle(row)
      } catch {
        // 这个 vault 的 schema 版本没有这张表/列 —— 跳过它，继续查别的
      }
    }
    try {
      each("SELECT external_id, title FROM conversations", (row) => {
        add("会话 ID", row.external_id)
        add("会话标题", row.title)
      })
      each("SELECT DISTINCT sender_external_id, sender_display_name FROM messages", (row) => {
        add("发送者 ID", row.sender_external_id)
        add("发送者显示名", row.sender_display_name)
      })
      /**
       * ★ 原始响应留档里的标识 —— 补的是一个**真实漏过的**类别。
       *
       * 上面几条只查规范化后的表，而那些表**不存每一个**渠道字段。
       * 具体漏掉的是 `ownerOpenDingtalkId`：它出现在会话列表响应里、
       * 从不入库，所以"拿库里的值去比对"这个判据看不见它。
       *
       * 实测后果：`tests/fixtures/dingtalk-real-payloads.ts` 里曾有
       * **2 个真实 `ownerOpenDingtalkId`**（其中一个在本机 50 个会话上
       * 都是同一个真值），而门禁全绿。那正是本文件头描述的同一类事故
       * 又发生了一次 —— 上一次修的是"没去比对"，这次是"比对源不全"。
       *
       * `raw_records.payload` 是整页原始 JSON，把它里面出现的所有
       * `D...` / `cid...` / `msg...` 形态的串都收进来。用正则从 JSON 文本里
       * 抓而不是 `JSON.parse` 后遍历：留档的形状随渠道与版本变，
       * 而"这个串长这样"这个判据不依赖结构。
       */
      each("SELECT payload FROM raw_records", (row) => {
        if (typeof row.payload !== "string") return
        for (const match of row.payload.matchAll(
          /"(D[A-Za-z0-9+/=]{12,}|cid[A-Za-z0-9+/=]{8,}|msg[A-Za-z0-9+/=]{8,})"/g,
        )) {
          add("原始响应标识", match[1])
        }
      })
      each("SELECT display_names_json FROM channel_self_identity", (row) => {
        try {
          for (const name of JSON.parse(row.display_names_json)) add("本人姓名", name)
        } catch {
          // 坏 JSON 不影响这条检查
        }
      })
      /**
       * ★★ 组织与本人工号 —— 同一张表上**漏掉的几列**。
       *
       * 上面那条只读了 `display_names_json`，而这张表里的 `corp_id` /
       * `corp_name` / `user_id` 同样是 CLAUDE.md 点名不许入库的标识
       * （corpId、userId）。
       *
       * 实测后果：一次开源前的审计发现真实 `corpId` 出现在 3 处
       * （两处测试断言 + 一处源码注释举例），而门禁**全绿** ——
       * 因为比对集里从来没有这个值。
       *
       * 这与 `raw_records` / `media_assets` 那两条是同一种失效：
       * **比对源不全**（而不是"没去比对"）。三次都是同一个教训 ——
       * 加一类数据进库时要问"门禁扫不扫它"。
       */
      each("SELECT corp_id, corp_name, user_id FROM channel_self_identity", (row) => {
        add("组织 ID", row.corp_id)
        add("组织名", row.corp_name)
        add("本人工号", row.user_id)
      })
      /**
       * ★★ 媒体直链 URL —— 又一个**结构性漏掉**的类别。
       *
       * 实测：机器人图文卡片会把一条**指向对象存储的直链 URL** 塞进
       * `mediaId=` 的位置（见 `extractMedia` 的注释）。那条 URL 的 path 里
       * 带租户与文件标识，是不该出现在仓库里的东西 —— 而写那个修复时，
       * 真实 URL 被直接抄进了注释与测试 fixture。
       *
       * 门禁当时没报，因为它只看会话 / 发送者 / 本人姓名那几类，
       * `media_assets` 完全不在扫描范围内。这与上面 `raw_records` 那条
       * 是同一种失效：**比对源不全**（而不是"没去比对"）。
       *
       * 只收 `http` 开头的：真 mediaId 是不透明串，量大且天然唯一，
       * 全量收进来会让门禁对上万个值做子串搜索、跑成分钟级。
       */
      each(
        "SELECT DISTINCT resource_id FROM media_assets WHERE resource_id LIKE 'http%' LIMIT 2000",
        (row) => add("媒体直链 URL", row.resource_id),
      )
    } finally {
      db.close()
    }
  }
  return out
}

const secrets = collect()

/**
 * 已跟踪文件清单。
 *
 * ★ `maxBuffer` 必须显式给足：默认是 1MB，而 `git ls-files` 的输出会随
 * 仓库文件数线性增长。内置 venv 里补上 periodic 依赖（scipy/sklearn，
 * +2413 个文件）之后就越过了那条线，`execFileSync` 抛 `ENOBUFS` ——
 * 门禁**崩溃**而不是给出结论。那比门禁失败更糟：`pnpm verify` 挂在一个
 * 与本门禁语义无关的缓冲区上，而"有没有把本地数据写进仓库"这个问题
 * 一个字都没回答。给 64MB，留足几个数量级的余量。
 */
const tracked = execFileSync("git", ["ls-files"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter((line) => line !== "")

/**
 * ★ 跳过 `vendor/` 与 `kl-graph/` 里的**二进制**。
 *
 * 那些是第三方产物（dws 可执行文件 22MB），里面出现某个字符串
 * 与我们写没写它无关。文本文件仍然检查 —— 上一轮就是在
 * `kl-graph/CLAUDE.md`（那时还叫 `external/kl-graph/`）里发现了真实同事名。
 */
const TEXT_PATTERN = /\.(ts|tsx|js|mjs|cjs|json|md|py|txt|yml|yaml|sql|html|css)$/

/**
 * ★ 跳过内置 Python 运行时（`vendor/python/`）。
 *
 * 那是**上游 CPython 与第三方包的源码**（~9000 个文件），我们一行都没写。
 * 里面必然出现各种人名（贡献者致谢、AUTHORS 名单、SBOM 的 author 字段、
 * HuggingFace 模型名）。而本门禁的 `MIN_LENGTH` 是 4 —— 本机 vault 里只要
 * 有 4 字母的联系人名，就会撞上这些外国人名的前缀。
 *
 * ★ 这个判断**做过全量审计**，不是推断：把 vault 里全部 272 个敏感值
 * （会话 ID / 标题 / 发送者名 / 本人名）逐个在 8008 个已跟踪的
 * vendor/python 文件里搜过 —— 只有两个 4 字母短名命中共 11 处，
 * 全部是第三方内容（CPython 贡献者、nltk 作者、Rust 库作者、模型名），
 * **其余 270 个值零命中**。也就是说 vendor 里确实没有本地数据，
 * 命中纯粹是短名撞词。
 *
 * 这类命中**与"我们有没有把本地数据写进仓库"无关**，而门禁要防的正是后者。
 * 不跳过的话它会一直红，而"长期红着的门禁"等于没有门禁 —— 真的泄漏
 * 反而会被淹没在噪音里。
 *
 * 同一份判断的先例见上面那段注释（vendor/external 的二进制）：
 * 第三方产物里出现某个字符串，与我们写没写它是两件事。
 */
const VENDOR_PYTHON = /^vendor\/python\//

const findings = []
for (const rel of tracked) {
  if (!TEXT_PATTERN.test(rel)) continue
  if (VENDOR_PYTHON.test(rel)) continue
  const path = join(root, rel)
  if (!existsSync(path)) continue
  let body
  try {
    body = readFileSync(path, "utf8")
  } catch {
    continue
  }
  for (const [value, kind] of secrets) {
    if (body.includes(value)) findings.push({ rel, kind, value })
  }
}

if (findings.length === 0) {
  console.log(
    `本地数据泄漏检查通过：${String(tracked.length)} 个已跟踪文件里没有本地 vault 的真实标识（比对了 ${String(secrets.size)} 个值）`,
  )
  process.exit(0)
}

console.error(`\n✗ 已跟踪文件里发现 ${String(findings.length)} 处**真实本地数据**：\n`)
for (const item of findings.slice(0, 30)) {
  // 只回显前后各 4 个字符：把完整值再打一遍等于在日志里又泄漏一次
  const masked =
    item.value.length <= 8
      ? item.value
      : `${item.value.slice(0, 4)}…${item.value.slice(-4)}（${String(item.value.length)} 字符）`
  console.error(`  ${item.rel}`)
  console.error(`      ${item.kind}：${masked}`)
}
if (findings.length > 30) console.error(`  …还有 ${String(findings.length - 30)} 处`)
console.error(
  [
    "",
    "这些值来自你本机的 vault —— 提交上去等于把真实会话 ID / 同事姓名推到远端。",
    "修法：换成化名，且**保留长度与字符集**（正则要处理的边界不能变）。",
    "确认是假阳性（比如短串撞词）就加进本脚本的 ALLOWLIST，并写清理由。",
  ].join("\n"),
)
process.exit(1)
