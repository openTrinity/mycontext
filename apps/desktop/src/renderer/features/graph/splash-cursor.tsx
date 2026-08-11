/**
 * SplashCursor —— 图谱未就绪时的「等待」态背景：一层跟随指针晕开、
 * 空闲时自行流动的流体。还原 React Bits 的 `SplashCursor`。
 *
 * ## ★ 为什么自己写而不是抄 React Bits 的源码
 *
 * 与 `count-up.tsx` / `particle-text.tsx` / `shuffle-text.tsx` 同一个理由：
 * React Bits 是 **MIT + Commons Clause**（"不得单独再分发组件本身"），
 * 本仓库**源码公开**（Elastic License 2.0，可再分发）—— copy 它的文件
 * 会污染授权链。这个效果的内核是一套教科书式的 GPU 流体模拟
 * （Stam 半拉格朗日平流 + Jacobi 压力求解 + 涡度约束），是公开的算法；
 * 照算法自己写 GLSL，不 copy 任何一方的源码文件。不引入新依赖
 * （只用 renderer 已有的 WebGL2）。
 *
 * ## ★ 它是「等待态」的背景，不是主内容
 *
 * 用户还没建好图时会盯着这块看，所以它要**自己动**（空闲时定时自发溅射），
 * 不能只在指针移动时才有反应 —— 一块静止的画布看起来像坏了。
 * 但它是背景：上层照旧压着那句说明文字 + 「建图」按钮（`ego-graph-panel`
 * 里传进来的 children），流体只在它们身后流动。
 *
 * ## ★ 优雅降级（本仓库最忌讳静默失败）
 *
 * · `prefers-reduced-motion` → **根本不初始化 WebGL**，只渲染 children
 *   背后的静态底色（前庭敏感 + 无障碍惯例）；
 * · 拿不到 WebGL2 / 拿不到浮点渲染目标 → 同样退回静态底色，
 *   `onUnsupported` 回调让调用方知道（而不是画一块黑）。
 *
 * ## 参数（用户指定）
 *
 * COLOR = #A855F7（品牌紫）、RAINBOW_MODE = false（不随机换色）、
 * TRANSPARENT = true（alpha 走亮度，压在面板底色上而不是盖一块黑）。
 */
import { useEffect, useRef } from "react"
import { useReducedMotion } from "framer-motion"
import { cn } from "@mycontext/design"

export interface SplashCursorProps {
  className?: string
  /** WebGL2/浮点目标不可用时回调一次（用于诊断，不是必需）。 */
  onUnsupported?: () => void
}

/** 固定溅射色 #A855F7 → 归一化 rgb，再压暗（否则 dye 累积会糊成实心块）。 */
const SPLAT_COLOR = { r: (168 / 255) * 0.18, g: (85 / 255) * 0.18, b: (247 / 255) * 0.18 }

// ── 模拟参数（React Bits SplashCursor 默认档，按小面板略调） ──────────
const SIM_RESOLUTION = 128
const DYE_RESOLUTION = 512
const DENSITY_DISSIPATION = 3.2
const VELOCITY_DISSIPATION = 2.0
const PRESSURE = 0.1
const PRESSURE_ITERATIONS = 20
const CURL = 3
const SPLAT_RADIUS = 0.2
const SPLAT_FORCE = 6000
/** 空闲多久没有指针输入后开始自发溅射（ms）。 */
const IDLE_AFTER_MS = 900
/** 自发溅射的间隔（ms）。 */
const AUTO_SPLAT_EVERY_MS = 1100

interface FBO {
  texture: WebGLTexture
  fbo: WebGLFramebuffer
  width: number
  height: number
  texelSizeX: number
  texelSizeY: number
  attach: (id: number) => number
}

interface DoubleFBO {
  width: number
  height: number
  texelSizeX: number
  texelSizeY: number
  read: FBO
  write: FBO
  swap: () => void
}

const BASE_VERTEX = `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
uniform vec2 texelSize;
void main () {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`

