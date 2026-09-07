// 浏览器 API：6 个 HTTP 接口，一目了然。
// 路由模型照抄 dsh-univer-office 的 webServer prefix 模式（真实可用的第三方插件范式）。
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GroupStore } from './groups-store.ts'

const MAX_BODY_BYTES = 64 * 1024

/** createRouter 的两个写通道：取消归档 / 彻底删除已归档会话。 */
export interface ArchiveActions {
  unarchive?: (sessionId: string) => Promise<void>
  deleteArchived?: (sessionId: string) => Promise<void>
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/** Create the `/session-groups-api` HTTP dispatcher. */
export function createRouter(store: GroupStore, actions: ArchiveActions = {}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const method = request.method ?? 'GET'
      const groupId = /^\/session-groups-api\/groups\/([^/]+)$/.exec(url.pathname)?.[1]

      // GET  /session-groups-api/groups        → 全量视图（分组 + 归属表）
      if (method === 'GET' && url.pathname === '/session-groups-api/groups') {
        sendJson(response, 200, await store.view())
        return
      }
      // POST /session-groups-api/groups        → 新建分组 { title }
      if (method === 'POST' && url.pathname === '/session-groups-api/groups') {
        const body = await readJsonBody(request) as { title?: string }
        const title = body.title?.trim()
        if (!title) {
          sendJson(response, 400, { message: 'title is required' })
          return
        }
        sendJson(response, 200, await store.createGroup(title))
        return
      }
      // PATCH  /session-groups-api/groups/:id  → 改名 { title }
      if (method === 'PATCH' && groupId) {
        const body = await readJsonBody(request) as { title?: string }
        sendJson(response, 200, await store.renameGroup(decodeURIComponent(groupId), body.title?.trim() ?? ''))
        return
      }
      // DELETE /session-groups-api/groups/:id  → 删除分组（拆标签，不动会话）
      if (method === 'DELETE' && groupId) {
        sendJson(response, 200, { deleted: await store.deleteGroup(decodeURIComponent(groupId)) })
        return
      }
      // PUT  /session-groups-api/assignments   → 设置会话归属 { sessionId, groupIds }
      if (method === 'PUT' && url.pathname === '/session-groups-api/assignments') {
        const body = await readJsonBody(request) as { sessionId?: string; groupIds?: string[] }
        if (!body.sessionId) {
          sendJson(response, 400, { message: 'sessionId is required' })
          return
        }
        sendJson(response, 200, await store.setMembership(body.sessionId, body.groupIds ?? []))
        return
      }
      // POST /session-groups-api/groups/reorder → 重排分组 { ids: 分组 id 全序列 }
      if (method === 'POST' && url.pathname === '/session-groups-api/groups/reorder') {
        const body = await readJsonBody(request) as { ids?: string[] }
        sendJson(response, 200, await store.reorderGroups(body.ids ?? []))
        return
      }
      // POST /session-groups-api/archive/unarchive → 取消归档 { sessionId }
      // 会话回到归档前的位置；官方 feed 推送 archived 帧，客户端自动刷新。
      if (method === 'POST' && url.pathname === '/session-groups-api/archive/unarchive') {
        if (actions.unarchive === undefined) {
          sendJson(response, 501, { message: 'unarchive is not available' })
          return
        }
        const body = await readJsonBody(request) as { sessionId?: string }
        if (!body.sessionId) {
          sendJson(response, 400, { message: 'sessionId is required' })
          return
        }
        await actions.unarchive(body.sessionId)
        sendJson(response, 200, { ok: true })
        return
      }
      // POST /session-groups-api/archive/delete → 彻底删除已归档会话 { sessionId }
      // 物理删除其 JSONL 存储目录，清归档账与分组成员记录；不可逆。
      if (method === 'POST' && url.pathname === '/session-groups-api/archive/delete') {
        if (actions.deleteArchived === undefined) {
          sendJson(response, 501, { message: 'delete is not available' })
          return
        }
        const body = await readJsonBody(request) as { sessionId?: string }
        if (!body.sessionId) {
          sendJson(response, 400, { message: 'sessionId is required' })
          return
        }
        try {
          await actions.deleteArchived(body.sessionId)
        } catch (error) {
          const status = (error as { status?: number } | null)?.status
          if (typeof status === 'number' && status >= 400 && status <= 499) {
            sendJson(response, status, { message: error instanceof Error ? error.message : 'delete refused' })
            return
          }
          throw error
        }
        sendJson(response, 200, { ok: true })
        return
      }
      response.writeHead(404)
      response.end()
    } catch (error) {
      sendJson(response, 500, { message: error instanceof Error ? error.message : 'internal error' })
    }
  }
}
