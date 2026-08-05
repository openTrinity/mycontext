import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider, QueryClient } from "@tanstack/react-query"
import { I18nextProvider } from "react-i18next"
import { createI18n } from "@mycontext/i18n"
import { App } from "./app.js"
import "./styles/globals.css"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 本地 IPC 调用无网络抖动，失败重试意义不大且会延迟错误展示。
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
})

/**
 * i18n 先按系统语言初始化，拿到 bootstrapState 后再切到用户的选择（见 App）。
 *
 * 不等 IPC 回来再初始化：那样首帧没有 i18n 实例，要么白屏要么渲染出 key。
 * 系统语言在绝大多数情况下就是用户想要的，切换只是一次重渲染。
 */
const i18n = createI18n("system")

const container = document.getElementById("root")
// 挂载点缺失是构建产物出了问题，此时 i18n 也未必可用，因此这条不翻译。
if (container === null) throw new Error("mount point #root not found")

createRoot(container).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
)
