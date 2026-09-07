// 分组数据仓库：一个 JSON 文件就是整个数据库。
// 存放位置：~/.dsh/storages/session-groups.json（dsh 的 storages 目录本来就是放插件数据的）。
//
// 设计要点：分组是"标签"，不是"文件夹"——
//   - 一个会话可以进多个分组（多对多），也可以一个都不进（未分类）；
//   - 分组绝不移动会话、不改变它的工作区归属；
//   - 删除分组只是拆标签，会话本体毫发无损。
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface Group {
  id: string
  title: string
  createdAt: string
  order: number
}

/** 全部持久化状态（真源只有这一份 JSON）。 */
export interface GroupsData {
  groups: Group[]
  /** sessionId -> 它加入的分组 id 列表。空/缺失 = 未分类。 */
  membership: Record<string, string[]>
}

const FILE = join(homedir(), '.dsh', 'storages', 'session-groups.json')

export class GroupStore {
  private cache: GroupsData | undefined

  private async load(): Promise<GroupsData> {
    if (this.cache) return this.cache
    try {
      this.cache = JSON.parse(await readFile(FILE, 'utf8')) as GroupsData
    } catch {
      this.cache = { groups: [], membership: {} }
    }
    if (!Array.isArray(this.cache.groups)) this.cache.groups = []
    if (typeof this.cache.membership !== 'object' || this.cache.membership === null) {
      this.cache.membership = {}
    }
    return this.cache
  }

  private async save(data: GroupsData): Promise<void> {
    this.cache = data
    await mkdir(dirname(FILE), { recursive: true })
    await writeFile(FILE, JSON.stringify(data, null, 2), 'utf8')
  }

  /** 浏览器一次拉走全量视图。"未分类"由客户端用「全部会话 − 已分组」推导。 */
  async view(): Promise<GroupsData> {
    return this.load()
  }

  async createGroup(title: string): Promise<Group> {
    const data = await this.load()
    const group: Group = {
      id: randomUUID(),
      title,
      createdAt: new Date().toISOString(),
      order: data.groups.length,
    }
    data.groups.push(group)
    await this.save(data)
    return group
  }

  async renameGroup(id: string, title: string): Promise<Group | undefined> {
    const data = await this.load()
    const group = data.groups.find((g) => g.id === id)
    if (group) {
      group.title = title
      await this.save(data)
    }
    return group
  }

  /** 删除分组 = 拆标签：从所有会话的归属里同步摘掉，不碰会话本身。 */
  async deleteGroup(id: string): Promise<boolean> {
    const data = await this.load()
    const before = data.groups.length
    data.groups = data.groups.filter((g) => g.id !== id)
    if (data.groups.length === before) return false
    for (const [sessionId, ids] of Object.entries(data.membership)) {
      const rest = ids.filter((gid) => gid !== id)
      if (rest.length === 0) delete data.membership[sessionId]
      else data.membership[sessionId] = rest
    }
    await this.save(data)
    return true
  }

  /** 整体设置一个会话的分组归属（PUT 语义：传来的列表就是最终状态）。 */
  async setMembership(sessionId: string, groupIds: string[]): Promise<GroupsData> {
    const data = await this.load()
    const known = new Set(data.groups.map((g) => g.id))
    const valid = [...new Set(groupIds)].filter((gid) => known.has(gid))
    if (valid.length === 0) delete data.membership[sessionId]
    else data.membership[sessionId] = valid
    await this.save(data)
    return data
  }

  /** 重排分组：按给定 id 序列重排数组；未提及的分组保持原有相对顺序排在末尾。 */
  async reorderGroups(ids: string[]): Promise<GroupsData> {
    const data = await this.load()
    const byId = new Map(data.groups.map((g) => [g.id, g]))
    const next: Group[] = []
    for (const id of ids) {
      const group = byId.get(id)
      if (group !== undefined) {
        next.push(group)
        byId.delete(id)
      }
    }
    next.push(...byId.values())
    data.groups = next
    await this.save(data)
    return data
  }
}
