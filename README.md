# 社团章程修订台 (Charter Amender)

一款面向社团章程修订场景的 Web 应用：以**稳定条款标识（CID）**管理章程条款的
新增 / 编辑 / 移动 / 删除，支持**从已发布版本创建草案**、查看**相对基线的差异**，
并能处理**并行草案**的自动重放与冲突检测。

- 后端：Node.js + Express
- 存储：SQLite（better-sqlite3，WAL 模式，零外部依赖）
- 前端：原生 HTML / CSS / JavaScript（无需构建）
- 发布模型：版本一经发布即**不可变**（数据库触发器强制），发布过程为**单事务原子写入**

---

## 一、功能一览

| 需求 | 实现方式 |
| --- | --- |
| 录入首版条款及条款间引用 | 首版录入页，可逐条编辑 CID/标题/正文/引用，或“填充示例” |
| 从已发布版本创建草案 | 任意历史版本均可“创建草案 / 从此版本创建草案”，复制该版顺序、正文与引用 |
| 编辑、移动、删除带稳定标识的条款 | CID 跨版本不变；移动显式记录；删除既有条款为软删除（草案内可追溯），草案新增条款可彻底移除 |
| 查看相对基线的差异 | 草案详情“查看差异”：新增 / 删除 / 正文修改 / 引用修改 / 移动，含正文红绿对照 |
| 并行草案不相交改动重放到最新版 | 发布时若基线落后，自动把草案改动重放到最新版本（正文 + 引用 + 顺序） |
| 同一条款双方改动 → 拒绝发布 | 返回 `409`，逐条说明冲突条款、双方操作类型、冲突版本，**草案原样保留** |
| 重放后引用悬空 → 拒绝发布 | 返回 `409`，指出悬空引用的源条款与目标 CID，草案保留 |
| 草案允许暂存悬空引用并标明问题 | 悬空引用以红色 ⚠ 标记、列表显示数量、发布按钮禁用 |
| 原子生成不可变版本 | 单 SQLite 事务写入 version / clauses / refs / moves；发布表设有 UPDATE/DELETE 拒绝触发器 |
| 历史还原 | 打开任一历史版本，完整还原该版**顺序、正文、引用**；支持相邻版本对比 |

### 冲突检测规则

发布草案 D（基线版本 B）时，若当前最新版本为 L（L ≠ B），系统：

1. 计算 D 相对 B 改动的条款集合（新增/删除/编辑/移动）；
2. 计算 L 相对 B 已被“另一方”改动的条款集合；
3. **两集合相交** → `same-clause` 冲突（一方编辑、另一方移动同一 CID 也算冲突）；
4. 集合不相交 → 以 L 的内容为底，覆盖 D 改动的条款、套用 D 的删除，并用锚点法重放顺序；
5. 重放结果中任一引用指向不存在的条款 → `dangling-ref-after-replay` 冲突；
6. 全部通过才在事务内生成新版本并删除草案，否则草案保留。

---

## 二、一键启动（Docker Compose，推荐）

前置：已安装 Docker 与 Docker Compose 插件。

```bash
docker compose up -d --build
```

启动后访问：

- **应用地址**：http://localhost:3000
- **健康检查**：`GET http://localhost:3000/api/overview`

停止 / 查看日志：

```bash
docker compose logs -f
docker compose down            # 停止（数据保留在命名卷 charter-data 中）
docker compose down -v         # 停止并删除数据库卷（清空数据）
```

镜像采用多阶段构建（构建阶段编译 better-sqlite3 原生模块，运行镜像为精简
`node:20-bookworm-slim`，以非 root 用户运行）。

---

## 三、本地直接运行（Node.js）

要求 Node.js ≥ 20。

```bash
npm install        # 安装依赖（better-sqlite3 会本地编译，需要 python3/make/g++）
npm start          # 等价于 node src/server.js
```

访问 http://localhost:3000 。首次启动会在 `./data/charter.db` 自动建库建表。

运行测试：

```bash
npm test                       # 16 项核心合并/差异/不可变性单测
# HTTP 集成测试（41 项）：另开一个终端
PORT=3100 DB_PATH=/tmp/t.db node src/server.js
python3 test/http_test.py
```

---

## 四、配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `./data/charter.db` | SQLite 数据库文件路径；首次启动自动初始化表结构 |
| `HOST_PORT` | `3000` | 仅 Compose 使用：宿主机映射端口 |

自定义宿主端口示例：

