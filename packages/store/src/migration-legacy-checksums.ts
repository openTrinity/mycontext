/**
 * 已发布迁移在历史上出现过的**旧原文 checksum**。
 *
 * ## 这张表在解什么
 *
 * `runMigrations` 的校验拿「库里记的 checksum」与「当前代码算的」比。
 * 判据已经换成 `schemaChecksum`（剥注释后再 hash，见 migration-checksum.ts），
 * 但**旧库里记的是 `rawChecksum`** —— 而 rawChecksum 是不可逆的：
 * 拿着 `777741ec…` 无法反推出「它对应的 schema 是什么」，因此单靠当前代码
 * 判不出这个旧值究竟是「只改了注释」还是「真改了 schema」。
 *
 * 这些常量就是那个缺失的信息：**逐条核对过，这些旧原文的 schema 与当前 SQL 相同。**
 * 命中的记录会被就地收敛成 `schemaChecksum`（一次性），之后走快速路径。
 *
 * ## ★ 它是白名单，不是「对不上就放行」
 *
 * 差别是本质的：没登记的 checksum 仍然会抛 `DB_MIGRATION_FAILED`。
 * 这里只赦免**已确认过的**那几个历史值，而不是把门禁降级成不校验 ——
 * 后者会让「有人真的改了 schema」变成静默通过，那正是这道校验存在的理由。
 *
 * ## ★ 挂在 Migration 上而不是一张 version→checksums 的表
 *
 * 因为 **version 不唯一**：control 与 vault 两套清单各自从 v1 开始，
 * 「v2」既是 `account-vaults` 也是 `raw-normalized`。用 version 当 key 的表
 * 会让 control 的 v2 意外赦免 vault v2 的旧值（反之亦然）——
 * 而这种越界赦免恰好是**静默**的：它不报错，只是少挡了一次。
 * 挂在迁移条目上就没有这个键空间问题，`runMigrations` 也不必知道自己开的是哪套库。
 *
 * ## 加新条目的前提
 *
 * 只有一条判据：`schemaChecksum(当前 sql)` 必须等于那个旧值对应的 schema。
 * 别凭「看起来只是注释」加 —— `tests/integration/store/migration-chain.test.ts`
 * 里有一条测试遍历全部登记项逐一验证，`scripts/check-migration-checksums.mjs`
 * 另外扫全历史 blob 做同样的断言。两者都会挡住加错。
 *
 * 排查旧值来源：`git rev-list --objects --all -- packages/store/src/migrations`
 * 拿到全部历史 blob，对每个算 `rawChecksum`，找出等于库里那个值的那一版。
 */

/**
 * VAULT v2（raw-normalized）—— 那行示例姓名的注释被改过两次。
 *
 * 两条都是脱敏 sweep 之前的版本。本机 4 个 vault 里 3 个记前者、
 * 1 个（当前 dev 库）记后者，所以两条都得在。
 * 对应 schema 均为 `ac7ac75f…`，与当前 SQL 一致。
 */
export const VAULT_0002_LEGACY_CHECKSUMS: readonly string[] = [
  "2aa832d320dd0fd70885a55fbeecaf9c",
  "777741ec11d38f1ec47d85ea44fc3a71",
]

/**
 * VAULT v9（onboarding）—— 注释里的步骤列表曾多一个 `'model'`。
 *
 * 那次是靠把注释还原成 byte-identical 修的，所以代码里已经没有这一版；
 * 但它**写进过库**（中途跑过那个版本的 vault 仍然记着它），因此同样要赦免。
 * 对应 schema `9db81336…`，与当前 SQL 一致。
 */
export const VAULT_0009_LEGACY_CHECKSUMS: readonly string[] = ["8d508cd4d60b683e26d8db4e91ff959a"]
