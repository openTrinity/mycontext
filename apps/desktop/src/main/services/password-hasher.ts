/**
 * 口令哈希。
 *
 * 用 Node 内建 scrypt：零额外依赖、无 native 编译，参数按 OWASP 推荐下限设置。
 * 藏在 PasswordHasher 接口后，将来换 argon2id 只需替换实现并追加一条迁移
 * （hash_params 已随记录持久化，可按记录识别算法并在登录时透明升级）。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"

const scrypt = promisify(scryptCallback)

export interface PasswordHasher {
  hash(password: string): Promise<{ hash: string; salt: string; params: string }>
  verify(input: { password: string; hash: string; salt: string; params: string }): Promise<boolean>
}

interface ScryptParams {
  algorithm: "scrypt"
  N: number
  r: number
  p: number
  keyLength: number
}

const DEFAULT_PARAMS: ScryptParams = {
  algorithm: "scrypt",
  N: 2 ** 15,
  r: 8,
  p: 1,
  keyLength: 64,
}

function parseParams(serialized: string): ScryptParams {
  const parsed = JSON.parse(serialized) as Partial<ScryptParams>
  if (parsed.algorithm !== "scrypt")
    throw new Error(`不支持的哈希算法：${String(parsed.algorithm)}`)
  return {
    algorithm: "scrypt",
    N: parsed.N ?? DEFAULT_PARAMS.N,
    r: parsed.r ?? DEFAULT_PARAMS.r,
    p: parsed.p ?? DEFAULT_PARAMS.p,
    keyLength: parsed.keyLength ?? DEFAULT_PARAMS.keyLength,
  }
}

async function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  // maxmem 需显式抬高：N=2^15 时默认 32MB 上限会被突破而抛错。
  // promisify 的重载丢失了 options 形态，这里显式断言签名。
  const scryptWithOptions = scrypt as unknown as (
    password: string,
    salt: Buffer,
    keyLength: number,
    options: { N: number; r: number; p: number; maxmem: number },
  ) => Promise<Buffer>

  return scryptWithOptions(password.normalize("NFKC"), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  })
}

export class ScryptPasswordHasher implements PasswordHasher {
  constructor(private readonly params: ScryptParams = DEFAULT_PARAMS) {}

  async hash(password: string): Promise<{ hash: string; salt: string; params: string }> {
    const salt = randomBytes(16)
    const derived = await derive(password, salt, this.params)
    return {
      hash: derived.toString("base64"),
      salt: salt.toString("base64"),
      params: JSON.stringify(this.params),
    }
  }

  async verify(input: {
    password: string
    hash: string
    salt: string
    params: string
  }): Promise<boolean> {
    let expected: Buffer
    let params: ScryptParams
    try {
      params = parseParams(input.params)
      expected = Buffer.from(input.hash, "base64")
    } catch {
      return false
    }
    const actual = await derive(input.password, Buffer.from(input.salt, "base64"), params)
    // 长度不同时 timingSafeEqual 会抛错，先比长度。
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  }
}