/** 每个片元 shader 的公共头（精度 + 变量声明）。 */
const FRAG_HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 fragColor;`

const COPY_SHADER = `${FRAG_HEAD}
uniform sampler2D uTexture;
void main () { fragColor = texture(uTexture, vUv); }`

const CLEAR_SHADER = `${FRAG_HEAD}
uniform sampler2D uTexture;
uniform float value;
void main () { fragColor = value * texture(uTexture, vUv); }`

const SPLAT_SHADER = `${FRAG_HEAD}
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
void main () {
  vec2 p = vUv - point.xy;
  p.x *= aspectRatio;
  vec3 splat = exp(-dot(p, p) / radius) * color;
  vec3 base = texture(uTarget, vUv).xyz;
  fragColor = vec4(base + splat, 1.0);
}`

const ADVECTION_SHADER = `${FRAG_HEAD}
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;
void main () {
  vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
  vec4 result = texture(uSource, coord);
  float decay = 1.0 + dissipation * dt;
  fragColor = result / decay;
}`

const DIVERGENCE_SHADER = `${FRAG_HEAD}
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  float div = 0.5 * (R - L + T - B);
  fragColor = vec4(div, 0.0, 0.0, 1.0);
}`

const CURL_SHADER = `${FRAG_HEAD}
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  float vorticity = R - L - T + B;
  fragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}`

const VORTICITY_SHADER = `${FRAG_HEAD}
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main () {
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 vel = texture(uVelocity, vUv).xy;
  fragColor = vec4(vel + force * dt, 0.0, 1.0);
}`

const PRESSURE_SHADER = `${FRAG_HEAD}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  float divergence = texture(uDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  fragColor = vec4(pressure, 0.0, 0.0, 1.0);
}`

const GRADIENT_SUBTRACT_SHADER = `${FRAG_HEAD}
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  vec2 velocity = texture(uVelocity, vUv).xy;
  velocity.xy -= vec2(R - L, T - B);
  fragColor = vec4(velocity, 0.0, 1.0);
}`

/** TRANSPARENT：alpha 走亮度，让流体压在面板底色上而不是盖一块黑。 */
const DISPLAY_SHADER = `${FRAG_HEAD}
uniform sampler2D uTexture;
void main () {
  vec3 c = texture(uTexture, vUv).rgb;
  float a = max(c.r, max(c.g, c.b));
  fragColor = vec4(c, a);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (shader === null) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function program(
  gl: WebGL2RenderingContext,
  vertex: WebGLShader,
  fragmentSource: string,
): { prog: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> } | null {
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (frag === null) return null
  const prog = gl.createProgram()
  if (prog === null) return null
  gl.attachShader(prog, vertex)
  gl.attachShader(prog, frag)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  const uniforms: Record<string, WebGLUniformLocation | null> = {}
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(prog, i)
    if (info !== null) uniforms[info.name] = gl.getUniformLocation(prog, info.name)
  }
  return { prog, uniforms }
}

