import { clsx, type ClassValue } from "clsx"

/** 类名合并。组件内部统一用它，避免各处混用字符串拼接。 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}
