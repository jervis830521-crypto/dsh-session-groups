// 兼容入口：运行中的 DSH web 进程可能缓存了本包旧的解析结果（lib/main.js），
// 保留这个转发入口让旧缓存也能解析到当前实现（真正的入口是 index.ts）。
export * from './index.ts'