```bash
HOST_PORT=8080 docker compose up -d --build
# 然后访问 http://localhost:8080
```

容器内数据写入 `/data/charter.db`，由命名卷 `charter-data` 持久化。

---

## 五、使用流程

1. **首版**：首次打开应用，录入首版条款（CID 可留空自动生成）与引用，发布为不可变 v1。
2. **创建草案**：在“最新版本 / 历史版本 / 草案”页创建草案，可选择任意已发布版本作为基线。
3. **编辑草案**：
   - 新增条款（可指定插入锚点）；
   - 修改标题 / 正文；
   - 上移 / 下移调整顺序；
   - 删除条款（引用它的条款会出现红色悬空引用标记）；
   - 多选维护引用，或在“悬空引用 CID”输入框中暂存尚不存在的目标。
4. **查看差异**：实时显示相对基线的新增 / 删除 / 修改 / 引用 / 移动差异。
5. **发布**：
   - 预检通过 → “原子发布”生成新版本；
   - 预检不通过 → 顶部列出全部冲突，发布按钮禁用；强行调用 API 会得到 `409`，草案保留，
     可在另一个草案或后续编辑中解决问题后重试。
6. **历史**：在“历史版本”中打开任意版本完整还原，或与上一版对比。

---

## 六、HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/overview` | 概览：版本列表、草案列表、最新版本 |
| POST | `/api/initialize` | 录入并发布首版（仅一次） |
| GET | `/api/versions/:id` | 取某版本完整快照（顺序/正文/引用） |
| GET | `/api/versions/:newer/compare/:older` | 两版对比 |
| POST | `/api/drafts` | 创建草案 `{name?, baseVersionId?}` |
| GET | `/api/drafts/:id` | 草案详情 + 相对基线差异 + 发布预检 |
| DELETE | `/api/drafts/:id` | 废弃草案 |
| POST | `/api/drafts/:id/clauses` | 新增条款 |
| PUT | `/api/drafts/:id/clauses/:cid` | 编辑标题/正文 |
| DELETE | `/api/drafts/:id/clauses/:cid` | 删除条款 |
| PUT | `/api/drafts/:id/clauses/:cid/move` | 移动 `{position}` 或 `{afterCid}` |
| PUT | `/api/drafts/:id/clauses/:cid/refs` | 设置引用 `{refs:[...]}` |
| GET | `/api/drafts/:id/publish-check` | 发布预检（不落库） |
| POST | `/api/drafts/:id/publish` | 原子发布；冲突返回 `409` 并保留草案 |

冲突响应示例：

```json
{
  "ok": false,
  "conflicts": [
    {
      "kind": "same-clause",
      "cid": "members",
      "draftTags": ["edited"],
      "otherTags": ["moved"],
      "otherVersion": 4,
      "message": "条款 members 在本草案中被编辑正文/引用，但在基线之后发布的 v4 中已被移动位置，双方改动重叠，需人工合并"
    }
  ],
  "baseNumber": 3,
  "latestNumber": 4,
  "message": "发布被拒绝：存在合并冲突，草案已保留"
}
```

---

## 七、目录结构

```
.
├── Dockerfile              # 多阶段构建，非 root 运行，含 HEALTHCHECK
├── docker-compose.yml      # 一键启动 + 命名卷持久化
├── package.json
├── src/
│   ├── server.js           # Express 入口与静态托管
│   ├── db.js               # SQLite 连接、建表、不可变触发器
│   ├── drafts.js           # 草案增删改/移动/引用/首版初始化
│   ├── state.js            # 版本与草案快照加载
│   ├── diff.js             # 草案相对基线的差异
│   ├── merge.js            # 并行重放、冲突检测、原子发布（核心）
│   └── routes.js           # HTTP API
├── public/                 # 前端单页应用（index.html / app.js / styles.css）
└── test/
    ├── smoke.mjs           # 16 项核心逻辑测试
    └── http_test.py        # 41 项 HTTP 端到端集成测试
```

## 八、数据模型要点

- `version` / `version_clause` / `version_ref` / `version_move`：发布快照，触发器禁止
  UPDATE 与 DELETE，保证不可变。
- `draft` / `draft_clause` / `draft_order` / `draft_ref` / `draft_move`：草案工作区。
  条款状态为 `unchanged / edited / added / deleted`；显式移动单独记录，
  仅在顺序偏离“基线存活条款自然顺序”时置位，移回原位自动清除。
- CID 规则：`[A-Za-z0-9_-]{1,64}`，新增时留空自动生成。
