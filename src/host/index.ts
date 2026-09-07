// Host 半入口：dsh 在 Node 侧加载本文件。
// 把分组 API 注册为 webServer 的一个前缀路由（/session-groups-api）。
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { deleteArchivedSession } from './delete-archived-session.ts'
import { GroupStore } from './groups-store.ts'
import { removeFromArchivedSet } from './registry-channel.ts'
import { createRouter } from './web-router.ts'

export const name = 'session-groups'

export const inject = ['webServer']

export function apply(ctx: Context): void {
  const store = new GroupStore()
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/session-groups-api',
    handler: createRouter(store, {
      // 取消归档：原生归档是单向的（WorkspaceRegistry 只有 archiveSession）；
      // 这里经它私有的序列化操作通道（enqueueOperation + setState，与
      // archiveSession 内部同一条写路径）把会话移出归档集。移出后
      // domain/changed 触发官方 feed 的 archived 帧，客户端 useWorkspaces
      // 快照自动更新。原生注释明确归档会话保留其工作区槽位，因此取消归档
      // 无需恢复任何账本。
      unarchive: (sessionId) => {
        // 请求时再解析：workspaceRegistry 可能晚于本插件可用。
        const registry = ctx.get('workspaceRegistry')
        if (registry === undefined) throw new Error('workspaceRegistry service is unavailable')
        return removeFromArchivedSet(registry, sessionId)
      },
      // 彻底删除：先清归档账，再物理删除 JSONL 会话目录，最后清分组成员记录。
      deleteArchived: (sessionId) => deleteArchivedSession(sessionId, {
        liveSessions: ctx.get('sessions') as { get(id: string): unknown } | undefined,
        persistence: ctx.get('sessionPersistence'),
        registry: ctx.get('workspaceRegistry'),
        purgeMembership: (id) => store.setMembership(id, []).then(() => {}),
      }),
    }),
  }), 'session-groups: browser api')
}