export function SplashCursor({ className, onUnsupported }: SplashCursorProps) {
  const reduceMotion = useReducedMotion() ?? false
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (reduceMotion) return
    const canvas = canvasRef.current
    if (canvas === null) return

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      premultipliedAlpha: false,
    })
    // WebGL2 + 浮点渲染目标是这套模拟的硬前提。拿不到就诚实退回静态底色。
    if (gl === null || gl.getExtension("EXT_color_buffer_float") === null) {
      onUnsupported?.()
      return
    }

    // ── 编译所有 program ────────────────────────────────────
    const vertex = compile(gl, gl.VERTEX_SHADER, BASE_VERTEX)
    if (vertex === null) {
      onUnsupported?.()
      return
    }
    const copyP = program(gl, vertex, COPY_SHADER)
    const clearP = program(gl, vertex, CLEAR_SHADER)
    const splatP = program(gl, vertex, SPLAT_SHADER)
    const advectionP = program(gl, vertex, ADVECTION_SHADER)
    const divergenceP = program(gl, vertex, DIVERGENCE_SHADER)
    const curlP = program(gl, vertex, CURL_SHADER)
    const vorticityP = program(gl, vertex, VORTICITY_SHADER)
    const pressureP = program(gl, vertex, PRESSURE_SHADER)
    const gradientP = program(gl, vertex, GRADIENT_SUBTRACT_SHADER)
    const displayP = program(gl, vertex, DISPLAY_SHADER)
    const programs = [
      copyP,
      clearP,
      splatP,
      advectionP,
      divergenceP,
      curlP,
      vorticityP,
      pressureP,
      gradientP,
      displayP,
    ]
    if (programs.some((p) => p === null)) {
      onUnsupported?.()
      return
    }

    // ── 全屏三角/四边形 ──────────────────────────────────────
    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW)
    const indexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.enableVertexAttribArray(0)

    const blit = (target: FBO | null): void => {
      if (target === null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      } else {
        gl.viewport(0, 0, target.width, target.height)
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)
    }

    // ── FBO 工厂 ─────────────────────────────────────────────
    const RGBA16F = gl.RGBA16F
    const RG16F = gl.RG16F
    const R16F = gl.R16F
    const RG = gl.RG
    const RED = gl.RED
    const HALF = gl.HALF_FLOAT

    function createFBO(
      w: number,
      h: number,
      internalFormat: number,
      format: number,
      type: number,
      filter: number,
    ): FBO {
      const texture = gl!.createTexture()!
      gl!.bindTexture(gl!.TEXTURE_2D, texture)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, filter)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, filter)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
      gl!.texImage2D(gl!.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null)
      const fbo = gl!.createFramebuffer()!
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo)
      gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, texture, 0)
      gl!.viewport(0, 0, w, h)
      gl!.clear(gl!.COLOR_BUFFER_BIT)
      const texelSizeX = 1 / w
      const texelSizeY = 1 / h
      return {
        texture,
        fbo,
        width: w,
        height: h,
        texelSizeX,
        texelSizeY,
        attach(id: number) {
          gl!.activeTexture(gl!.TEXTURE0 + id)
          gl!.bindTexture(gl!.TEXTURE_2D, texture)
          return id
        },
      }
    }

    function createDoubleFBO(
      w: number,
      h: number,
      internalFormat: number,
      format: number,
      type: number,
      filter: number,
    ): DoubleFBO {
      let fbo1 = createFBO(w, h, internalFormat, format, type, filter)
      let fbo2 = createFBO(w, h, internalFormat, format, type, filter)
      return {
        width: w,
        height: h,
        texelSizeX: fbo1.texelSizeX,
        texelSizeY: fbo1.texelSizeY,
        get read() {
          return fbo1
        },
        set read(v: FBO) {
          fbo1 = v
        },
        get write() {
          return fbo2
        },
        set write(v: FBO) {
          fbo2 = v
        },
        swap() {
          const tmp = fbo1
          fbo1 = fbo2
          fbo2 = tmp
        },
      }
    }

    // 分辨率：按面板长宽比取网格。
    function getResolution(resolution: number): { width: number; height: number } {
      let aspect = gl!.drawingBufferWidth / gl!.drawingBufferHeight
      if (aspect < 1) aspect = 1 / aspect
      const min = Math.round(resolution)
      const max = Math.round(resolution * aspect)
      return gl!.drawingBufferWidth > gl!.drawingBufferHeight
        ? { width: max, height: min }
        : { width: min, height: max }
    }

    // ── 初始化画布尺寸 ───────────────────────────────────────
    const resize = (): boolean => {
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
      const w = Math.floor(canvas.clientWidth * dpr)
      const h = Math.floor(canvas.clientHeight * dpr)
      if (w === 0 || h === 0) return false
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      return true
    }
    if (!resize()) {
      // 面板还没布局出尺寸：等下一帧由 rAF 再试（resize 里已幂等）。
    }

    const simRes = getResolution(SIM_RESOLUTION)
    const dyeRes = getResolution(DYE_RESOLUTION)
    const LINEAR = gl.LINEAR
    const NEAREST = gl.NEAREST

    const dye = createDoubleFBO(dyeRes.width, dyeRes.height, RGBA16F, gl.RGBA, HALF, LINEAR)
    const velocity = createDoubleFBO(simRes.width, simRes.height, RG16F, RG, HALF, LINEAR)
    const divergence = createFBO(simRes.width, simRes.height, R16F, RED, HALF, NEAREST)
    const curlFBO = createFBO(simRes.width, simRes.height, R16F, RED, HALF, NEAREST)
    const pressure = createDoubleFBO(simRes.width, simRes.height, R16F, RED, HALF, NEAREST)

    // ── 溅射 ────────────────────────────────────────────────
    const splat = (x: number, y: number, dx: number, dy: number): void => {
      // 速度场：把指针方向的冲量打进去
      gl.useProgram(splatP!.prog)
      gl.uniform1i(splatP!.uniforms["uTarget"] ?? null, velocity.read.attach(0))
      gl.uniform1f(splatP!.uniforms["aspectRatio"] ?? null, canvas.width / canvas.height)
      gl.uniform2f(splatP!.uniforms["point"] ?? null, x, y)
      gl.uniform3f(splatP!.uniforms["color"] ?? null, dx, dy, 0)
      gl.uniform1f(
        splatP!.uniforms["radius"] ?? null,
        SPLAT_RADIUS / 100 / (canvas.width / canvas.height),
      )
      blit(velocity.write)
      velocity.swap()
      // dye 场：打进固定紫色
      gl.uniform1i(splatP!.uniforms["uTarget"] ?? null, dye.read.attach(0))
      gl.uniform3f(splatP!.uniforms["color"] ?? null, SPLAT_COLOR.r, SPLAT_COLOR.g, SPLAT_COLOR.b)
      blit(dye.write)
      dye.swap()
    }

    // ── 一步模拟 ────────────────────────────────────────────
    const step = (dt: number): void => {
      gl.disable(gl.BLEND)
      // curl
      gl.useProgram(curlP!.prog)
      gl.uniform2f(curlP!.uniforms["texelSize"] ?? null, velocity.texelSizeX, velocity.texelSizeY)
      gl.uniform1i(curlP!.uniforms["uVelocity"] ?? null, velocity.read.attach(0))
      blit(curlFBO)
      // vorticity
      gl.useProgram(vorticityP!.prog)
      gl.uniform2f(
        vorticityP!.uniforms["texelSize"] ?? null,
        velocity.texelSizeX,
        velocity.texelSizeY,
      )
      gl.uniform1i(vorticityP!.uniforms["uVelocity"] ?? null, velocity.read.attach(0))
      gl.uniform1i(vorticityP!.uniforms["uCurl"] ?? null, curlFBO.attach(1))
      gl.uniform1f(vorticityP!.uniforms["curl"] ?? null, CURL)
      gl.uniform1f(vorticityP!.uniforms["dt"] ?? null, dt)
      blit(velocity.write)
      velocity.swap()
      // divergence
      gl.useProgram(divergenceP!.prog)
      gl.uniform2f(
        divergenceP!.uniforms["texelSize"] ?? null,
        velocity.texelSizeX,
        velocity.texelSizeY,
      )
      gl.uniform1i(divergenceP!.uniforms["uVelocity"] ?? null, velocity.read.attach(0))
      blit(divergence)
      // clear pressure（按 PRESSURE 衰减上一帧压力，作为迭代初值）
      gl.useProgram(clearP!.prog)
      gl.uniform1i(clearP!.uniforms["uTexture"] ?? null, pressure.read.attach(0))
      gl.uniform1f(clearP!.uniforms["value"] ?? null, PRESSURE)
      blit(pressure.write)
      pressure.swap()
      // pressure Jacobi 迭代
      gl.useProgram(pressureP!.prog)
      gl.uniform2f(
        pressureP!.uniforms["texelSize"] ?? null,
        velocity.texelSizeX,
        velocity.texelSizeY,
      )
      gl.uniform1i(pressureP!.uniforms["uDivergence"] ?? null, divergence.attach(0))
      for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureP!.uniforms["uPressure"] ?? null, pressure.read.attach(1))
        blit(pressure.write)
        pressure.swap()
      }
      // gradient subtract
      gl.useProgram(gradientP!.prog)
      gl.uniform2f(
        gradientP!.uniforms["texelSize"] ?? null,
        velocity.texelSizeX,
        velocity.texelSizeY,
      )
      gl.uniform1i(gradientP!.uniforms["uPressure"] ?? null, pressure.read.attach(0))
      gl.uniform1i(gradientP!.uniforms["uVelocity"] ?? null, velocity.read.attach(1))
      blit(velocity.write)
      velocity.swap()
      // advect velocity
      gl.useProgram(advectionP!.prog)
      gl.uniform2f(
        advectionP!.uniforms["texelSize"] ?? null,
        velocity.texelSizeX,
        velocity.texelSizeY,
      )
      gl.uniform1i(advectionP!.uniforms["uVelocity"] ?? null, velocity.read.attach(0))
      gl.uniform1i(advectionP!.uniforms["uSource"] ?? null, velocity.read.attach(0))
      gl.uniform1f(advectionP!.uniforms["dt"] ?? null, dt)
      gl.uniform1f(advectionP!.uniforms["dissipation"] ?? null, VELOCITY_DISSIPATION)
      blit(velocity.write)
      velocity.swap()
      // advect dye
      gl.uniform1i(advectionP!.uniforms["uVelocity"] ?? null, velocity.read.attach(0))
      gl.uniform1i(advectionP!.uniforms["uSource"] ?? null, dye.read.attach(1))
      gl.uniform1f(advectionP!.uniforms["dissipation"] ?? null, DENSITY_DISSIPATION)
      blit(dye.write)
      dye.swap()
    }

    const render = (): void => {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.useProgram(displayP!.prog)
      gl.uniform1i(displayP!.uniforms["uTexture"] ?? null, dye.read.attach(0))
      blit(null)
    }

    // ── 指针 & 空闲自发溅射 ──────────────────────────────────
    //
    // ★ 监听挂在**父容器**上而不是 canvas 自己：canvas 是
    // `pointer-events-none`（好让它身后的「建图」按钮仍可点），
    // 于是它自己收不到 pointer 事件。父容器（整块空态面板）能收到，
    // 指针划过面板任意位置都驱动流体，而按钮照旧可点。
    const surface = canvas.parentElement ?? canvas
    let lastPointerAt = 0
    let lastAutoAt = 0
    let prev: { x: number; y: number } | null = null
    const onMove = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width
      const y = 1 - (e.clientY - rect.top) / rect.height
      if (prev !== null) {
        const dx = (x - prev.x) * SPLAT_FORCE
        const dy = (y - prev.y) * SPLAT_FORCE
        if (dx !== 0 || dy !== 0) splat(x, y, dx, dy)
      }
      prev = { x, y }
      lastPointerAt = performance.now()
    }
    const onLeave = (): void => {
      prev = null
    }
    surface.addEventListener("pointermove", onMove as EventListener)
    surface.addEventListener("pointerleave", onLeave)

    /** 自发溅射：从随机边缘朝内打一股，模拟"活着的等待态"。用索引化的伪随机。 */
    let autoSeed = 1
    const autoRandom = (): number => {
      autoSeed = (autoSeed * 1103515245 + 12345) & 0x7fffffff
      return autoSeed / 0x7fffffff
    }
    const autoSplat = (): void => {
      const x = autoRandom()
      const y = autoRandom()
      const dx = (autoRandom() - 0.5) * SPLAT_FORCE * 0.7
      const dy = (autoRandom() - 0.5) * SPLAT_FORCE * 0.7
      splat(x, y, dx, dy)
    }

    // 起手先打两股，别让首帧空白。
    autoSplat()
    autoSplat()

    // ── 主循环 ──────────────────────────────────────────────
    let raf = 0
    let lastTime = performance.now()
    const loop = (now: number): void => {
      resize()
      let dt = (now - lastTime) / 1000
      dt = Math.min(dt, 0.016666) // 卡顿时钳住，避免爆炸
      lastTime = now
      // 空闲一段时间没有指针 → 定时自发溅射
      if (now - lastPointerAt > IDLE_AFTER_MS && now - lastAutoAt > AUTO_SPLAT_EVERY_MS) {
        autoSplat()
        lastAutoAt = now
      }
      step(dt)
      render()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      surface.removeEventListener("pointermove", onMove as EventListener)
      surface.removeEventListener("pointerleave", onLeave)
      // 释放 GL 资源（面板会反复挂载/卸载）
      const ext = gl.getExtension("WEBGL_lose_context")
      ext?.loseContext()
    }
  }, [reduceMotion, onUnsupported])

  // reduced-motion：不初始化 WebGL，画布层不出现（调用方的 children 照旧显示）。
  if (reduceMotion) return null

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
    />
  )
}
