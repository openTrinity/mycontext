/**
 * VAULT v22 — 剥掉已落库消息里那层**富文本信封**。
 *
 * ## 症状
 *
 * UI 上把一串 JSON 直接显示成消息正文，形如
 * `{"textContent":{"text":<正文>},"contentType":<数字>}`。
 *
 * ## 根因
 *
 * `content` 实测有两种形态，同一次调用的同一页里**混着出现**（一个 raw payload
 * 里 47 条包裹 + 1 条明文）。解析层首版直接把 `content` 当正文，
 * 于是包裹那部分整条 JSON 进了 `content_text`。详见
 * `message-parse.ts::unwrapRichContent` 的注释。
 *
 * 这**不是**某个 dws 版次引入的差异：闭源版与开源版采的库里都有
 * （实测一个真实库里 863 条，跨度数月），只是一直没被注意到。
 *
 * ## 为什么必须迁移历史数据
 *
 * 修解析器只影响**此后**采集的消息。已落库这些行的代价是持续的：
 * · UI 上一直显示 JSON；
 * · 它们**照常参与蒸馏** —— 其中约百条是本人消息（`is_self=1`），
 *   等于画像里混进上百条"说话像 JSON"的样本。
 *
 * ## SQL 判据与解析器保持一致（保守）
 *
 * 只处理「以 `{"textContent"` 开头、且能定位到内层 `"text":"…"`」的行。
 * 用 SQLite 的字符串函数而不是 JSON 函数：`json_extract` 要求整列是合法 JSON，
 * 而这一列绝大多数是纯文本，一条不合法就整句报错。
 *
 * `instr`/`substr` 的做法：
 *   找 `"text":"` 之后的内容，到**最后**一个 `"}` 之前 —— 内层 text 里可能
 *   含转义引号，取最后一个闭合点比取第一个稳。剥完再把 `\n` `\"` 反转义。
 *
 * ⚠️ 剥不出来的行**原样留着**（`WHERE` 里的条件不满足就不动它）：
 * 宁可漏剥一条（表现是 UI 上一条难看的消息）也不能剥错 ——
 * 把正文改写成别的东西是不可逆的语料污染。
 */
export const VAULT_0022_UNWRAP_RICH_CONTENT = `
UPDATE messages
   SET content_text = replace(
         replace(
           replace(
             substr(
               content_text,
               instr(content_text, '"text":"') + 8,
               length(content_text)
                 - (instr(content_text, '"text":"') + 8)
                 - (length(content_text) - instr(content_text, '"}') + 1)
                 + 1
             ),
             '\\n', char(10)
           ),
           '\\"', '"'
         ),
         '\\\\', '\\'
       )
 WHERE content_text LIKE '{"textContent"%'
   AND instr(content_text, '"text":"') > 0
   AND instr(content_text, '"}') > instr(content_text, '"text":"');
`
