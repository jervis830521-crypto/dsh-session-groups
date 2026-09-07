// 已归档会话的彻底删除。官方 SessionPersistence 接口只有 create/open/flush/
// stat/list——没有 delete；客户端 RPC 目录同样没有删除动词。这里插件侧自行
// 定位 JSONL 后端的物理存储目录并整目录删除。
//
// 安全顺序：先清 registry 归档账（成功=会话确认不再有任何归档痕迹），再删
// 磁盘目录，最后清插件分组成员记录。磁盘删除失败时账号已清，仅剩孤儿目录，
// 不会留下指向已删会话的任何状态。
//
// 五重防护：
//   1. 活会话拒删（sessionStore.get 命中一律 409）；
//   2. 双通道都找不到会话头 → 404；
//   3. 目录名必须等于 encodeSegment(id)，跨项目重复同名目录且非空时拒删；
//   4. 目录内只允许 session* 工件（日志代际/快照/锁）；出现陌生文件即拒删，
//      未来该目录若承载新工件，误删面为零；
//   5. 只删除既非文件也非目录的意外项之外的目标——整目录 rm 后校验消失。
import { rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { removeFromArchivedSet } from './registry-channel.ts'

/** encodeSegment：与 session-persistence-jsonl/format.ts 逐字符一致（重实现避免 peerDep）。 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/** projectKey：与 session-persistence-jsonl/format.ts 逐字符一致。 */
function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** sessionDir(root, cwd, id)：cwd 缺省 → root/_no-cwd。 */
function sessionDir(root: string, cwd: string | undefined, id: string): string {
  const project = cwd === undefined ? join(root, '_no-cwd') : join(root, projectKey(cwd))
  return join(project, encodeSegment(id))
}

export interface DeleteDeps {
  /** 活会话表：命中即拒删（SessionStore.get）。 */
  readonly liveSessions: { get(id: string): unknown } | undefined
  /** 持久化后端（JsonlSessionPersistence），取 config.root 与 stat。 */
  readonly persistence: unknown
  /** WorkspaceRegistry，走 enqueueOperation 通道清 archivedSessionIds。 */
  readonly registry: unknown
  /** 分组成员记录清理（拆标签，永远不该指向已删会话）。 */
  readonly purgeMembership: (sessionId: string) => Promise<void>
}

/** 删除失败时抛给路由层的结构化错误：status 映射为 HTTP 码。 */
export class DeleteRefusedError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'DeleteRefusedError'
  }
}

interface CwdHolder {
  cwd?: string
}

/** 一个会话的物理目录是否已经干净到可以整目录删除。 */
function dirLooksPurgeable(entries: string[]): boolean {
  // session 目录内的全部已知工件都以 session 开头（session.jsonl /
  // session.vN.jsonl(.zstd) 代际、session.migration.*.tmp、session.lock）。
  return entries.every((name) => name.startsWith('session'))
}

/** 按依赖逐项解析；缺哪个报哪个，绝不静默跳过。 */
function requireRoot(deps: DeleteDeps): string {
  const root = (deps.persistence as { config?: { root?: string } } | undefined)?.config?.root
  if (typeof root !== 'string' || root === '') {
    throw new DeleteRefusedError(501, 'session persistence backend does not expose a filesystem root')
  }
  return root
}

export async function deleteArchivedSession(sessionId: string, deps: DeleteDeps): Promise<void> {
  // 1) 活会话绝对不删：它正被 Agent/工作区使用，物理删除等于撕毁运行时状态。
  if (deps.liveSessions?.get(sessionId) !== undefined) {
    throw new DeleteRefusedError(409, `session "${sessionId}" is live and cannot be deleted`)
  }

  // 2) 双通道取会话头（cwd 在头里）：活 store → persistence.stat。
  let header: CwdHolder | undefined
  const statFn = (deps.persistence as { stat?: (id: string) => Promise<{ header: CwdHolder } | undefined> | undefined })?.stat
  if (typeof statFn === 'function') {
    try {
      const snap = await statFn.call(deps.persistence, sessionId)
      header = snap?.header
    } catch (error) {
      // stat 对缺失会话的报错形态因后端而异：统一按"找不到"处理，其余错误原样上抛。
      const code = (error as NodeJS.ErrnoException | null)?.code
      const missing = code === 'ENOENT' || String((error as Error | undefined)?.message ?? '').includes('not found')
      if (!missing) throw error
    }
  }

  const root = requireRoot(deps)
  const dir = sessionDir(root, header?.cwd, sessionId)

  // 3) 目录必须存在且只含 session 工件。
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      throw new DeleteRefusedError(404, `session "${sessionId}" has no stored artifacts on disk`)
    }
    throw error
  }
  if (!dirLooksPurgeable(entries)) {
    throw new DeleteRefusedError(409, `session "${sessionId}" directory holds unexpected files; deletion refused`)
  }

  // 4) 先清归档账（registry 序列化通道），成功后再动磁盘。
  await removeFromArchivedSet(deps.registry, sessionId)

  // 5) 删盘 + 清分组成员记录。
  await rm(dir, { recursive: true, force: true })
  try {
    await stat(dir)
  } catch {
    await deps.purgeMembership(sessionId)
    return
  }
  throw new DeleteRefusedError(500, `session "${sessionId}" directory survived deletion`)
}
