// 环境类型声明：@deepseek-ai/dsh-client-runtime/client 是 dsh web 外壳在浏览器
// 运行时提供的模块身份（类型只在编译期使用；client bundle 对它是类型引用，
// 打包时被擦除，不产生模块请求）。这里只声明本插件实际使用的最小切面。
declare module '@deepseek-ai/dsh-client-runtime/client' {
  import type { ComponentType } from 'react'

  /** slot 注册描述的最小切面（完整契约见 @deepseek-ai/dsh-client-ui-slots）。 */
  export interface SlotRegistration {
    name: string
    inject?: () => unknown
    [key: string]: unknown
  }

  /** dsh client 根上下文的最小切面。 */
  export interface ClientContext {
    /** 按服务名读取可选服务（严格 ctx.<name> 属性访问须先在 inject 声明）。 */
    get(name: string): unknown
    slots: {
      register(registration: SlotRegistration, component: ComponentType<never>): unknown
      inject(slot: string, factory: () => unknown): unknown
    }
  }
}

// 环境类型声明：@deepseek-ai/dsh-client-ui-primitives 是 dsh web 外壳通过共享
// 模块表提供的运行时模块身份（类型只在编译期使用；client bundle 对它走
// external，不产生模块请求）。这里只声明本插件实际使用的最小切面。
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, CSSProperties, MouseEvent, ReactNode } from 'react'

  /** 四色状态语义（StateDot）。 */
  export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error'

  /** 状态点：ongoing 为蓝色追逐动画，其余为静态圆点。 */
  export const StateDot: ComponentType<{
    state: StateDotState
    size?: number
    className?: string
  }>

  /** 主按钮/描边按钮（对话框 footer 用）。 */
  export const Button: ComponentType<{
    variant?: 'primary' | 'outline'
    disabled?: boolean
    className?: string
    onClick?: (event: MouseEvent<HTMLButtonElement>) => void
    children?: ReactNode
  }>

  /** 悬停触发的预览卡（原生会话行悬停卡同款；卡片定位由基座完成）。 */
  export const HoverCard: ComponentType<{
    anchor: ReactNode
    content: ReactNode
    openDelayMs?: number
    disabled?: boolean
    copyText?: string
    copyLabel?: string
    copiedLabel?: string
  }>

  /** 菜单行 / 分隔线（与基座 MenuEntry 同构的最小切面）。 */
  export interface MenuItem {
    id: string
    label?: ReactNode
    disabled?: boolean
    icon?: ReactNode
    danger?: boolean
    submenu?: readonly MenuItem[]
  }
  export interface MenuSeparator {
    type: 'separator'
    id: string
  }
  export type MenuEntry = MenuItem | MenuSeparator

  /** 锚定下拉菜单（portal 模式按锚点矩形定位于 document.body）。 */
  export const Menu: ComponentType<{
    open: boolean
    anchor: ReactNode
    items: readonly MenuEntry[]
    onSelect: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    closeOnPointerLeave?: boolean
    /** 收紧行距但保持标准字号与卡宽。 */
    dense?: boolean
    /** 缩小版排版：12px 字号 / 26px 行高 / 164px 卡宽。 */
    compact?: boolean
    className?: string
  }>

  /** 确认/表单对话框（footer 自带按钮排布）。 */
  export const Modal: ComponentType<{
    open: boolean
    onClose: () => void
    closeLabel?: string
    title?: ReactNode
    description?: ReactNode
    footer?: ReactNode
    children?: ReactNode
  }>

  /** 图标统一切面：size + className（填充/描边细节由基座提供）。 */
  export type IconComponent = ComponentType<{ size?: number; className?: string; style?: CSSProperties }>
  export const IconArchiveOutline20: IconComponent
  export const IconBranchOutline16: IconComponent
  export const IconChecklistOutline14: IconComponent
  export const IconCheckOutline16: IconComponent
  export const IconChevronLeftOutline14: IconComponent
  export const IconClockOutline16: IconComponent
  export const IconCloseOutline16: IconComponent
  export const IconEditOutline16: IconComponent
  export const IconEllipsisOutline16: IconComponent
  export const IconFolderClose16: IconComponent
  export const IconFolderOpen16: IconComponent
  export const IconPlusOutline16: IconComponent
  export const IconTriangleRightFill14: IconComponent
  export const IconTrashOutline16: IconComponent
}
