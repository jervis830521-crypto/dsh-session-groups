// 浏览器半：侧边栏原生风格「分组」折叠面板。
//
// 设计完全对齐官方 ui-workspace 规范：
//  - 32px 行高、8px 圆角、--dsw-alias-interactive-bg-hover 悬停态；
//  - 极致细节：默认显示 Folder 图标，悬停时动态替换为小三角形（IconTriangleRightFill14），支持平滑旋转；
//  - 按钮名称显示「分组 (N)」，括号内实时反映当前分组总数；
//  - 一体化设计：展开面板不画边框/阴影，与侧栏直接连成一体，层级仅靠缩进区分
//    （分组行缩进 24px，组内会话再缩进到 40px）；
//  - 控制上移：全部展开/折叠 与 新建分组 常驻在外层「分组」行右侧（悬停显示），
//    展开面板内部不再有「分组」小标题栏。
//
import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import {
  Button,
  HoverCard,
  Menu,
  Modal,
  StateDot,
  IconArchiveOutline20,
  IconBranchOutline16,
  IconChecklistOutline14,
  IconCheckOutline16,
  IconChevronLeftOutline14,
  IconClockOutline16,
  IconCloseOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconPlusOutline16,
  IconTriangleRightFill14,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'

export const inject = ['slots', 'sessions', 'workspaces']

export function apply(ctx: ClientContext): void {
  const sessions = ctx.get('sessions') as {
    open: (sessionId: string) => void
    // ClientSessions.create 直接返回新会话 id（Promise<SessionId>）。
    create: (request?: { workspaceId?: string }) => Promise<string>
    // fork 子会话 id（increaseTitle 时服务端顺带加「副本」后缀）。
    fork: (opts: { sessionId: string; increaseTitle?: boolean }) => Promise<string>
    // binding 解析任意已列出会话的稳定绑定（rename 是 per-session 动词）。
    binding: (id: string) => {
      session: { rename: (title: string) => Promise<{ ok: true } | { ok: false; error: { message: string } }> }
    } | undefined
  }
  const workspaces = ctx.get('workspaces') as {
    // 归档：日志与账本槽位保留，仅从全部列表隐藏（archive-set echo）。
    archiveSession: (sessionId: string) => Promise<void>
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'session-groups-button',
      order: 80,
      inject: () => ({
        openSession: (sessionId: string) => { sessions.open(sessionId) },
        // 组内新会话：优先绑定工作区创建（host 在创建时即 attachSession，
        // cwd 与工作区一致 → 首条消息直接落在本会话，不会触发换 id 的 recompose）。
        createSession: (workspaceId?: string) => sessions.create(workspaceId === undefined ? {} : { workspaceId }),
        // 会话行菜单三项：与原生 ui-workspace 行为逐一对应（index.ts:105-125）。
        renameSession: async (sessionId: string, title: string) => {
          const session = sessions.binding(sessionId)?.session
          if (session === undefined) throw new Error(`unknown session "${sessionId}"`)
          const result = await session.rename(title)
          if (!result.ok) throw new Error(result.error.message)
        },
        forkSession: (sessionId: string) => {
          sessions.fork({ sessionId, increaseTitle: true })
            .then((childId) => { sessions.open(childId) })
            .catch(() => { /* 分叉失败保持当前选择（原生同姿势） */ })
        },
        archiveSession: (sessionId: string) => workspaces.archiveSession(sessionId),
      }),
    },
    GroupsEntry,
  ))
}

// ---------- Host API 客户端 ----------

interface GroupsView {
  groups: { id: string; title: string; order: number }[]
  membership: Record<string, string[]>
}

interface SessionRow {
  id: string
  displayTitle: string
  running: boolean
  /** 未打开时的「已完成」提醒；打开后清零（absent = false）。 */
  completed?: boolean
  blank: boolean
  origin?: 'subagent'
  updatedAt: number
}

interface SessionListLike {
  ids: string[]
  byId: Record<string, SessionRow>
  current: string | undefined
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) throw new Error(`${path} → HTTP ${String(response.status)}`)
  return await response.json() as T
}

const getGroups = (): Promise<GroupsView> => api<GroupsView>('/session-groups-api/groups')

const createGroup = (title: string): Promise<unknown> => api('/session-groups-api/groups', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title }),
})

const renameGroup = (id: string, title: string): Promise<unknown> =>
  api(`/session-groups-api/groups/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })

const deleteGroup = (id: string): Promise<unknown> =>
  api(`/session-groups-api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** 重排分组：ids = 拖拽后的分组 id 全序列（store 按此顺序重排数组）。 */
const reorderGroups = (ids: string[]): Promise<GroupsView> =>
  api<GroupsView>('/session-groups-api/groups/reorder', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  })

/** 取消归档：会话移出全局归档集，回到归档前的工作区位置（未分组可见）。 */
const unarchiveSession = (sessionId: string): Promise<void> =>
  api<void>('/session-groups-api/archive/unarchive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  }).then(() => {})

/** 彻底删除已归档会话：物理删除其存储目录，清归档账与分组记录。不可逆。 */
const deleteArchivedSession = (sessionId: string): Promise<void> =>
  api<void>('/session-groups-api/archive/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  }).then(() => {})

/** PUT 语义：传来的列表就是该会话的最终归属。返回刷新后的全量视图。 */
const assign = (sessionId: string, groupIds: string[]): Promise<GroupsView> =>
  api<GroupsView>('/session-groups-api/assignments', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, groupIds }),
  })

// ---------- 原生级样式系统（100% 对齐 ui-workspace / Rows.module.css） ----------

const s = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    fontFamily: 'var(--dsw-font-family)',
    marginTop: 8,
    marginBottom: 8,
  } as React.CSSProperties,
  entry: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 32, padding: '0 8px',
    border: 'none', borderRadius: 8,
    background: 'transparent', cursor: 'pointer',
    fontFamily: 'var(--dsw-font-family)', fontSize: 13, color: 'var(--dsw-alias-label-primary)',
    textAlign: 'left',
    transition: 'background 120ms ease',
    outline: 'none',
  } as React.CSSProperties,
  /* 一体化面板：无边框、无阴影、无独立底色——与侧栏直接相连，层级只靠缩进表达。
     块级流布局：子项永不收缩，保持 32px 设计行高；内容超过 maxHeight 时
     overflow-y:auto 在面板右侧出现独立滚动条（flex 布局会压缩子项导致重叠）。 */
  panel: {
    width: '100%',
    maxHeight: 280,
    overflowY: 'auto',
    scrollbarGutter: 'stable',
    fontSize: 13,
    color: 'var(--dsw-alias-label-primary)', userSelect: 'none',
    paddingTop: 2,
    paddingBottom: 4,
  } as React.CSSProperties,
  newRow: {
    display: 'flex', gap: 6, alignItems: 'center', padding: '2px 8px 6px 16px',
  } as React.CSSProperties,
  input: {
    flex: 1, minWidth: 0, height: 28, padding: '0 8px', fontSize: 12,
    border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 6,
    fontFamily: 'var(--dsw-font-family)', color: 'var(--dsw-alias-label-primary)',
    background: 'transparent',
    outline: 'none',
  } as React.CSSProperties,
  iconBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 24, height: 24, fontSize: 12, cursor: 'pointer',
    border: 'none', borderRadius: '50%', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    transition: 'background 100ms ease, color 100ms ease',
  } as React.CSSProperties,
  groupBlock: {
    marginBottom: 2,
    borderRadius: 8,
    overflow: 'hidden',
  } as React.CSSProperties,
  /* 分组行：相对外层「分组」行小幅缩进（16px，收紧后步进 12px）。 */
  groupHeader: {
    display: 'flex', alignItems: 'center', gap: 6,
    height: 32, padding: '0 8px 0 16px', borderRadius: 8, cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)',
    transition: 'background 100ms ease',
  } as React.CSSProperties,
  /* 会话行：与分组行同缩进（16px）——状态槽/复选框正好落在分组行图标的
     位置上，标题与分组标题几乎对齐，最紧凑的树形观感。 */
  sessionRow: {
    display: 'flex', alignItems: 'center', gap: 6,
    height: 32, padding: '0 8px 0 16px', borderRadius: 8, cursor: 'pointer',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 12,
    transition: 'background 100ms ease',
  } as React.CSSProperties,
  title: {
    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  } as React.CSSProperties,
  select: {
    width: 'calc(100% - 32px)', height: 28, margin: '2px 8px 6px 16px', padding: '0 6px', fontSize: 11,
    border: '0.5px dashed var(--dsw-alias-border-l4)', borderRadius: 6,
    background: 'transparent', color: 'var(--dsw-alias-label-tertiary)',
    fontFamily: 'var(--dsw-font-family)', cursor: 'pointer',
    outline: 'none',
  } as React.CSSProperties,
  hint: { padding: '6px 8px 6px 16px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } as React.CSSProperties,
  confirmBox: {
    display: 'flex', gap: 6, alignItems: 'center',
    margin: '2px 8px 4px 16px', padding: '6px 8px', fontSize: 12,
    background: 'var(--dsw-alias-interactive-bg-hover)', borderRadius: 8,
  } as React.CSSProperties,
  /* 确认条按钮：红底确认 + 普通取消（覆盖 iconBtn 的定宽定高）。 */
  confirmDangerBtn: {
    background: '#ef4444', color: '#fff', padding: '2px 8px',
    width: 'auto', height: 'auto', borderRadius: 4,
  } as React.CSSProperties,
  confirmCancelBtn: {
    padding: '2px 8px', width: 'auto', height: 'auto', borderRadius: 4,
  } as React.CSSProperties,
  /* 批量模式：状态槽内复选框（14px 居中于 16px 槽位，与状态点同位）。 */
  checkbox: {
    width: 14, height: 14, borderRadius: 4, flex: 'none', padding: 0,
    border: '0.5px solid var(--dsw-alias-border-l3)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', cursor: 'pointer',
    color: 'transparent',
    transition: 'background 100ms ease, border-color 100ms ease',
  } as React.CSSProperties,
  checkboxFaint: {
    opacity: 0.45,
  } as React.CSSProperties,
  checkboxOn: {
    background: 'var(--dsw-alias-label-primary)',
    borderColor: 'var(--dsw-alias-label-primary)',
    color: 'var(--dsw-specific-sidebar-fill)',
  } as React.CSSProperties,
  /* 会话行尾缀三件套（Rows.module.css 原生值）：状态槽 16px、时间列、悬停动作区。 */
  statusSlot: {
    flex: 'none', width: 16, height: 20, display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center',
    color: 'var(--dsw-alias-label-tertiary)',
  } as React.CSSProperties,
  time: {
    flex: 'none', fontSize: 12, lineHeight: '20px',
    color: 'var(--dsw-alias-label-tertiary)',
  } as React.CSSProperties,
  rowActions: {
    flex: 'none', display: 'inline-flex', alignItems: 'center',
    width: 16, height: 20, justifyContent: 'center',
  } as React.CSSProperties,
  iconButton: {
    flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 16, height: 16, border: 'none', borderRadius: 4, padding: 0,
    background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)',
  } as React.CSSProperties,
  /* 悬停卡正文（HoverCard 244 宽深色卡内，原生 hoverContent 同款排版）。 */
  hoverContent: {
    display: 'flex', flexDirection: 'column', gap: 8,
  } as React.CSSProperties,
  /* 重命名对话框输入（WorkspaceBrowser .renameInput 同款：44 高、22 圆角胶囊）。 */
  renameInput: {
    boxSizing: 'border-box', width: '100%', height: 44, padding: '7px 14px',
    border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 22, outline: 'none',
    background: 'transparent', fontSize: 14, fontWeight: 400, lineHeight: '22px',
    fontFamily: 'var(--dsw-font-family)',
    color: 'var(--dsw-alias-label-primary)',
  } as React.CSSProperties,
  hoverTitle: {
    fontSize: 14, lineHeight: '20px', color: '#FFFFFF', overflowWrap: 'break-word',
  } as React.CSSProperties,
  hoverTime: {
    fontSize: 12, lineHeight: '16px', color: '#CFD3D6',
  } as React.CSSProperties,
  hoverStatus: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 12, lineHeight: '20px', color: '#ADB2B8',
  } as React.CSSProperties,
  /* 自绘下拉菜单：大圆角 + 紧凑字号，质感对齐原生浮层。 */
  menuCard: {
    position: 'fixed', zIndex: 1100, width: 200, maxHeight: 320, overflowY: 'auto',
    padding: 5, display: 'flex', flexDirection: 'column', gap: 1,
    background: 'var(--dsw-specific-sidebar-fill)',
    border: '0.5px solid var(--dsw-alias-border-l4)',
    borderRadius: 14,
    boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
    fontFamily: 'var(--dsw-font-family)', fontSize: 12,
    color: 'var(--dsw-alias-label-primary)', userSelect: 'none',
  } as React.CSSProperties,
  menuRow: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 28,
    padding: '0 8px', flex: 'none',
    border: 'none', borderRadius: 9,
    background: 'transparent', cursor: 'pointer',
    fontFamily: 'var(--dsw-font-family)', fontSize: 12, textAlign: 'left',
    color: 'var(--dsw-alias-label-primary)',
    transition: 'background 100ms ease',
    outline: 'none',
  } as React.CSSProperties,
  menuRowDisabled: {
    opacity: 0.4, cursor: 'default',
  } as React.CSSProperties,
  menuSep: {
    height: 0.5, flex: 'none', margin: '4px 4px',
    background: 'var(--dsw-alias-border-l4)',
  } as React.CSSProperties,
}

