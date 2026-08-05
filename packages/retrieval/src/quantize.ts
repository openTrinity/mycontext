/**
 * 向量量化（int8）。
 *
 * ## 为什么一期就默认量化
 *
 * 实测 1024 维 5 万条，单查询：
 *   float32 = **195MB / 35.7ms**
 *   int8    = **49MB / 38.6ms**
 * 内存降到 **1/4 而耗时几乎不变**（+8%）。同样内存预算下常驻上限
 * 从 5 万条提到 **20 万条**。这不是"以后再优化"级别的差异。
 *
 * ## 方案
 *
 * 每行独立 scale（不是全局 scale）：先 L2 归一化，再按 `127/max(|v|)` 缩放。
 * 逐行 scale 让每个向量都用满 int8 的动态范围 —— 全局 scale 会被
 * 个别大范数向量拉低，让其余向量的精度白白损失。
 *
 * 余弦相似度在 L2 归一化后等价于内积，所以检索侧只需要点积，不用再算范数。
 */

/** int8 的正向满量程。用 127 而不是 128：负半轴要对称，避免 -128 溢出。 */
const INT8_MAX = 127

export interface QuantizedVector {
  data: Buffer
  scale: number
  dim: number
}

/**
 * L2 归一化 + int8 量化。
 *
 * @param vector 原始 embedding（float32 语义的 number 数组）
 */
export function quantizeInt8(vector: readonly number[]): QuantizedVector {
  const dim = vector.length
  if (dim === 0) throw new Error("quantizeInt8: 空向量")

  // L2 归一化：量化后的比较用点积，前提是两侧都已归一。
  let sumSquares = 0
  for (const value of vector) sumSquares += value * value
  const norm = Math.sqrt(sumSquares)
  const inverseNorm = norm === 0 ? 0 : 1 / norm

  let maxAbs = 0
  const normalized = new Float64Array(dim)
  for (let index = 0; index < dim; index += 1) {
    const value = (vector[index] ?? 0) * inverseNorm
    normalized[index] = value
    const abs = Math.abs(value)
    if (abs > maxAbs) maxAbs = abs
  }

  // maxAbs 为 0（全零向量）时 scale 取 1：避免除零，且反量化后仍是全零。
  const scale = maxAbs === 0 ? 1 : maxAbs / INT8_MAX
  const data = Buffer.allocUnsafe(dim)
  for (let index = 0; index < dim; index += 1) {
    const scaled = Math.round((normalized[index] ?? 0) / scale)
    // clamp：浮点舍入可能让边界值超出 ±127
    const clamped = scaled > INT8_MAX ? INT8_MAX : scaled < -INT8_MAX ? -INT8_MAX : scaled
    data.writeInt8(clamped, index)
  }

  return { data, scale, dim }
}

/** 反量化回 float（调试与二段精排用；一期不做二段精排）。 */
export function dequantizeInt8(quantized: QuantizedVector): Float64Array {
  const out = new Float64Array(quantized.dim)
  for (let index = 0; index < quantized.dim; index += 1) {
    out[index] = quantized.data.readInt8(index) * quantized.scale
  }
  return out
}

/**
 * 两个 int8 向量的余弦相似度。
 *
 * 因为两侧都已 L2 归一化，点积即余弦；两个 scale 相乘即可还原量纲。
 * 用 `readInt8` 逐个读而不是转成数组：这个函数在 KNN 里会被调 20 万次，
 * 每次分配一个数组会让 GC 压力主导耗时。
 */
export function cosineInt8(
  a: Buffer,
  scaleA: number,
  b: Buffer,
  scaleB: number,
  dim: number,
): number {
  let dot = 0
  for (let index = 0; index < dim; index += 1) {
    dot += a.readInt8(index) * b.readInt8(index)
  }
  return dot * scaleA * scaleB
}

/** float32 存储形态（`quant='float32'` 的行）。保留是为了将来做二段精排。 */
export function encodeFloat32(vector: readonly number[]): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * 4)
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index] ?? 0, index * 4)
  }
  return buffer
}

export function decodeFloat32(buffer: Buffer): Float32Array {
  const out = new Float32Array(buffer.length / 4)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = buffer.readFloatLE(index * 4)
  }
  return out
}
