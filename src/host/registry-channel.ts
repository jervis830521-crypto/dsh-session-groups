// WorkspaceRegistry 私有操作通道。官方唯一公开的归档集变更入口是单向的
// archiveSession；取消归档/删除会话都经它内部同一条序列化写路径
// （enqueueOperation + setState）把 id 移出 archivedSessionIds。移出后
// domain/changed 触发官方 feed 的 archived 帧，客户端 useWorkspaces 自动更新。
export function removeFromArchivedSet(registry: unknown, sessionId: string): Promise<void> {
  const inner = registry as {
    enqueueOperation<T>(operation: () => Promise<T>): Promise<T>
    state?: { archivedSessionIds: readonly string[] }
    setState(state: object): Promise<void>
  }
  return inner.enqueueOperation(async () => {
    const state = inner.state
    if (state === undefined) throw new Error('workspace registry is not started yet')
    if (!state.archivedSessionIds.includes(sessionId)) return
    await inner.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
    })
  })
}