/** useWorkspaces 快照中本插件消费的字段（ui-workspace 全局标准 hook）。 */
interface WorkspaceHookState {
  archivedSessionIds?: readonly string[]
  items?: readonly {
    workspaceId: string
    path: string
    sessionIds: readonly string[]
    createdAt: string
  }[]
}

// ---------- 常驻入口组件 ----------

function GroupsEntry(props: {
  wide: boolean
  useSessions: (selector: (state: never) => SessionListLike) => SessionListLike
  /** 会话级 pending 交互快照（approval/question/plan-review），驱动状态点。 */
  useSessionPendingInteraction?: (selector: (state: never) => Map<string, { kind: string }>) => Map<string, { kind: string }>
  /** 全局 Workspace 标准 hook（ui-workspace 发布）；归档名单 + 工作区解析。 */
  useWorkspaces?: (selector: (state: never) => WorkspaceHookState) => WorkspaceHookState
  openSession: (sessionId: string) => void
  /** 创建一个新会话并返回其 id（不打开）；可传 workspaceId 绑定工作区。 */
  createSession: (workspaceId?: string) => Promise<string>
  /** 会话重命名（per-session 动词）。 */
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** 分叉会话并打开子会话（失败保持当前选择）。 */
  forkSession: (sessionId: string) => void
  /** 归档会话（archive-set echo 后行自动消失）。 */
  archiveSession: (sessionId: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const [groupCount, setGroupCount] = useState(0)
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // 会话计数：与面板行的过滤口径一致（排除子代理/归档/非当前 blank），
  // 直接从框架 hook 派生，会话增删/归档实时反映。
  const countList = props.useSessions((state) => state)
  const countWorkspaces = props.useWorkspaces?.((state) => state)
  const countArchived = new Set(countWorkspaces?.archivedSessionIds ?? [])
  const sessionCount = countList.ids.reduce((count, id) => {
    const row = countList.byId[id]
    if (row === undefined) return count
    if (row.origin === 'subagent') return count
    if (countArchived.has(row.id)) return count
    if (row.blank && row.id !== countList.current) return count
    return count + 1
  }, 0)
  // 已归档计数：与面板已归档区同口径（排除子代理/非当前 blank）。
  const archivedCount = countList.ids.reduce((count, id) => {
    const row = countList.byId[id]
    if (row === undefined) return count
    if (row.origin === 'subagent') return count
    if (!countArchived.has(row.id)) return count
    if (row.blank && row.id !== countList.current) return count
    return count + 1
  }, 0)
  // 分组排序模式：最近活跃优先（默认）或手动（拖拽）。持久化到 localStorage。
  const [recentFirst, setRecentFirst] = useState<boolean>(() => {
    try { return window.localStorage.getItem('session-groups.recent-first') !== '0' }
    catch { return true }
  })
  const toggleRecentFirst = (): void => {
    setRecentFirst((prev) => {
      const next = !prev
      try { window.localStorage.setItem('session-groups.recent-first', next ? '1' : '0') }
      catch { /* 存储不可用时仅本页生效 */ }
      return next
    })
  }

  useEffect(() => {
    void getGroups().then((v) => {
      setGroupCount(v.groups.length)
      setGroupIds(v.groups.map((g) => g.id))
    }).catch(() => { /* 计数是装饰性数据，失败保持上一次值 */ })
  }, [refreshKey])

  // 全部展开 / 折叠（控制上移到外层行右侧）。未分组行共用同一状态表
  // （固定 key _ungrouped），因此一并纳入全开/全折的判定与写入。
  const UNGROUPED_KEY = '_ungrouped'
  const allExpanded = groupIds.length > 0
    && groupIds.every((gid) => expanded[gid] ?? true)
    && (expanded[UNGROUPED_KEY] ?? true)
  const toggleAll = (): void => {
    const next: Record<string, boolean> = { [UNGROUPED_KEY]: !allExpanded }
    for (const gid of groupIds) next[gid] = !allExpanded
    setExpanded(next)
  }

  // 新建分组（输入行渲染在展开面板顶部）
  const doCreate = (): void => {
    const title = newTitle.trim()
    if (!title) { setAdding(false); return }
    void createGroup(title).then(() => {
      setNewTitle('')
      setAdding(false)
      setRefreshKey((k) => k + 1)
    }).catch((error) => console.error('[session-groups]', error))
  }

  // 紧跟工作区：将 footerActions 移入 .regionArea 底部（工作区下方）
  useEffect(() => {
    if (!containerRef.current || !props.wide) return
    const el = containerRef.current
    const footerActions = el.closest('[class*="footerActions"]') as HTMLElement | null
    const footArea = footerActions?.parentElement as HTMLElement | null
    const sidebarRoot = footArea?.parentElement || document.querySelector('.root')
    const regionArea = sidebarRoot?.querySelector('[class*="regionArea"]') as HTMLElement | null

    if (regionArea && footerActions && footerActions.parentElement !== regionArea) {
      regionArea.appendChild(footerActions)
    }
  }, [props.wide])

  const buttonStyle = props.wide ? s.entry : {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 36, height: 36, padding: 0,
    border: 'none', background: 'transparent', cursor: 'pointer',
    borderRadius: '50%',
    color: 'var(--dsw-alias-label-primary)',
    outline: 'none',
  } as React.CSSProperties

  const containerStyle = props.wide ? s.container : {
    display: 'flex', justifyContent: 'center', width: '100%'
  } as React.CSSProperties

  return (
    <div ref={containerRef} style={containerStyle}>
      <button
        type="button"
        style={{
          ...buttonStyle,
          background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        }}
        aria-label="分组"
        aria-expanded={open}
        onClick={() => { if (props.wide) setOpen(!open) }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', width: 16, height: 16, justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)' }}>
          {hover && props.wide ? (
            <span style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 150ms var(--ds-ease-in-out)' }}>
              <IconTriangleRightFill14 size={11} />
            </span>
          ) : (
            open ? <IconFolderOpen16 size={15} /> : <IconFolderClose16 size={15} />
          )}
        </span>
        {props.wide ? (
          <span style={{ flex: 1, fontWeight: 500, marginLeft: 2, textAlign: 'left' }}>
            分组{groupCount > 0 ? `(${groupCount})` : ''}
          </span>
        ) : null}
        {/* 会话总数（组内 + 未分组，与面板行同口径），位于全部展开按钮左侧。 */}
        {props.wide && (
          <span
            title="未归档会话数（组内 + 未分组）"
            style={{
              flex: 'none', marginRight: 2, fontSize: 11, lineHeight: '16px',
              color: 'var(--dsw-alias-label-tertiary)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {sessionCount}
          </span>
        )}
        {/* 已归档数：带底色的小胶囊徽标（归档图标 + 数字），与左侧纯数字区分。 */}
        {props.wide && archivedCount > 0 && (
          <span
            title={`已归档会话数：${archivedCount}`}
            style={{
              flex: 'none', marginRight: 2, display: 'inline-flex', alignItems: 'center', gap: 2,
              height: 16, padding: '0 5px', borderRadius: 8, fontSize: 11, lineHeight: '16px',
              color: 'var(--dsw-alias-label-tertiary)',
              background: 'var(--dsw-alias-interactive-bg-hover)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <IconArchiveOutline20 size={10} />
            {archivedCount}
          </span>
        )}
        {/* 控制上移：排序模式 + 全部展开/折叠 + 新建分组，悬停行时显示 */}
        {props.wide && hover && (
          <span style={{ display: 'flex', gap: 1 }} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              style={{ ...s.iconBtn, background: recentFirst ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' }}
              title={recentFirst ? '按最近活跃排序分组（点击切换为手动拖拽排序）' : '手动拖拽排序分组（点击切换为按最近活跃排序）'}
              onClick={toggleRecentFirst}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = recentFirst ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' }}
            >
              <IconClockOutline16 size={14} />
            </button>
            <button
              type="button"
              style={s.iconBtn}
              title={allExpanded ? '全部折叠' : '全部展开'}
              onClick={toggleAll}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              {allExpanded ? '⊟' : '⊞'}
            </button>
            <button
              type="button"
              style={s.iconBtn}
              title="新建分组"
              onClick={() => { setOpen(true); setAdding(true) }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <IconPlusOutline16 size={14} />
            </button>
          </span>
        )}
      </button>
      {open && props.wide && (
        <>
          {adding && (
            <div style={s.newRow}>
              <input
                style={s.input}
                autoFocus
                value={newTitle}
                placeholder="输入分组名称..."
                onChange={(event) => { setNewTitle(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') doCreate()
                  if (event.key === 'Escape') setAdding(false)
                }}
              />
              <button
                type="button"
                style={{ ...s.iconBtn, background: 'var(--dsw-alias-interactive-bg-hover)' }}
                onClick={doCreate}
                title="确认"
              >✓</button>
              <button
                type="button"
                style={s.iconBtn}
                onClick={() => { setAdding(false) }}
                title="取消"
              ><IconCloseOutline16 size={12} /></button>
            </div>
          )}
          <GroupsInlinePanel
            openSession={props.openSession}
            createSession={props.createSession}
            useSessions={props.useSessions}
            useSessionPendingInteraction={props.useSessionPendingInteraction}
            useWorkspaces={props.useWorkspaces}
            renameSession={props.renameSession}
            forkSession={props.forkSession}
            archiveSession={props.archiveSession}
            recentFirst={recentFirst}
            expanded={expanded}
            setExpanded={setExpanded}
            onMetaChange={(count, ids) => { setGroupCount(count); setGroupIds(ids) }}
            onMutate={() => setRefreshKey((k) => k + 1)}
            refreshKey={refreshKey}
          />
        </>
      )}
    </div>
  )
}

// ---------- 一体化展开面板（无「分组」小标题栏，无 边框/阴影） ----------

function GroupsInlinePanel(props: {
  openSession: (sessionId: string) => void
  createSession: (workspaceId?: string) => Promise<string>
  useSessions: (selector: (state: never) => SessionListLike) => SessionListLike
  useSessionPendingInteraction?: (selector: (state: never) => Map<string, { kind: string }>) => Map<string, { kind: string }>
  useWorkspaces?: (selector: (state: never) => WorkspaceHookState) => WorkspaceHookState
  renameSession: (sessionId: string, title: string) => Promise<void>
  forkSession: (sessionId: string) => void
  archiveSession: (sessionId: string) => Promise<void>
  /** 分组排序模式：true = 最近活跃优先（自动），false = 手动拖拽序。 */
  recentFirst: boolean
  expanded: Record<string, boolean>
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  onMetaChange: (count: number, ids: string[]) => void
  onMutate: () => void
  refreshKey: number
}) {
  const list = props.useSessions((state) => state)
  // 与原生工作区同口径：归档会话在侧栏任何列表中不可见（tree.ts sessionVisible）。
  const workspacesState = props.useWorkspaces?.((state) => state)
  const archived = new Set(workspacesState?.archivedSessionIds ?? [])
  const workspaceItems = workspacesState?.items ?? []
  // pending 交互快照（原生 useSessionPendingInteraction 全局发布；缺省 = 空）。
  const pendingInteraction = props.useSessionPendingInteraction?.((state) => state)
  const [view, setView] = useState<GroupsView | null>(null)
  // 「组内新会话」安全网：即使创建时绑定了工作区，用户仍可能在空白 Hero 里
  // 另选工作区 —— DSH 会 recompose 出新 id 承载首条消息（旧 blank 永远空着）。
  // pendingCreateRef 记录待跟随的会话，current 变化时把归属迁移到新 id。
  const pendingCreateRef = useRef<{ sessionId: string; openedAt: number } | null>(null)
  const prevCurrentRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    void getGroups().then((v) => {
      setView(v)
      props.onMetaChange(v.groups.length, v.groups.map((g) => g.id))
    }).catch((error) => console.error('[session-groups]', error))
    // refreshKey 由外层的建组/删组等写操作递增，驱动这里重新拉取。
  }, [props.refreshKey])

  // ---------- 派生：分组 ⊕ 会话账本 ----------

  // 相对时间基准：30s 心跳（原生同粒度），仅当面板展开时有消费者。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { window.clearInterval(timer) }
  }, [])

  const groups = view?.groups ?? []
  const rawMembership = view?.membership ?? {}
  // 单归属视图归一化：历史多组数据只显示第一组（下次任何移动写入即收敛为单组）。
  const membership: Record<string, string[]> = {}
  for (const [sessionId, ids] of Object.entries(rawMembership)) {
    if (ids.length > 0) membership[sessionId] = [ids[0]]
  }
  const assigned = new Set(Object.keys(membership))
  // 物理删除没有官方列表帧（客户端摘要账本不会自动收到通知），本地记录
  // 已删除 id：归档帧把行从已归档区摘掉的同时，别让它在未分组里变幽灵。
  const [purged, setPurged] = useState<Set<string>>(new Set())
  // 原生口径：blank 行只有当前会话可见（provisional New Session 占位）。
  // 注意：必须先于 rows 派生声明（filter 闭包引用它）。
  const blankVisible = list.current !== undefined && list.byId[list.current]?.blank === true
    ? list.current
    : undefined
  const rows = list.ids
    .map((id) => list.byId[id])
    .filter((row) => row !== undefined
      && (row.blank ? row.id === blankVisible : true)
      && row.origin !== 'subagent'
      && !archived.has(row.id)
      && !purged.has(row.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const ungrouped = rows.filter((row) => !assigned.has(row.id))
  // 已归档行（与面板同口径：排除子代理/非当前 blank）。useSessions 列表本身
  // 包含已归档会话，直接与归档集求交即得；取消归档后 archived 帧到达，
  // 该行自动从这里消失并出现在未分组。
  const archivedRows = list.ids
    .map((id) => list.byId[id])
    .filter((row) => row !== undefined
      && archived.has(row.id)
      && row.origin !== 'subagent'
      && !(row.blank && row.id !== blankVisible)
      && !purged.has(row.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const byGroup = new Map<string, SessionRow[]>()
  for (const group of groups) byGroup.set(group.id, [])
  for (const row of rows) {
    for (const gid of membership[row.id] ?? []) byGroup.get(gid)?.push(row)
  }
  // 最近活跃优先排序（recentFirst）：组的活跃时间 = 组内可见会话的最新
  // updatedAt。聊天时 api-session/activity 实时推进该值 → hook 派生 → 排序
  // 自动跟随（与原生工作区「最近活动排前」同律）。没有可见会话的组沉底，
  // 彼此保持手动拖拽时的相对顺序（存储 order 决胜）。关闭开关 = 纯手动。
  const orderedGroups = (() => {
    if (!props.recentFirst) return groups
    const rank = new Map(groups.map((g, i) => [g.id, i] as const))
    const active = groups
      .map((g) => {
        let latest = 0
        for (const row of byGroup.get(g.id) ?? []) latest = Math.max(latest, row.updatedAt)
        return { group: g, latest }
      })
      .filter((e) => e.latest > 0)
      .sort((a, b) => b.latest - a.latest || (rank.get(a.group.id) ?? 0) - (rank.get(b.group.id) ?? 0))
    const idle = groups.filter((g) => !active.some((e) => e.group.id === g.id))
    return [...active.map((e) => e.group), ...idle]
  })()

  // ---------- 操作 ----------

  const fail = (error: unknown): void => { console.error('[session-groups]', error) }

  /** 单归属语义：加入分组 = 移动（替换为唯一归属）。 */
  const addTo = (sessionId: string, groupId: string): Promise<void> =>
    assign(sessionId, [groupId]).then((fresh) => { setView(fresh) }).catch(fail)
  const removeFrom = (sessionId: string, groupId: string): void => {
    void assign(sessionId, (membership[sessionId] ?? []).filter((gid) => gid !== groupId))
      .then(setView).catch(fail)
  }
  /** 批量/单行彻底删除：本地记账挡幽灵行，onMutate 刷新分组视图。 */
  const purgeArchived = (sessionIds: string[]): void => {
    if (sessionIds.length === 0) return
    setPurged((prev) => {
      const next = new Set(prev)
      for (const id of sessionIds) next.add(id)
      return next
    })
    void Promise.allSettled(sessionIds.map((id) => deleteArchivedSession(id)))
      .then(() => props.onMutate())
      .catch((reason: unknown) => console.warn('[session-groups] session delete rejected:', reason))
  }

  // recompose 跟随：pending 会话曾是 current，之后 current 变成另一个 id
  // （首条消息触发的工作区连接换掉了会话）→ 把 pending 的归属迁移到新 id。
  useEffect(() => {
    const pending = pendingCreateRef.current
    const prev = prevCurrentRef.current
    prevCurrentRef.current = list.current
    if (pending === null || prev !== pending.sessionId) return
    if (list.current === undefined || list.current === pending.sessionId) return
    // 只跟紧一段窗口（30s），避免把用户稍后的普通切会话误判成 recompose。
    if (Date.now() - pending.openedAt > 30_000) {
      pendingCreateRef.current = null
      return
    }
    const from = pending.sessionId
    const to = list.current
    pendingCreateRef.current = null
    const targetGroups = membership[from] ?? []
    if (targetGroups.length === 0) return
    // 单归属：迁移 = 把归属整体搬到新会话（老会话同时落回未分组）。
    void assign(to, targetGroups).then((fresh) => {
      setView(fresh)
      pendingCreateRef.current = null
    }).catch(fail)
    // membership/groups 是本次迁移的依据，view 拉取完成后它们必然已就绪。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.current])

  // ---------- 共享会话重命名对话框（分组行与未分组行共用） ----------

  const [sessionRenameTarget, setSessionRenameTarget] = useState<{ sessionId: string; currentTitle: string } | null>(null)
  const [sessionRenameDraft, setSessionRenameDraft] = useState('')
  const [sessionRenaming, setSessionRenaming] = useState(false)
  const [sessionRenameError, setSessionRenameError] = useState<string | null>(null)
  const composingRef = useRef(false)
  const sessionRenameTrimmed = sessionRenameDraft.trim()
  const sessionRenameBlocked = sessionRenaming || sessionRenameTrimmed === '' || sessionRenameTarget === null
  const closeSessionRename = (): void => {
    if (sessionRenaming) return
    setSessionRenameTarget(null)
    setSessionRenameError(null)
  }
  const confirmSessionRename = (): void => {
    if (sessionRenameBlocked) return
    setSessionRenaming(true)
    setSessionRenameError(null)
    props.renameSession(sessionRenameTarget.sessionId, sessionRenameTrimmed).then(() => {
      setSessionRenaming(false)
      setSessionRenameTarget(null)
    }).catch((reason: unknown) => {
      setSessionRenaming(false)
      setSessionRenameError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const openSessionRename = (sessionId: string, currentTitle: string): void => {
    setSessionRenameTarget({ sessionId, currentTitle })
    setSessionRenameDraft(currentTitle)
    setSessionRenameError(null)
  }

  // 「组内新会话」：绑定当前/最近工作区创建（同原生 New Session 语义），
  // 归属写入分组后打开。
  const newSessionInGroup = async (groupId: string): Promise<void> => {
    const currentRow = list.current !== undefined ? list.byId[list.current] : undefined
    const currentWorkspace = currentRow !== undefined
      ? workspaceItems.find((w) => w.sessionIds.includes(list.current as string))
      : undefined
    // 原生 startSession 口径：当前工作区 → 最近工作区（成员 updatedAt 最新者）→ 无绑定。
    const workspaceId = currentWorkspace?.workspaceId
      ?? workspaceItems.reduce<{ id: string; at: number } | undefined>((best, w) => {
        const latest = w.sessionIds.reduce((acc, sid) => Math.max(acc, list.byId[sid]?.updatedAt ?? 0), 0)
          || Date.parse(w.createdAt)
        return best === undefined || latest > best.at ? { id: w.workspaceId, at: latest } : best
      }, undefined)?.id
    const sessionId = await props.createSession(workspaceId)
    await addTo(sessionId, groupId)
    pendingCreateRef.current = { sessionId, openedAt: Date.now() }
    prevCurrentRef.current = sessionId
    props.openSession(sessionId)
  }

  // ---------- 渲染 ----------

  // 分组拖拽排序：HTML5 DnD，dragover 索引实时预览插入位，drop 落库。
  const [dragGroupId, setDragGroupId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const handleGroupDrop = (targetIndex: number): void => {
    const id = dragGroupId
    setDragGroupId(null)
    setDropIndex(null)
    if (id === null) return
    const from = groups.findIndex((g) => g.id === id)
    if (from < 0 || from === targetIndex || from + 1 === targetIndex) return
    const ids = groups.map((g) => g.id)
    ids.splice(from, 1)
    const insertAt = targetIndex > from ? targetIndex - 1 : targetIndex
    ids.splice(insertAt, 0, id)
    void reorderGroups(ids).then((fresh) => { setView(fresh); props.onMetaChange(fresh.groups.length, fresh.groups.map((g) => g.id)) }).catch(fail)
  }

  return (
    <div style={s.panel}>
      {orderedGroups.map((group, index) => {
        const items = byGroup.get(group.id) ?? []
        const isOpen = props.expanded[group.id] ?? true
        return (
          <GroupRowItem
            key={group.id}
            group={group}
            isOpen={isOpen}
            items={items}
            ungrouped={ungrouped}
            allGroups={groups}
            membership={membership}
            dragging={dragGroupId === group.id}
            isDropTarget={dropIndex === index && dragGroupId !== null && dragGroupId !== group.id}
            groupIndex={index}
            onDragStart={props.recentFirst ? undefined : () => setDragGroupId(group.id)}
            onDragEnd={() => { setDragGroupId(null); setDropIndex(null) }}
            onDragOverIndex={(hoverIndex) => setDropIndex(hoverIndex)}
            onDropAtIndex={() => handleGroupDrop(index)}
            onToggle={() => props.setExpanded((prev) => ({ ...prev, [group.id]: !isOpen }))}
            onRename={(gid, title) => renameGroup(gid, title).then(() => props.onMutate()).catch(fail)}
            onDelete={(gid) => deleteGroup(gid).then(() => props.onMutate()).catch(fail)}
            addTo={addTo}
            removeFrom={removeFrom}
            onMutate={props.onMutate}
            openSession={props.openSession}
            renameSession={props.renameSession}
            forkSession={props.forkSession}
            archiveSession={props.archiveSession}
            pendingInteraction={pendingInteraction}
            newSessionInGroup={() => newSessionInGroup(group.id)}
            blankVisible={blankVisible}
            currentSessionId={list.current}
            now={now}
            onRequestSessionRename={openSessionRename}
          />
        )
      })}
      {groups.length === 0 && <div style={s.hint}>暂无分组，悬停上方「分组」行点 ＋ 创建。</div>}

      <UngroupedRowItem
        isOpen={props.expanded['_ungrouped'] ?? true}
        items={ungrouped}
        onToggle={() => props.setExpanded((prev) => ({ ...prev, _ungrouped: !(prev['_ungrouped'] ?? true) }))}
        openSession={props.openSession}
        renameSession={props.renameSession}
        forkSession={props.forkSession}
        archiveSession={props.archiveSession}
        pendingInteraction={pendingInteraction}
        currentSessionId={list.current}
        now={now}
        groups={groups}
        membership={membership}
        onRequestSessionRename={openSessionRename}
        onMutate={props.onMutate}
      />

      <ArchivedRowItem
        isOpen={props.expanded['_archived'] ?? false}
        items={archivedRows}
        onToggle={() => props.setExpanded((prev) => ({ ...prev, _archived: !(prev['_archived'] ?? false) }))}
        openSession={props.openSession}
        renameSession={props.renameSession}
        onRequestSessionRename={openSessionRename}
        pendingInteraction={pendingInteraction}
        currentSessionId={list.current}
        now={now}
        onDelete={purgeArchived}
        onMutate={props.onMutate}
      />

      {/* 共享会话重命名对话框：分组行与未分组行都用它（Modal 挂在面板根部）。 */}
      <Modal
        open={sessionRenameTarget !== null}
        onClose={closeSessionRename}
        closeLabel="关闭"
        title="重命名会话"
        footer={(
          <>
            <Button variant="outline" disabled={sessionRenaming} onClick={closeSessionRename}>取消</Button>
            <Button variant="primary" disabled={sessionRenameBlocked} onClick={confirmSessionRename}>重命名</Button>
          </>
        )}
      >
        <input
          style={s.renameInput}
          value={sessionRenameDraft}
          aria-label="会话名称"
          autoFocus
          disabled={sessionRenaming}
          onFocus={(e) => { e.target.select() }}
          onChange={(e) => { setSessionRenameDraft(e.target.value); setSessionRenameError(null) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !composingRef.current) {
              e.preventDefault()
              confirmSessionRename()
            }
          }}
        />
        {sessionRenameError !== null && (
          <div role="alert" style={{ marginTop: 8, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary, #ef4444)' }}>
            {sessionRenameError}
          </div>
        )}
      </Modal>
    </div>
  )
}

// ---------- 原生级 GroupRowItem 组件 ----------

function GroupRowItem(props: {
  group: { id: string; title: string }
  isOpen: boolean
  items: SessionRow[]
  ungrouped: SessionRow[]
  allGroups: { id: string; title: string; order: number }[]
  membership: Record<string, string[]>
  onToggle: () => void
  onRename: (id: string, title: string) => Promise<unknown>
  onDelete: (id: string) => Promise<unknown>
  addTo: (sessionId: string, groupId: string) => Promise<void>
  removeFrom: (sessionId: string, groupId: string) => void
  onMutate: () => void
  openSession: (sessionId: string) => void
  /** 会话重命名（per-session 动词）。 */
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** 分叉会话并打开子会话。 */
  forkSession: (sessionId: string) => void
  /** 归档会话（archive-set echo 后行自动消失）。 */
  archiveSession: (sessionId: string) => Promise<void>
  /** pending 交互快照（原生 useSessionPendingInteraction；undefined = 未发布）。 */
  pendingInteraction?: Map<string, { kind: string }>
  /** 组内新会话：创建 → 加入本组 → 打开。 */
  newSessionInGroup: () => Promise<void>
  /** 当前 blank 会话 id（原生口径：blank 行只有当前时可见）。 */
  blankVisible: string | undefined
  currentSessionId: string | undefined
  /** 相对时间基准（30s 心跳）。 */
  now: number
  /** 请求打开共享的会话重命名对话框（GroupsInlinePanel 持有）。 */
  onRequestSessionRename: (sessionId: string, currentTitle: string) => void
  /** 拖拽排序（HTML5 DnD）：面板持有 drag 源与 drop 目标索引。 */
  dragging?: boolean
  isDropTarget?: boolean
  /** 本组在分组序列中的下标（拖拽插入位判定用）。 */
  groupIndex: number
  onDragStart?: () => void
  onDragEnd?: () => void
  onDragOverIndex?: (index: number | null) => void
  onDropAtIndex?: () => void
}) {
  const [hover, setHover] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(props.group.title)
  const [confirming, setConfirming] = useState(false)
  const [batch, setBatch] = useState(false)
  const [batchMenu, setBatchMenu] = useState(false)
  const [batchAnchor, setBatchAnchor] = useState<HTMLElement | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const batchWrapRef = useRef<HTMLSpanElement>(null)
  const [addMenu, setAddMenu] = useState(false)
  const [rowMenu, setRowMenu] = useState(false)
  const rowMenuBtnRef = useRef<HTMLButtonElement>(null)

  const fail = (error: unknown): void => { console.error('[session-groups]', error) }

  const exitBatch = (): void => {
    setBatch(false)
    setSelected(new Set())
  }

  const toggleSelect = (sessionId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const allSelected = props.items.length > 0 && props.items.every((row) => selected.has(row.id))
  const toggleSelectAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(props.items.map((row) => row.id)))
  }

  /** 单归属批量移动：未分组选中会话移入目标组（替换为唯一归属）。 */
  const moveSelectedTo = (targetGroupId: string): void => {
    if (selected.size === 0) return
    const ops = Array.from(selected).map((sessionId) => assign(sessionId, [targetGroupId]))
    void Promise.all(ops).then(() => { exitBatch(); props.onMutate() }).catch(fail)
  }

  /** 批量移出：选中会话仅离开当前组，其它归属保留。 */
  const removeSelected = (): void => {
    if (selected.size === 0) return
    const ops = Array.from(selected).map((sessionId) =>
      assign(sessionId, (props.membership[sessionId] ?? []).filter((gid) => gid !== props.group.id)))
    void Promise.all(ops).then(() => { exitBatch(); props.onMutate() }).catch(fail)
  }

  /** 批量归档：官方动词逐个提交，archived 帧 echo 后行自动消失。 */
  const archiveSelected = (): void => {
    if (selected.size === 0) return
    const ids = Array.from(selected)
    exitBatch()
    const ops = ids.map((sessionId) => props.archiveSession(sessionId))
    void Promise.allSettled(ops).then(() => props.onMutate()).catch(fail)
  }

  const otherGroups = props.allGroups.filter((g) => g.id !== props.group.id)

  // 归档无对话框：非破坏性（日志与账本槽位保留），菜单动作直接提交，失败仅控制台告警。
  const onSessionArchive = (sessionId: string): void => {
    props.archiveSession(sessionId).catch((reason: unknown) => {
      console.warn('[session-groups] session archive rejected:', reason)
    })
  }

  const handleRename = () => {
    const val = renameValue.trim()
    if (!val || val === props.group.title) {
      setRenaming(false)
      return
    }
    props.onRename(props.group.id, val)
      .then(() => setRenaming(false))
      .catch((err) => console.error(err))
  }

  return (
    <div
      style={{
        ...s.groupBlock,
        // 拖拽视觉反馈：源组半透明，目标组顶部出现插入线。
        opacity: props.dragging === true ? 0.4 : 1,
        boxShadow: props.isDropTarget === true
          ? 'inset 0 2px 0 0 var(--dsw-alias-state-business-primary)'
          : undefined,
      }}
      // 仅手动排序模式（onDragStart 有值）允许拖拽；自动排序时禁用，
      // 防止拖拽写入手动序后被自动排序覆盖造成困惑。
      draggable={props.onDragStart !== undefined}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', props.group.id)
        props.onDragStart?.()
      }}
      onDragEnd={() => props.onDragEnd?.()}
      onDragOver={(e) => {
        // 上半行 = 插到本组之前（index），下半行 = 插到本组之后（index+1）。
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const rect = e.currentTarget.getBoundingClientRect()
        props.onDragOverIndex?.(e.clientY - rect.top < rect.height / 2 ? props.groupIndex : props.groupIndex + 1)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) props.onDragOverIndex?.(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        props.onDropAtIndex?.()
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          ...s.groupHeader,
          background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        }}
        onClick={props.onToggle}
      >
        {/* 左侧折叠图标：未悬停时显示文件夹，悬停（Hover）时动态切换为三角形折叠指示器 */}
        <span style={{ display: 'inline-flex', alignItems: 'center', width: 16, height: 16, justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)' }}>
          {hover ? (
            <span style={{ display: 'inline-flex', transform: props.isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 150ms var(--ds-ease-in-out)' }}>
              <IconTriangleRightFill14 size={11} />
            </span>
          ) : (
            props.isOpen ? <IconFolderOpen16 size={15} /> : <IconFolderClose16 size={15} />
          )}
        </span>

        {renaming ? (
          <input
            style={s.input}
            autoFocus
            value={renameValue}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename()
              if (e.key === 'Escape') {
                setRenameValue(props.group.title)
                setRenaming(false)
              }
            }}
          />
        ) : (
          <span style={{ ...s.title, fontWeight: 500, marginLeft: 2 }}>
            {props.group.title}({props.items.length})
          </span>
        )}

        {/* 动作按钮组：悬停时显示；批量/菜单打开期间常驻（鼠标去点 portal 菜单时行已不 hover） */}
        {(hover || batch || rowMenu || addMenu) && !renaming && (
          <span
            ref={batchWrapRef}
            style={{ display: 'flex', gap: 1, position: 'relative' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 批量操作：首次点击进入批量并弹出菜单；再次点击仅切换菜单开/关（退出走菜单里的「取消批量」） */}
            <button
              type="button"
              style={{ ...s.iconBtn, background: batch ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' }}
              title="批量操作"
              onClick={() => {
                if (!batch) {
                  setSelected(new Set())
                  setBatch(true)
                  setBatchAnchor(batchWrapRef.current)
                  setBatchMenu(true)
                  setRowMenu(false)
                  setAddMenu(false)
                } else {
                  setBatchAnchor(batchWrapRef.current)
                  setBatchMenu((v) => !v)
                }
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
              onMouseLeave={(e) => { if (!batch) e.currentTarget.style.background = 'transparent' }}
            >
              <IconChecklistOutline14 size={14} />
            </button>
            {/* 组操作聚合菜单：重命名 / 添加会话 / 删除分组 */}
            <button
              type="button"
              ref={rowMenuBtnRef}
              style={{ ...s.iconBtn, background: rowMenu ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' }}
              title="分组操作"
              onClick={() => { setRowMenu((v) => !v); setAddMenu(false) }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
              onMouseLeave={(e) => { if (!rowMenu) e.currentTarget.style.background = 'transparent' }}
            >
              <IconEllipsisOutline16 />
            </button>
            {/* 组内新会话：创建 → 加入本组 → 打开 */}
            <button
              type="button"
              style={s.iconBtn}
              title="新会话"
              onClick={() => {
                void props.newSessionInGroup().catch((error) => console.error('[session-groups]', error))
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <IconPlusOutline16 size={14} />
            </button>
          </span>
        )}
        {batchMenu && batchAnchor && (
          <BatchDropdown
            anchorEl={batchAnchor}
            selectedCount={selected.size}
            allSelected={allSelected}
            otherGroups={otherGroups}
            onToggleAll={toggleSelectAll}
            onMoveTo={moveSelectedTo}
            onRemove={removeSelected}
            onArchive={archiveSelected}
            onExit={exitBatch}
            onClose={() => setBatchMenu(false)}
          />
        )}
        {rowMenu && rowMenuBtnRef.current && (
          <GroupActionsDropdown
            anchorEl={rowMenuBtnRef.current}
            hasUngrouped={props.ungrouped.length > 0}
            onRename={() => { setRowMenu(false); setRenameValue(props.group.title); setRenaming(true) }}
            onAddSessions={() => { setRowMenu(false); setAddMenu(true) }}
            onDelete={() => { setRowMenu(false); setConfirming(true) }}
            onClose={() => setRowMenu(false)}
          />
        )}
        {addMenu && rowMenuBtnRef.current && (
          <AddSessionDropdown
            anchorEl={rowMenuBtnRef.current}
            sessions={props.ungrouped}
            onPick={(sessionId) => { props.addTo(sessionId, props.group.id); setAddMenu(false) }}
            onClose={() => setAddMenu(false)}
          />
        )}
      </div>

      {confirming && (
        <div style={s.confirmBox} onClick={(e) => e.stopPropagation()}>
          <span>确认删除该分组？</span>
          <button
            type="button"
            style={{ ...s.iconBtn, background: '#ef4444', color: '#fff', padding: '2px 8px', width: 'auto', height: 'auto', borderRadius: 4 }}
            onClick={() => { props.onDelete(props.group.id); setConfirming(false) }}
          >删除</button>
          <button
            type="button"
            style={{ ...s.iconBtn, padding: '2px 8px', width: 'auto', height: 'auto', borderRadius: 4 }}
            onClick={() => setConfirming(false)}
          >取消</button>
        </div>
      )}

      {props.isOpen && !renaming && (
        <div>
          {props.items.map((row) => (
            <SessionLine
              key={row.id}
              session={row}
              current={row.id === props.currentSessionId}
              now={props.now}
              pendingInteraction={props.pendingInteraction?.get(row.id)}
              onOpen={props.openSession}
              onRename={props.onRequestSessionRename}
              onFork={props.forkSession}
              onArchive={onSessionArchive}
              onMoveTo={(targetGroupId) => {
                // 单归属移动：整体替换为 [目标组]。
                void assign(row.id, [targetGroupId]).then(props.onMutate).catch(fail)
              }}
              onRemove={() => { props.removeFrom(row.id, props.group.id) }}
              otherGroups={otherGroups}
              batch={props.isOpen && batch}
              checked={selected.has(row.id)}
              onToggle={() => toggleSelect(row.id)}
            />
          ))}
          {props.items.length === 0 && <div style={s.hint}>暂无会话</div>}
        </div>
      )}
    </div>
  )
}

// ---------- 原生级 UngroupedRowItem 组件 ----------

function UngroupedRowItem(props: {
  isOpen: boolean
  items: SessionRow[]
  onToggle: () => void
  openSession: (sessionId: string) => void
  renameSession: (sessionId: string, title: string) => Promise<void>
  forkSession: (sessionId: string) => void
  archiveSession: (sessionId: string) => Promise<void>
  /** pending 交互快照（原生 useSessionPendingInteraction；undefined = 未发布）。 */
  pendingInteraction?: Map<string, { kind: string }>
  currentSessionId: string | undefined
  /** 相对时间基准（30s 心跳）。 */
  now: number
  /** 全部分组（移动到 的候选）。 */
  groups: { id: string; title: string }[]
  membership: Record<string, string[]>
  /** 请求打开共享的会话重命名对话框（GroupsInlinePanel 持有）。 */
  onRequestSessionRename: (sessionId: string, currentTitle: string) => void
  /** 任何归属写操作后的视图刷新。 */
  onMutate: () => void
}) {
  const [hover, setHover] = useState(false)
  // 批量模式（组行同构）：选中集合 + 操作下拉；没有「移出分组」（本来就在组外）。
  const [batch, setBatch] = useState(false)
  const [batchMenu, setBatchMenu] = useState(false)
  const [batchAnchor, setBatchAnchor] = useState<HTMLElement | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const batchWrapRef = useRef<HTMLSpanElement>(null)
  const fail = (error: unknown): void => { console.error('[session-groups]', error) }

  const exitBatch = (): void => {
    setBatch(false)
    setBatchMenu(false)
    setSelected(new Set())
  }

  const toggleSelect = (sessionId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const allSelected = props.items.length > 0 && props.items.every((row) => selected.has(row.id))
  const toggleSelectAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(props.items.map((row) => row.id)))
  }

  /** 单归属批量移动：未分组选中会话移入目标组（替换为唯一归属）。 */
  const moveSelectedTo = (targetGroupId: string): void => {
    if (selected.size === 0) return
    const ops = Array.from(selected).map((sessionId) => assign(sessionId, [targetGroupId]))
    void Promise.all(ops).then(() => { exitBatch(); props.onMutate() }).catch(fail)
  }

  /** 批量归档：官方动词逐个提交，archived 帧 echo 后行自动消失。 */
  const archiveSelected = (): void => {
    if (selected.size === 0) return
    const ids = Array.from(selected)
    exitBatch()
    const ops = ids.map((sessionId) => props.archiveSession(sessionId))
    void Promise.allSettled(ops).then(() => props.onMutate()).catch(fail)
  }

  return (
    <div
      style={s.groupBlock}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          ...s.groupHeader,
          background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          cursor: 'pointer',
        }}
        onClick={props.onToggle}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', width: 16, height: 16, justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)' }}>
          {hover ? (
            <span style={{ display: 'inline-flex', transform: props.isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 150ms var(--ds-ease-in-out)' }}>
              <IconTriangleRightFill14 size={11} />
            </span>
          ) : (
            props.isOpen ? <IconFolderOpen16 size={15} /> : <IconFolderClose16 size={15} />
          )}
        </span>
        <span style={{ ...s.title, fontWeight: 500, color: 'var(--dsw-alias-label-tertiary)', marginLeft: 2 }}>
          未分组({props.items.length})
        </span>
        {/* 批量操作按钮：悬停行（或批量进行中）时显示 */}
        {(hover || batch) && (
          <span
            ref={batchWrapRef}
            style={{ display: 'flex', gap: 1, position: 'relative' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              style={{ ...s.iconBtn, background: batch ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' }}
              title="批量操作"
              onClick={() => {
                if (!batch) {
                  setSelected(new Set())
                  setBatch(true)
                  setBatchAnchor(batchWrapRef.current)
                  setBatchMenu(true)
                } else {
                  setBatchAnchor(batchWrapRef.current)
                  setBatchMenu((v) => !v)
                }
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
              onMouseLeave={(e) => { if (!batch) e.currentTarget.style.background = 'transparent' }}
            >
              <IconChecklistOutline14 size={14} />
            </button>
          </span>
        )}
      </div>
      {batchMenu && batchAnchor && (
        <BatchDropdown
          anchorEl={batchAnchor}
          selectedCount={selected.size}
          allSelected={allSelected}
          otherGroups={props.groups}
          onToggleAll={toggleSelectAll}
          onMoveTo={moveSelectedTo}
          showRemove={false}
          onRemove={() => {}}
          onArchive={archiveSelected}
          onExit={exitBatch}
          onClose={() => setBatchMenu(false)}
        />
      )}
      {props.isOpen && (
        <div>
          {props.items.map((row) => (
            <SessionLine
              key={row.id}
              session={row}
              current={row.id === props.currentSessionId}
              now={props.now}
              pendingInteraction={props.pendingInteraction?.get(row.id)}
              onOpen={props.openSession}
              onRename={props.onRequestSessionRename}
              onFork={props.forkSession}
              onArchive={(sessionId) => {
                props.archiveSession(sessionId).catch((reason: unknown) => {
                  console.warn('[session-groups] session archive rejected:', reason)
                })
              }}
              onMoveTo={(targetGroupId) => {
                // 单归属移动：整体替换为 [目标组]。
                void assign(row.id, [targetGroupId]).then(props.onMutate).catch(fail)
              }}
              otherGroups={props.groups}
              batch={props.isOpen && batch}
              checked={selected.has(row.id)}
              onToggle={() => toggleSelect(row.id)}
            />
          ))}
          {props.items.length === 0 && <div style={s.hint}>暂无未分组会话</div>}
        </div>
      )}
    </div>
  )
}

// ---------- 已归档区（归档行：批量 全选/取消归档/取消批量；行菜单 重命名/取消归档） ----------

function ArchivedRowItem(props: {
  isOpen: boolean
  items: SessionRow[]
  onToggle: () => void
  openSession: (sessionId: string) => void
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** 请求打开共享的会话重命名对话框（GroupsInlinePanel 持有）。 */
  onRequestSessionRename: (sessionId: string, currentTitle: string) => void
  /** 彻底删除（单个或批量）：由 GroupsInlinePanel 统一记账并调用 API。 */
  onDelete: (sessionIds: string[]) => void
  pendingInteraction?: Map<string, { kind: string }>
  currentSessionId: string | undefined
  now: number
  onMutate: () => void
}) {
  const [hover, setHover] = useState(false)
  const [batch, setBatch] = useState(false)
  const [batchMenu, setBatchMenu] = useState(false)
  const [batchAnchor, setBatchAnchor] = useState<HTMLElement | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // 批量彻底删除的二次确认：菜单点击先挂起勾选快照，确认条里再执行。
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null)
  const batchWrapRef = useRef<HTMLSpanElement>(null)
  const fail = (error: unknown): void => { console.error('[session-groups]', error) }

  const exitBatch = (): void => {
    setBatch(false)
    setBatchMenu(false)
    setSelected(new Set())
    setConfirmIds(null)
  }

  const toggleSelect = (sessionId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const allSelected = props.items.length > 0 && props.items.every((row) => selected.has(row.id))
  const toggleSelectAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(props.items.map((row) => row.id)))
  }

  /** 批量取消归档：全部移出归档集（回到未分组）；官方 feed echo 后行自动消失。 */
  const unarchiveSelected = (): void => {
    if (selected.size === 0) return
    const ops = Array.from(selected).map((sessionId) => unarchiveSession(sessionId))
    void Promise.allSettled(ops).then(() => { exitBatch(); props.onMutate() })
      .catch(fail)
  }

  /** 批量彻底删除：先二次确认，确认后物理删除选中会话的存储目录（不可逆）。 */
  const deleteSelected = (): void => {
    if (selected.size === 0) return
    setBatchMenu(false)
    setConfirmIds(Array.from(selected))
  }

  return (
    <div
      style={s.groupBlock}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          ...s.groupHeader,
          background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          cursor: 'pointer',
        }}
        onClick={props.onToggle}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', width: 16, height: 16, justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)' }}>
          {hover ? (
            <span style={{ display: 'inline-flex', transform: props.isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 150ms var(--ds-ease-in-out)' }}>
              <IconTriangleRightFill14 size={11} />
            </span>
          ) : (
            props.isOpen ? <IconFolderOpen16 size={15} /> : <IconArchiveOutline20 size={15} />
          )}
        </span>
        <span style={{ ...s.title, fontWeight: 500, color: 'var(--dsw-alias-label-tertiary)', marginLeft: 2 }}>
          已归档({props.items.length})
        </span>
        {(hover || batch) && (
          <span
            ref={batchWrapRef}
            style={{ display: 'flex', gap: 1, position: 'relative' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              style={{ ...s.iconBtn, background: batch ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' }}
              title="批量操作"
              onClick={() => {
                if (!batch) {
                  setSelected(new Set())
                  setBatch(true)
                  setBatchAnchor(batchWrapRef.current)
                  setBatchMenu(true)
                } else {
                  setBatchAnchor(batchWrapRef.current)
                  setBatchMenu((v) => !v)
                }
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
              onMouseLeave={(e) => { if (!batch) e.currentTarget.style.background = 'transparent' }}
            >
              <IconChecklistOutline14 size={14} />
            </button>
          </span>
        )}
      </div>
      {batchMenu && batchAnchor && (
        <BatchDropdown
          anchorEl={batchAnchor}
          selectedCount={selected.size}
          allSelected={allSelected}
          otherGroups={[]}
          onToggleAll={toggleSelectAll}
          onMoveTo={() => {}}
          showRemove={false}
          onRemove={() => {}}
          onUnarchive={unarchiveSelected}
          onDeleteSelected={deleteSelected}
          onExit={exitBatch}
          onClose={() => setBatchMenu(false)}
        />
      )}
      {confirmIds !== null && (
        <div style={s.confirmBox} onClick={(e) => e.stopPropagation()}>
          <span>彻底删除选中的 {confirmIds.length} 个会话？不可恢复。</span>
          <button
            type="button"
            style={{ ...s.iconBtn, ...s.confirmDangerBtn }}
            onClick={() => {
              const ids = confirmIds
              setConfirmIds(null)
              exitBatch()
              props.onDelete(ids)
            }}
          >删除</button>
          <button
            type="button"
            style={{ ...s.iconBtn, ...s.confirmCancelBtn }}
            onClick={() => setConfirmIds(null)}
          >取消</button>
        </div>
      )}
      {props.isOpen && (
        <div>
          {props.items.map((row) => (
            <ArchivedSessionLine
              key={row.id}
              session={row}
              current={row.id === props.currentSessionId}
              now={props.now}
              pendingInteraction={props.pendingInteraction?.get(row.id)}
              onOpen={props.openSession}
              onRename={props.onRequestSessionRename}
              onUnarchive={() => {
                unarchiveSession(row.id).then(props.onMutate).catch((reason: unknown) => {
                  console.warn('[session-groups] session unarchive rejected:', reason)
                })
              }}
              onDelete={() => props.onDelete([row.id])}
              batch={props.isOpen && batch}
              checked={selected.has(row.id)}
              onToggle={() => toggleSelect(row.id)}
            />
          ))}
          {props.items.length === 0 && <div style={s.hint}>暂无已归档会话</div>}
        </div>
      )}
    </div>
  )
}

/** 已归档会话行：菜单只有 重命名 / 取消归档 / 删除会话 三项（无分叉/归档/移动）。 */
function ArchivedSessionLine(props: {
  session: SessionRow
  current: boolean
  now: number
  pendingInteraction?: { kind: string }
  onOpen: (sessionId: string) => void
  onRename: (sessionId: string, currentTitle: string) => void
  onUnarchive: () => void
  /** 请求彻底删除本会话；删除前由行内确认条二次确认。 */
  onDelete: () => void
  batch?: boolean
  checked?: boolean
  onToggle?: () => void
}) {
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // 单行彻底删除的二次确认条：确认后物理删除（不可逆）。
  const [confirming, setConfirming] = useState(false)
  const session = props.session
  const statuses = sessionStatuses(props.pendingInteraction?.kind, session.running, session.completed === true)
  const ownRow = (
    <div
      style={{
        ...s.sessionRow,
        background: (hover || menuOpen) ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        fontWeight: props.current ? 600 : 400,
        // 归档行整体降一档亮度，与未分组行区分。
        color: props.current ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
      }}
      onMouseEnter={() => { setHover(true) }}
      onMouseLeave={() => { setHover(false) }}
      onClick={() => {
        if (confirming) return
        if (menuOpen) setMenuOpen(false)
        if (props.batch) props.onToggle?.()
        else props.onOpen(session.id)
      }}
    >
      <span style={s.statusSlot}>
        {props.batch
          ? (
            <span
              role="checkbox"
              aria-checked={props.checked}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 20 }}
              onClick={(e) => { e.stopPropagation(); props.onToggle?.() }}
            >
              <span style={{ ...s.checkbox, ...((props.checked || hover) ? {} : s.checkboxFaint), ...(props.checked ? s.checkboxOn : {}) }}>
                {props.checked && <IconCheckOutline16 size={10} />}
              </span>
            </span>
          )
          : (statuses[0].state !== 'done' || session.completed === true) && <StateDot state={statuses[0].state} />}
      </span>
      <span style={s.title}>{session.displayTitle}</span>
      {(!session.blank && !(hover || menuOpen)) && (
        <span style={s.time}>{timeLabel(session.updatedAt, props.now)}</span>
      )}
      {!session.blank && (hover || menuOpen) && (
        <span style={s.rowActions}>
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            portal
            closeOnPointerLeave
            compact
            items={[
              { id: 'rename', label: '重命名', icon: <IconEditOutline16 />, disabled: session.blank },
              { id: 'unarchive', label: '取消归档', icon: <IconArchiveOutline20 size={16} /> },
              { id: 'delete', label: '删除会话', icon: <IconTrashOutline16 size={16} /> },
            ]}
            onSelect={(id) => {
              setMenuOpen(false)
              if (id === 'rename') props.onRename(session.id, session.displayTitle)
              if (id === 'unarchive') props.onUnarchive()
              if (id === 'delete') setConfirming(true)
            }}
            anchor={(
              <button
                type="button"
                style={s.iconButton}
                aria-label={`归档会话操作：${session.displayTitle}`}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
        </span>
      )}
    </div>
  )
  return (
    <div>
      <HoverCard
        anchor={ownRow}
        disabled={menuOpen || confirming}
        copyText={session.blank ? undefined : session.displayTitle}
        copyLabel="复制"
        copiedLabel="已复制"
        content={(
          <div style={s.hoverContent}>
            <div style={s.hoverTitle}>{session.displayTitle}</div>
            <div style={s.hoverTime}>{hoverTimeLabel(session.updatedAt, props.now)}</div>
            {statuses.map(status => (
              <div key={status.label} style={s.hoverStatus}>
                <StateDot state={status.state} />
                <span>{status.label}</span>
              </div>
            ))}
          </div>
        )}
      />
      {confirming && (
        <div style={s.confirmBox}>
          <span>彻底删除「{session.displayTitle}」？不可恢复。</span>
          <button
            type="button"
            style={{ ...s.iconBtn, ...s.confirmDangerBtn }}
            onClick={(e) => { e.stopPropagation(); setConfirming(false); props.onDelete() }}
          >删除</button>
          <button
            type="button"
            style={{ ...s.iconBtn, ...s.confirmCancelBtn }}
            onClick={(e) => { e.stopPropagation(); setConfirming(false) }}
          >取消</button>
        </div>
      )}
    </div>
  )
}

// ---------- 原生风格会话行（Rows.tsx SessionNodeItem 同构） ----------

/** 原生相对时间口径（ui-primitives relativeTime 的 zh 文案）。 */
function timeLabel(updatedAt: number, now: number): string {
  const diff = Math.max(0, now - updatedAt)
  if (diff < 60_000) return '刚刚'
  const n = (unit: number): number => Math.floor(diff / unit)
  if (diff < 3_600_000) return `${n(60_000)}分钟`
  if (diff < 86_400_000) return `${n(3_600_000)}小时`
  if (diff < 30 * 86_400_000) return `${n(86_400_000)}天`
  if (diff < 365 * 86_400_000) return `${n(30 * 86_400_000)}个月`
  return `${n(365 * 86_400_000)}年`
}

/** 悬停卡变体：ago 模板；now 桶保持裸值（不出现「刚刚前」）。 */
function hoverTimeLabel(updatedAt: number, now: number): string {
  const diff = Math.max(0, now - updatedAt)
  if (diff < 60_000) return '刚刚'
  const n = (unit: number): number => Math.floor(diff / unit)
  if (diff < 3_600_000) return `${n(60_000)}分钟前`
  if (diff < 86_400_000) return `${n(3_600_000)}小时前`
  if (diff < 30 * 86_400_000) return `${n(86_400_000)}天前`
  if (diff < 365 * 86_400_000) return `${n(30 * 86_400_000)}个月前`
  return `${n(365 * 86_400_000)}年前`
}

/** 绝对创建时间（date.ymd + hover.created 模板，消息时钟同款）。 */
function createdLabel(createdAt: number): string {
  const d = new Date(createdAt)
  const pad2 = (v: number): string => String(v).padStart(2, '0')
  return `创建于 ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 状态口径与 Rows.tsx sessionStatuses 一致（子代理数在列表行不可得，略）。 */
function sessionStatuses(pendingKind: string | undefined, running: boolean, completed: boolean): {
  state: StateDotState
  label: string
}[] {
  if (pendingKind !== undefined) {
    const label = pendingKind === 'approval' ? '等待审批'
      : pendingKind === 'plan-review' ? '计划待审' : '等待回答'
    return [{ state: 'warning', label }]
  }
  if (running) return [{ state: 'ongoing', label: '进行中' }]
  if (completed) return [{ state: 'done', label: '已完成' }]
  return [{ state: 'done', label: '空闲' }]
}

function SessionLine(props: {
  session: SessionRow
  current: boolean
  /** 相对时间基准（parent 的 30s 心跳）。 */
  now: number
  /** 该会话当前 pending 交互（undefined = 无）。 */
  pendingInteraction?: { kind: string }
  onOpen: (sessionId: string) => void
  onRename: (sessionId: string, currentTitle: string) => void
  onFork: (sessionId: string) => void
  onArchive: (sessionId: string) => void
  /** 移动到目标分组（会话保留其它既有归属）。 */
  onMoveTo: (targetGroupId: string) => void
  /** 移除分组（落到未分组，其它归属保留）；undefined = 无此动作（未分组行）。 */
  onRemove?: () => void
  /** 除当前组以外的分组清单（移动到 的子菜单）。 */
  otherGroups: { id: string; title: string }[]
  batch?: boolean
  checked?: boolean
  onToggle?: () => void
}) {
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const session = props.session
  const statuses = sessionStatuses(props.pendingInteraction?.kind, session.running, session.completed === true)
  const primaryStatus = statuses[0]
  // 未提交重命名的会话没有可 fork/重命名的内容 — 菜单仍开但三项动作禁用
  // （原生注释：actions would act on content that does not exist）。
  const actionsUsable = !session.blank
  const ownRow = (
    <div
      style={{
        ...s.sessionRow,
        // 批量不改行首缩进：复选框住进行首 16px 状态槽（运行图标的原位），
        // 行内容零位移；与状态点的冲突用「悬停时点↔框交换」解决。
        background: (hover || menuOpen) ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        fontWeight: props.current ? 600 : 400,
        color: props.current ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
      }}
      onMouseEnter={() => { setHover(true) }}
      onMouseLeave={() => { setHover(false) }}
      onClick={() => {
        // 菜单开着时点击行体：原生是「outside-close + 行点击」两个动作的合成
        // （Menu root 只包触发按钮）；这里 Menu root 包住整行，需显式关菜单。
        if (menuOpen) setMenuOpen(false)
        if (props.batch) props.onToggle?.()
        else props.onOpen(session.id)
      }}
    >
      {/* 行首状态槽：非批量显示状态点；批量时优先显示复选框，但未勾选且
          有状态点（运行/等待）的行平时照常显示点、悬停才换成复选框——
          运行图标与选择框不再互相顶掉，选中状态始终可见。 */}
      <span style={s.statusSlot}>
        {props.batch
          ? (
            <span
              role="checkbox"
              aria-checked={props.checked}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 20 }}
              onClick={(e) => { e.stopPropagation(); props.onToggle?.() }}
            >
              <span style={{ ...s.checkbox, ...((props.checked || hover) ? {} : s.checkboxFaint), ...(props.checked ? s.checkboxOn : {}) }}>
                {props.checked && <IconCheckOutline16 size={10} />}
              </span>
            </span>
          )
          : (primaryStatus.state !== 'done' || session.completed === true) && <StateDot state={primaryStatus.state} />}
      </span>
      <span style={s.title}>{session.displayTitle}</span>
      {/* 悬停/菜单开时时间列换成省略号按钮（原生 CSS-only swap）。 */}
      {(!session.blank && !(hover || menuOpen)) && (
        <span style={s.time}>{timeLabel(session.updatedAt, props.now)}</span>
      )}
      {!session.blank && (hover || menuOpen) && (
        <span style={s.rowActions}>
          {/* Menu 只包省略号按钮（原生 Rows.tsx 同构）：portal 放置测的矩形
              是按钮本身，菜单贴着按钮弹出；HoverCard 在外层包整行。 */}
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            portal
            closeOnPointerLeave
            compact
            items={[
              { id: 'rename', label: '重命名', icon: <IconEditOutline16 />, disabled: !actionsUsable },
              { id: 'fork', label: '分叉会话', icon: <IconBranchOutline16 />, disabled: !actionsUsable },
              { id: 'archive', label: '归档会话', icon: <IconArchiveOutline20 size={16} />, disabled: !actionsUsable },
              { type: 'separator', id: 'sep' },
              {
                id: 'move',
                label: '移动到',
                icon: <IconFolderClose16 size={14} />,
                disabled: props.otherGroups.length === 0,
                submenu: props.otherGroups.map(g => ({ id: `move:${g.id}`, label: g.title })),
              },
              // 未分组行的会话本就在组外，没有「移除分组」动作（props.onRemove 为
              // no-op 时由调用方省略此项）。
              ...(props.onRemove === undefined ? [] : [{ id: 'remove', label: '移除分组', icon: <IconCloseOutline16 size={14} /> } as const]),
            ]}
            onSelect={(id) => {
              setMenuOpen(false)
              if (id === 'rename') props.onRename(session.id, session.displayTitle)
              if (id === 'fork') props.onFork(session.id)
              if (id === 'archive') props.onArchive(session.id)
              if (id === 'remove') props.onRemove?.()
              if (id.startsWith('move:')) props.onMoveTo(id.slice('move:'.length))
            }}
            anchor={(
              <button
                type="button"
                style={s.iconButton}
                aria-label={`会话操作：${session.displayTitle}`}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
        </span>
      )}
    </div>
  )
  return (
    <HoverCard
      anchor={ownRow}
      disabled={menuOpen}
      copyText={session.blank ? undefined : session.displayTitle}
      copyLabel="复制"
      copiedLabel="已复制"
      content={(
        <div style={s.hoverContent}>
          <div style={s.hoverTitle}>{session.displayTitle}</div>
          <div style={s.hoverTime}>{hoverTimeLabel(session.updatedAt, props.now)}</div>
          {statuses.map(status => (
            <div key={status.label} style={s.hoverStatus}>
              <StateDot state={status.state} />
              <span>{status.label}</span>
            </div>
          ))}
        </div>
      )}
    />
  )
}

// ---------- 分组操作聚合下拉（… 图标：重命名 / 添加会话 / 删除分组） ----------

function GroupActionsDropdown(props: {
  anchorEl: HTMLElement
  hasUngrouped: boolean
  onRename: () => void
  onAddSessions: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 })
  const listRef = useRef<HTMLDivElement>(null)

  // 向右上弹出：底缘贴按钮顶缘上方 4px、右缘对齐；放不下翻到下方，钳制视口。
  useEffect(() => {
    const place = (): void => {
      const rect = props.anchorEl.getBoundingClientRect()
      const el = listRef.current
      const lw = el?.offsetWidth ?? 0
      const lh = el?.offsetHeight ?? 0
      const margin = 12
      let x = rect.right - lw
      let y = rect.top - lh - 4
      if (lw > 0) x = Math.min(Math.max(x, margin), window.innerWidth - lw - margin)
      if (lh > 0 && y < margin) y = Math.min(rect.bottom + 4, window.innerHeight - lh - margin)
      setPos({ left: x, top: y })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [props.anchorEl])

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node)) return
      if (props.anchorEl.contains(e.target)) return
      if (listRef.current?.contains(e.target) === true) return
      props.onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') props.onClose() }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [props.anchorEl, props.onClose])

  return createPortal(
    <div ref={listRef} style={{ ...s.menuCard, left: pos.left, top: pos.top, width: 160 }} role="menu" onClick={(e) => e.stopPropagation()}>
      <MenuRow icon={<IconEditOutline16 size={14} />} label="重命名" onClick={props.onRename} />
      <MenuRow
        icon={<IconPlusOutline16 size={14} />}
        label="添加会话"
        disabled={!props.hasUngrouped}
        onClick={props.onAddSessions}
      />
      <div style={s.menuSep} role="separator" />
      <MenuRow icon={<IconTrashOutline16 size={14} />} label="删除分组" onClick={props.onDelete} />
    </div>,
    document.body,
  )
}

// ---------- 批量操作下拉（自绘：大圆角 + 紧凑字号 + 右下弹出 + 视口钳制） ----------

function MenuRow(props: {
  icon?: React.ReactNode
  label: string
  chevron?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      style={{ ...s.menuRow, ...(props.disabled ? s.menuRowDisabled : {}) }}
      disabled={props.disabled}
      onClick={() => { if (!props.disabled) props.onClick() }}
      onMouseEnter={(e) => { if (!props.disabled) e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {props.icon !== undefined && (
        <span style={{ display: 'inline-flex', width: 16, justifyContent: 'center', flex: 'none', color: 'var(--dsw-alias-label-secondary)' }}>
          {props.icon}
        </span>
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.label}</span>
      {props.chevron && (
        <span style={{ display: 'inline-flex', opacity: 0.5, flex: 'none' }}>
          <IconTriangleRightFill14 size={10} />
        </span>
      )}
    </button>
  )
}

function BatchDropdown(props: {
  anchorEl: HTMLElement
  selectedCount: number
  allSelected: boolean
  otherGroups: { id: string; title: string }[]
  onToggleAll: () => void
  /** 归档批量不传移动目标（otherGroups 恒为空）→ 「移动到」整行隐藏。 */
  onMoveTo: (groupId: string) => void
  /** 未分组行批量没有「移出分组」项（它本来就在组外）。 */
  showRemove?: boolean
  onRemove: () => void
  /** 组行/未分组行批量：把选中会话移入归档集（已归档批量不传即不显示）。 */
  onArchive?: () => void
  /** 已归档行批量：把选中会话移出归档集（未分组行/组行不传即不显示）。 */
  onUnarchive?: () => void
  /** 已归档行批量：彻底删除选中会话（不传即不显示）。 */
  onDeleteSelected?: () => void
  onExit: () => void
  onClose: () => void
}) {
  const [page, setPage] = useState<'main' | 'move'>('main')
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 })
  const listRef = useRef<HTMLDivElement>(null)

  // 右下弹出（anchor 左缘/下缘 +4px），并钳制在视口内；滚动/缩放跟随。
  useEffect(() => {
    const place = (): void => {
      const rect = props.anchorEl.getBoundingClientRect()
      const el = listRef.current
      const lw = el?.offsetWidth ?? 0
      const lh = el?.offsetHeight ?? 0
      const margin = 12
      let x = rect.left
      let y = rect.bottom + 4
      if (lw > 0) x = Math.min(Math.max(x, margin), window.innerWidth - lw - margin)
      if (lh > 0) y = Math.min(Math.max(y, margin), window.innerHeight - lh - margin)
      setPos({ left: x, top: y })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [props.anchorEl, page])

  // 点外关闭 + Esc 关闭。
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node)) return
      if (props.anchorEl.contains(e.target)) return
      if (listRef.current?.contains(e.target) === true) return
      props.onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') props.onClose() }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [props.anchorEl, props.onClose])

  return createPortal(
    <div ref={listRef} style={{ ...s.menuCard, left: pos.left, top: pos.top }} role="menu" onClick={(e) => e.stopPropagation()}>
      {page === 'main' ? (
        <>
          <MenuRow
            icon={<IconCheckOutline16 size={14} />}
            label={props.allSelected ? '全不选' : '全选'}
            onClick={props.onToggleAll}
          />
          {props.otherGroups.length > 0 && (
            <MenuRow
              icon={<IconFolderClose16 size={14} />}
              label="移动到..."
              chevron
              disabled={props.selectedCount === 0}
              onClick={() => setPage('move')}
            />
          )}
          {props.onArchive !== undefined && (
            <MenuRow
              icon={<IconArchiveOutline20 size={14} />}
              label="批量归档"
              disabled={props.selectedCount === 0}
              onClick={() => { props.onArchive?.(); props.onClose() }}
            />
          )}
          {props.showRemove !== false && (
            <>
              <div style={s.menuSep} role="separator" />
              <MenuRow
                icon={<IconTrashOutline16 size={14} />}
                label="移出分组"
                disabled={props.selectedCount === 0}
                onClick={() => { props.onRemove(); props.onClose() }}
              />
            </>
          )}
          {props.onUnarchive !== undefined && (
            <>
              <div style={s.menuSep} role="separator" />
              <MenuRow
                icon={<IconArchiveOutline20 size={14} />}
                label="取消归档"
                disabled={props.selectedCount === 0}
                onClick={() => { props.onUnarchive?.(); props.onClose() }}
              />
            </>
          )}
          {props.onDeleteSelected !== undefined && (
            <>
              <div style={s.menuSep} role="separator" />
              <MenuRow
                icon={<IconTrashOutline16 size={14} />}
                label="删除会话"
                disabled={props.selectedCount === 0}
                onClick={() => { props.onDeleteSelected?.(); props.onClose() }}
              />
            </>
          )}
          <MenuRow
            icon={<IconCloseOutline16 size={14} />}
            label="取消批量"
            onClick={() => { props.onExit(); props.onClose() }}
          />
        </>
      ) : (
        <>
          <MenuRow
            icon={<IconChevronLeftOutline14 size={14} />}
            label="返回"
            onClick={() => setPage('main')}
          />
          <div style={s.menuSep} role="separator" />
          {props.otherGroups.map((g) => (
            <MenuRow
              key={g.id}
              label={g.title}
              disabled={props.selectedCount === 0}
              onClick={() => { props.onMoveTo(g.id); props.onClose() }}
            />
          ))}
        </>
      )}
    </div>,
    document.body,
  )
}

// ---------- 添加会话下拉（自绘：与官方浮层同质感；从 + 按钮向右上弹出） ----------

function AddSessionDropdown(props: {
  anchorEl: HTMLElement
  sessions: SessionRow[]
  onPick: (sessionId: string) => void
  onClose: () => void
}) {
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 })
  const listRef = useRef<HTMLDivElement>(null)
  const count = props.sessions.length

  // 向右上弹出：菜单底缘贴 + 按钮顶缘上方 4px，右缘与按钮右缘对齐；
  // 上方放不下时翻转到按钮下方，并钳制在视口内；滚动/缩放跟随。
  useEffect(() => {
    const place = (): void => {
      const rect = props.anchorEl.getBoundingClientRect()
      const el = listRef.current
      const lw = el?.offsetWidth ?? 0
      const lh = el?.offsetHeight ?? 0
      const margin = 12
      let x = rect.right - lw
      let y = rect.top - lh - 4
      if (lw > 0) x = Math.min(Math.max(x, margin), window.innerWidth - lw - margin)
      if (lh > 0 && y < margin) y = Math.min(rect.bottom + 4, window.innerHeight - lh - margin)
      setPos({ left: x, top: y })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [props.anchorEl, count])

  // 点外关闭 + Esc 关闭。
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node)) return
      if (props.anchorEl.contains(e.target)) return
      if (listRef.current?.contains(e.target) === true) return
      props.onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') props.onClose() }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [props.anchorEl, props.onClose])

  return createPortal(
    <div ref={listRef} style={{ ...s.menuCard, left: pos.left, top: pos.top }} role="menu" onClick={(e) => e.stopPropagation()}>
      {count === 0 && <MenuRow label="暂无未分组会话" disabled onClick={() => {}} />}
      {props.sessions.map((row) => (
        <MenuRow
          key={row.id}
          icon={row.running ? <span style={{ fontSize: 10 }}>🟢</span> : undefined}
          label={row.displayTitle}
          onClick={() => props.onPick(row.id)}
        />
      ))}
    </div>,
    document.body,
  )
}
