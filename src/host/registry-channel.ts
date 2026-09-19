// WorkspaceRegistry 归档账写入通道：把会话移出官方归档集。
//
// dsh 0.1.6-alpha.1 起 WorkspaceRegistry 公开了官方动词 unarchiveSession
// （packages/workspace/workspace/src/index.ts），语义与本插件早期手写的
// enqueueOperation + setState 私有通道逐字一致，但不再依赖 private 成员——
// 优先走官方动词。移出后 domain/changed 触发官方 feed 的 archived 帧，
// 客户端 useWorkspaces 快照自动更新。原生注释明确归档会话保留其工作区槽位，
// 因此取消归档无需恢复任何账本。
//
// 旧版（≤0.1.5）没有公开动词，回退到 registry 私有的序列化写通道
// （enqueueOperation + setState，与 archiveSession 内部同一条写路径）。
export async function removeFromArchivedSet(registry: unknown, sessionId: string): Promise<void> {
  const inner = registry as {
    unarchiveSession?: (sessionId: string) => Promise<void>
    enqueueOperation<T>(operation: () => Promise<T>): Promise<T>
    state?: { archivedSessionIds: readonly string[] }
    setState(state: object): Promise<void>
  }

  if (typeof inner.unarchiveSession === 'function') {
    await inner.unarchiveSession(sessionId)
    return
  }

  await inner.enqueueOperation(async () => {
    const state = inner.state
    if (state === undefined) throw new Error('workspace registry is not started yet')
    if (!state.archivedSessionIds.includes(sessionId)) return
    await inner.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
    })
  })
}
