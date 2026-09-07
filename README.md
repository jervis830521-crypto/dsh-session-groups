# dsh-session-groups · dsh 会话分组管理插件

> 给 dsh web 版侧边栏加一个「按分组」的会话管理维度：分组 + 未分组 + 已归档三区，
> 批量操作、拖拽排序、最近活跃自动排序、归档与彻底删除，全部在侧边栏完成。

适配 DeepSeek Harness（dsh）web 界面，注册进 `sidebar.workspaces` slot（与原生
工作区浏览同位），数据与官方会话账本实时联动。

## 功能特性

### 分组管理
- **新建 / 重命名 / 删除分组**：删除分组只拆标签，会话本体不受影响（标签模型）。
- **单会话归属**：每个会话最多属一个分组（移动即替换），未进组的落「未分组」区。
- **拖拽排序**：分组行可直接拖拽调整前后顺序（手动模式）。
- **最近活跃自动排序**（默认开启）：组的活跃时间 = 组内可见会话的最新活动时间，
  在某组里聊天，该组自动跳到第一位——与原生工作区「最近活动排前」同律。
  「分组」行悬停时时钟图标可切换 自动排序 / 手动拖拽，选择持久化到 localStorage。
- **批量操作**：批量移动到其它分组 / 批量移出分组 / 批量归档。

### 会话操作
- **组内新会话**：分组行 ＋ 按钮直接建会话入组。
- **添加已有会话**：从全部未分组会话中挑选加入。
- **重命名 / 分叉（fork）**：单行菜单直达。
- **归档**：单行或批量归档，进入底部「已归档」区（默认折叠）。
- **取消归档**：单行或批量，回到未分组区。
- **彻底删除**：已归档会话可单行或批量物理删除（先二次确认），直接删除磁盘上的
  会话存储目录，不可恢复。活会话拒删、目录含陌生文件拒删，多重防护。

### 状态与计数
- 侧边栏「分组」行右侧显示 **未归档会话数**（裸数字）与 **已归档数**（带归档图标
  的胶囊徽标，0 时不显示），口径与面板行一致，实时刷新。
- 行内状态点：进行中（蓝追逐动画）/ 已完成 / 出错，与原生一致。

## 安装

### 方式 A：用发布 tgz（推荐，新机器零构建）

1. 到仓库 Releases 页下载最新 `dsh-session-groups-x.y.z.tgz`；
2. 解压（或直接把包目录给安装工具），在 dsh 环境里执行：

```sh
# 开发机（装了 dsh 开发工具链）：
dev_install_package <解压出的插件目录>

# 或手工装配：在 profile 的 package.json 里加 link 依赖，
# bundles 数组加 "dsh-session-groups"，node_modules 建 junction 后重启 dsh。
```

3. 重启 dsh，侧边栏出现「分组」行。

### 方式 B：源码构建

```sh
git clone https://gitee.com/<你>/dsh-session-groups.git
cd dsh-session-groups

# 需要一个 dsh checkout（含 node_modules，tsc/tsdown 从那里取）：
export DSH_CHECKOUT=/path/to/deepseek-harness   # Windows 默认探测 E:/BaiduSyncdisk/... 路径
npm run build                                   # = bash scripts/build.sh

# 产物在 lib/（host: lib/*.js，client: lib/client.js），按方式 A 第 2 步安装。
```

构建做了三件事：junction 链接类型依赖（cordis、webserver host 类型）→
tsc 编译 host → tsdown 打包 client（CJS closure-factory 产物，经
`window.__ModuleLoader__.load` 交接，React 与 @deepseek-ai/* 走 external）。

### 运行时依赖

无需额外安装任何包。运行时只依赖 dsh web 外壳提供的平台模块
（react、@deepseek-ai/dsh-client-ui-primitives 等 external）与 host 侧
`webServer` 服务。

## 数据存储

- 分组与归属：`~/.dsh/storages/session-groups.json`（一个 JSON 文件，真源唯一）。
- 归档账：复用官方 workspace registry 的 `archivedSessionIds`（与原生归档同源）。
- 排序模式：浏览器 `localStorage`（`session-groups.recent-first`）。
- 彻底删除会话：物理删除 dsh JSONL 会话存储目录（`~/.dsh/` 会话根下按项目编码的
  `<sessionId>` 目录），并同步清归档账与分组成员记录。

## HTTP API（host 半，`/session-groups-api` 前缀）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/groups` | 全量视图（分组 + 归属表） |
| POST | `/groups` | 新建分组 `{ title }` |
| PATCH | `/groups/:id` | 重命名 `{ title }` |
| DELETE | `/groups/:id` | 删分组（拆标签，不动会话） |
| POST | `/groups/reorder` | 拖拽重排 `{ ids: [...] }` |
| PUT | `/assignments` | 设置归属 `{ sessionId, groupIds[] }`（PUT 全量语义） |
| POST | `/archive/unarchive` | 取消归档 `{ sessionId }` |
| POST | `/archive/delete` | 彻底删除 `{ sessionId }`（物理删除，不可逆） |

## 目录结构

```
├─ cordis.patch.yml        # host 装配补丁（loader entry 注入）
├─ package.json            # dsh.bundle.patch + dsh.client.platform=web 双面声明
├─ scripts/build.sh        # 一键构建（链接类型依赖 → tsc → tsdown）
├─ src/host/               # Node 半：分组仓库 + 路由 + 归档通道 + 彻底删除
│  ├─ index.ts             #   插件入口（webServer 注册）
│  ├─ groups-store.ts      #   ~/.dsh/storages/session-groups.json 仓库
│  ├─ web-router.ts        #   /session-groups-api/* 路由
│  ├─ registry-channel.ts  #   workspace registry 归档账写入通道
│  └─ delete-archived-session.ts  # 彻底删除（路径编码 + 多重防护 + 校验）
└─ src/client/index.tsx    # 浏览器半：slot UI 全部实现（约 2300 行，自包含）
```

## 升级发布流程（开发者）

```sh
# 1. 改代码 → 构建（host + client）
npm run build

# 2. 版本号 +1（semver：功能加 minor，修 bug 加 patch）
npm version minor   # 或 npm version patch

# 3. 提交 + 打 tag + 推送
git add -A
git commit -m "feat: ..."
git push origin main --tags

# 4. 产出 tgz 并在 Gitee 发 Release 挂附件
npm pack   # 得 dsh-session-groups-x.y.z.tgz
# Gitee 仓库页 → Releases → 新建 Release（选 tag）→ 上传 tgz 作为附件
```

## 已知边界

- 会话的物理删除需要插件定位 dsh JSONL 存储目录；若未来官方提供删除动词，
  应迁移到官方实现。
- 彻底删除不走官方通知帧，客户端用本地过滤挡幽灵行；其它已开页面需刷新后干净。
- 自动排序与手动拖拽互斥：自动排序开启时分组不可拖（防覆盖困惑）。
