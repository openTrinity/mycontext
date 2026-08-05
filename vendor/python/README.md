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
| `<platform>/venv/` | ❌ | 由 `pnpm setup:python` 在各机器上建 |

### 为什么 venv 不入 git

**venv 里写死了绝对路径** —— `pyvenv.cfg` 的 `home =`、每个脚本的 shebang
都是生成它那台机器的路径。提交上去在别人机器上全是坏的。这不是体积问题，
是 venv 的设计使然。

所以：解释器入 git（跨机器可用），venv 由 `pnpm setup:python` 现场拼装
（几秒，装依赖需要出网一次）。

## 上游与版本

`python-build-standalone`（astral 维护，也是 `uv python install` 用的那套）。
选它而不是自己编：「在别人机器上能跑的 Python」有大量平台细节
（rpath、SSL 证书位置、framework 布局），自己编必然踩一遍。

当前版本见 `<platform>/VERSION`。

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
