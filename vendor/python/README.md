# vendor/python — 内置的 Python 运行时

**这个目录入 git。** clone 下来就有可用的 Python，不需要任何前置安装。

## 为什么入 git

与 `vendor/dws` 同一个理由：**开发者不该每人配一次环境**。而 Python 这边
比 dws 更刚性——"本机有没有能跑 kl 的 Python"根本指望不上：

| 机器 | 本机 python3 | 能跑 kl 吗 |
| --- | --- | --- |
| macOS 出厂 | 3.9.6 | ✗ kl 要求 ≥3.10 |
| 装过 homebrew | 3.13 / 3.14 | 碰巧可以（运气，不是设计） |
| 非开发者的机器 | 可能没有 | ✗ |

真实踩过：同事机器上 agent 能说话（模型走网关）、但**查不了图谱**——
kl-server 拿系统 python3 起来就 `exit 3`，而日志里只有一个退出码，
`ModuleNotFoundError` 在 kl 那侧，两件事很难联系起来。

## 目录内容

| 路径 | 入 git | 说明 |
| --- | --- | --- |
| `<platform>/python/` | ✅ | 解释器本体（精简后 ~43MB） |
| `<platform>/VERSION` | ✅ | 版本戳，升级时比对 |
| `<platform>/venv/` | ✅ | kl 的依赖（9223 个文件 / 385MB） |

### 为什么 venv 也入 git

venv 里**曾经**处处是绝对路径（生成它那台机器的），所以这一节原来写的是
"venv 不入 git"。而真正的约束是另一件事：**打包给用户时不可能让他们去跑
`pnpm setup:python`**，也不该要求他们出网装 280MB 依赖。

所以选择是"把 venv 里的绝对路径全部消灭"，而不是"不提交它"。已经做掉的：

| 绑路径的地方 | 现在的形态 |
| --- | --- |
| `bin/python*` 软链 | 相对（`../../python/bin/python3`） |
| `pyvenv.cfg` 的 `home =` | **整行不写** —— 靠上面那个相对软链自定位（实测：写相对路径反而起不来） |
| 23 个 console-script 的 shebang | `#!/bin/sh` + sh/python polyglot，用 `$0` 推同目录的 `python3` |
| `activate` / `activate.fish` | 用 `BASH_SOURCE` / `${(%):-%x}` / `status --current-filename` 推自身 |
| `activate.csh` | **删掉** —— csh 拿不到自身路径，而全仓库没人引用它 |
| `bin/kl` | 相对自身上跳 5 级（由 `installKlWrapper` 生成） |

实现与逐条理由见 `scripts/lib/python-env.mjs`（`relocateVenv` /
`rewriteVenvScripts`）。`check:vendor-clean` 有一条门禁盯着"入 git 的
`pyvenv.cfg` 不得带 `home =`"。

### ★ 打包态没有 venv

`scripts/build-python-bundle.mjs` 会把 venv 的 site-packages **压平进解释器
自己那份**，产物里只有 `python/`。理由是 venv 只有 site-packages、没有标准库，
它靠 `pyvenv.cfg` 去解释器那边借 —— 而修那个指针意味着往 .app 内部写文件
（破坏签名；Gatekeeper 隔离时那还是只读路径）。裸解释器本来就自定位，
所以去掉 venv 那一层之后零环境变量、拷到哪都能跑。

## 谁在用这个解释器

**所有** mycontext 起的 Python 子进程，两条路：

| 用途 | 解析入口 | 要不要 venv 的依赖 |
| --- | --- | --- |
| kl（知识图谱） | `scripts/lib/python-env.mjs` 的 `venvPython()` | 要（qdrant/litellm/scipy…） |
| forge 蒸馏、persona 判定 | `packages/runtime-env/src/python.ts` 的 `resolvePython()` | **不要** —— 纯标准库 |

后者只需要 base 解释器（`<platform>/python/bin/python3`），所以它同步拼路径
就够，不走 kl 那套异步准备流程。它仍保留 `MYCONTEXT_PYTHON_BIN` → 内置 →
PATH → 系统固定位置四档，内置排在 PATH 之前 —— 否则会命中本机某个偶然的
`python3`（实测踩过：那是**另一个项目 venv 里的 3.14.5**）。

## 上游与版本

`python-build-standalone`（astral 维护，也是 `uv python install` 用的那套）。
选它而不是自己编：「在别人机器上能跑的 Python」有大量平台细节
（rpath、SSL 证书位置、framework 布局），自己编必然踩一遍。

**盘上这份的版本以 `<platform>/VERSION` 为准**（当前 `3.12.11+uv` —— `+uv`
表示它是用下面办法①装的，不是 `pnpm vendor:python` 下载的）。

### ★ VERSION 与 python-runtime.mjs 里的常量对不上，这是**已知**的

`scripts/lib/python-runtime.mjs` 的 `PYTHON_VERSION` / `PYTHON_RELEASE` /
`PYTHON_TARGETS` 是**下载路径**用的（含官方 sha256），当前写的是
`3.12.13` / `20260728`。而入 git 这份是 3.12.11。

两者不一致目前**没有后果**：解释器已入 git，`ensureBundledPython` 头一行
`hasBundledPython()` 就命中，下载路径永远走不到。但它是个陷阱 ——
谁删掉 `vendor/python/<platform>/` 想重建，拿回来的会是另一个小版本
（而 venv 里那些 `.so` 是按 3.12 的 ABI 编的，小版本差异在 cp312 tag 内
一般无碍，但"一般"不是"验过"）。

要么重建时连 VERSION 一起对齐，要么把那批常量升到与盘上一致。
选 3.12 这个大版本的理由仍然成立（见那个文件的注释：kl 的依赖里有带原生
扩展的包，3.12 的 wheel 覆盖面比 3.13 全）。

## 怎么升级 / 补别的平台

```bash
pnpm vendor:python                      # 当前平台
pnpm vendor:python --target darwin-x64  # 交叉准备（发版前）
```

脚本会下载 → **校验官方 sha256** → 精简 → 落地。
国内网络下 GitHub 常连不上，两个可用办法：

```bash
# ① 用 uv 装（认国内镜像），再复制进来 —— 本项目就是这么做的
UV_PYTHON_INSTALL_MIRROR="https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/releases/download" \
  uv python install 3.12
cp -R ~/.local/share/uv/python/cpython-3.12*-macos-aarch64-none vendor/python/darwin-arm64/python

# ② 挂代理后跑 pnpm vendor:python
```

### 精简掉了什么（以及为什么安全）

| 砍掉 | 省 | 理由 |
| --- | --- | --- |
| `lib/libpython3.12.dylib` | 18MB | `bin/python3.12` 是静态链接的（`otool -L` 无 libpython 依赖）；实测删后 venv 可建、numpy 这类带 `.so` 的包可装可用 |
| Tcl/Tk、`_tkinter.so` | ~7MB | GUI 库；我们只跑无界面的 kl_server / kl_cli |
| `test`、`idlelib`、`turtledemo` | ~7MB | 测试套件与 IDE |
| `include/`、`pkgconfig` | ~2MB | C 扩展**编译**期才需要；我们装预编译 wheel |
| `__pycache__` | ~15MB | 首次 import 自动重建，且它与绝对路径绑定 |

★ **不砍** `ssl` / `sqlite3` / `ctypes` / `zlib` / `hashlib` / `venv` / `lzma` / `bz2`：
分别是 pip 出网、kl 存图、原生扩展、解压、校验、建 venv 的必需项。
`pnpm vendor:python` 末尾会逐个 import 验一遍——砍错了当场就红。
