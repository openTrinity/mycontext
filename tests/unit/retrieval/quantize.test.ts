/**
 * int8 量化。
 *
 * 关注两件事：
 * ① **误差上界**：量化本身有损，但损失必须小到不影响 top-K 排序；
 * ② **与 float32 的 top-K 一致率**：这是"能不能一期就默认量化"的判据。
 *   实测内存 195MB→49MB 而耗时几乎不变，所以只要一致率够高就该默认开。
 */
import { describe, expect, it } from "vitest"
import {
  cosineInt8,
  decodeFloat32,
  dequantizeInt8,
  encodeFloat32,
  quantizeInt8,
} from "@mycontext/retrieval"

/** 确定性伪随机：测试不能依赖 Math.random（否则失败无法复现）。 */
function seededVector(dim: number, seed: number): number[] {
  const out: number[] = []
  let state = seed
  for (let index = 0; index < dim; index += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    out.push(state / 1_073_741_824 - 1) // [-1, 1)
  }
  return out
}

function cosineFloat(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

describe("量化往返", () => {
  it("每维误差在 1 个量化步长内", () => {
    const vector = seededVector(256, 42)
    const quantized = quantizeInt8(vector)
    const restored = dequantizeInt8(quantized)

    // 归一化后再比：量化前做了 L2 归一化，所以要拿归一后的值做基准。
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
    for (let index = 0; index < vector.length; index += 1) {
      const expected = (vector[index] ?? 0) / norm
      const actual = restored[index] ?? 0
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(quantized.scale)
    }
  })

  it("输出字节数 = 维度（1 字节/维，这是 1/4 内存的来源）", () => {
    expect(quantizeInt8(seededVector(1024, 7)).data.length).toBe(1024)
    expect(encodeFloat32(seededVector(1024, 7)).length).toBe(4096)
  })

  it("全零向量不除零", () => {
    const quantized = quantizeInt8(new Array(16).fill(0))
    expect(quantized.data.every((byte) => byte === 0)).toBe(true)
    expect(Number.isFinite(quantized.scale)).toBe(true)
  })

  it("空向量抛错（宁可失败也不写一个 0 维行进库）", () => {
    expect(() => quantizeInt8([])).toThrow()
  })

  it("float32 编解码往返（保留给二段精排）", () => {
    const vector = seededVector(64, 11)
    const decoded = decodeFloat32(encodeFloat32(vector))
    for (let index = 0; index < vector.length; index += 1) {
      expect(decoded[index]).toBeCloseTo(vector[index] ?? 0, 5)
    }
  })
})

describe("相似度精度", () => {
  it("int8 余弦与 float 余弦的绝对误差 < 0.01", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const a = seededVector(512, seed)
      const b = seededVector(512, seed * 31 + 7)
      const qa = quantizeInt8(a)
      const qb = quantizeInt8(b)
      const approx = cosineInt8(qa.data, qa.scale, qb.data, qb.scale, 512)
      expect(Math.abs(approx - cosineFloat(a, b))).toBeLessThan(0.01)
    }
  })

  it("自己与自己的相似度接近 1", () => {
    const vector = seededVector(512, 5)
    const q = quantizeInt8(vector)
    expect(cosineInt8(q.data, q.scale, q.data, q.scale, 512)).toBeCloseTo(1, 2)
  })

  /**
   * ★ 这条是「一期默认量化」的直接依据。
   *
   * 量化有损，但只要 top-K 的**集合**与 float32 一致，
   * 用户感受不到差别 —— 而内存降到 1/4 是实打实的。
   */
  it("top-5 与 float32 完全一致", () => {
    const query = seededVector(512, 999)
    const corpus = Array.from({ length: 200 }, (_, index) => seededVector(512, index + 1))

    const floatRanking = corpus
      .map((vector, index) => ({ index, score: cosineFloat(query, vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((item) => item.index)

    const qq = quantizeInt8(query)
    const int8Ranking = corpus
      .map((vector, index) => {
        const qv = quantizeInt8(vector)
        return { index, score: cosineInt8(qq.data, qq.scale, qv.data, qv.scale, 512) }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((item) => item.index)

    expect(int8Ranking).toEqual(floatRanking)
  })
})
