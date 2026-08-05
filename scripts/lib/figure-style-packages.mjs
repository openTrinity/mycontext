/**
 * 形象风格 id → npm 包名。**纯数据**，被生成器与漂移门禁共用。
 *
 * ## 为什么这一份要共享，而两个脚本里的**判据**却刻意各写一遍
 *
 * `sync-figure-slots.mjs` 的 `classify` 与 `check-figure-slots-sync.mjs` 的
 * `expected` 是同一套分类逻辑抄了两遍，那是**刻意**的：门禁 import 生成器
 * 再比对，就只能证明"生成器自己前后一致"，改错了判据两边会一起错、门禁照绿。
 *
 * 但这张表不是判据，是**纯数据映射**（id 是我们的驼峰写法、包名是上游的
 * 连字符写法，两者不能互相推导）。抄它带不来任何反证价值，只会新增一个
 * 失效点：加一个风格时漏改一处 —— 而漏改的表现是"门禁只检查了 5 个风格"，
 * 那正是"门禁看起来在工作、实际少保证了一块"的形状。
 *
 * 顺序 = `FIGURE_STYLES` 的顺序（从最像人到最抽象）。
 */
export const STYLE_PACKAGES = {
  notionists: "@dicebear/notionists",
  lorelei: "@dicebear/lorelei",
  micah: "@dicebear/micah",
  funEmoji: "@dicebear/fun-emoji",
  bottts: "@dicebear/bottts",
  thumbs: "@dicebear/thumbs",
}
