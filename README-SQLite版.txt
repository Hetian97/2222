111 memory-server 迁移包 - SQLite 版

当前版本：
- memory-server 已从 JSON 存储升级为 SQLite 存储。
- 后端真实数据库文件为 memory-server/memory.db。
- memory.db 是真实记忆数据，不应提交 Git，也不应放入迁移包。
- 本迁移包只包含代码，不包含真实记忆数据。

已包含文件：
- index.html
- vector-memory.js
- start-111-tailscale.bat
- .gitignore
- memory-server/server.js
- memory-server/db.js
- memory-server/migrate-json-to-sqlite.js
- memory-server/package.json
- memory-server/package-lock.json
- modules/backup-import-export.js
- modules/character-export.js
- modules/memory-summary.js

首次使用：

1. 进入 memory-server 目录

cd /d 当前迁移包路径\memory-server

2. 安装依赖

npm install

3. 如果需要从旧 JSON 数据迁移

把旧 memory.json 临时放入 memory-server 目录，然后运行：

node migrate-json-to-sqlite.js

成功后会生成：

memory.db

迁移完成后，memory.json 可以移走或删除，不要提交 Git，也不要放进迁移包。

4. 启动 memory-server

node server.js

默认地址：

http://127.0.0.1:8765

Tailscale 地址：

http://100.81.84.121:8765

5. 启动前端静态服务

回到迁移包根目录：

python -m http.server 8000 --bind 0.0.0.0

电脑访问：

http://127.0.0.1:8000/?v=sqlite

手机/平板访问：

http://100.81.84.121:8000/?v=sqlite

6. 前端设置

长期记忆 → 变量记忆/向量记忆 → 设置 → 外部记忆服务器

电脑填写：

http://127.0.0.1:8765

手机/平板填写：

http://100.81.84.121:8765

点击：

测试连接
从服务器重新加载

7. API 保持不变

GET  /health
GET  /memory/list
POST /memory/add
POST /memory/delete
POST /memory/search
GET  /health
GET  /memory/list
GET  /memory/list?category=P
GET  /memory/list?minImportance=8
GET  /memory/list?category=R&minImportance=8
GET  /memory/stats
GET  /memory/unembedded
POST /memory/add
POST /memory/delete
POST /memory/search

8. 不要放入迁移包/不要提交 Git 的文件

memory-server/memory.json
memory-server/memory.db
memory-server/memory.db-shm
memory-server/memory.db-wal
memory-server/memory.backup.json
memory-server/memory.backup.db
memory-server/backups/
memory-server/node_modules/
memory-server/server.json-version.backup.js

9. 当前 Git 分支

SQLite 版开发分支：

sqlite-memory-server

该分支已 push 到 GitHub：

origin/sqlite-memory-server



新增：批量重新向量化 BM25 记忆脚本：
memory-server/reembed-unembedded.js

使用前在 CMD 中设置：
set EMBEDDING_ENDPOINT=你的 endpoint
set EMBEDDING_API_KEY=你的 key
set EMBEDDING_MODEL=BAAI/bge-m3

测试 1 条：
set REEMBED_LIMIT=1
set REEMBED_DRY_RUN=true
node reembed-unembedded.js

正式处理：
set REEMBED_LIMIT=100
set REEMBED_DRY_RUN=false
node reembed-unembedded.js

新增：SQLite 混合语义检索

当前 /memory/search 已升级为混合语义检索。

接口：

POST /memory/search

请求示例：

curl -X POST http://127.0.0.1:8765/memory/search -H "Content-Type: application/json" -d "{\"query\":\"她答应过我什么？\",\"limit\":5}"

如果启动 memory-server 前设置了 Embedding 环境变量：

set EMBEDDING_ENDPOINT=你的 endpoint
set EMBEDDING_API_KEY=你的 key
set EMBEDDING_MODEL=BAAI/bge-m3

则 /memory/search 会使用：

query embedding + memory.embedding cosine similarity + 关键词兜底 + importance/emotionalWeight 加权

返回结果中会包含调试字段：

_searchScore
_vectorScore
_keywordScore
_searchMode
_hasEmbedding
_embeddingDim

注意：搜索结果不会返回完整 embedding 数组，只显示类似：

embedding: "[hidden:1024d]"

这样可以避免 1024 维向量把返回内容刷屏。


新增：Embedding 元信息

SQLite memories 表已新增字段：

embeddingModel
embeddingDim
embeddingUpdatedAt

用途：

1. 记录每条 memory.embedding 是由哪个 embedding 模型生成的。
2. 记录向量维度。
3. 记录向量更新时间。
4. 以后如果更换 embedding 模型，可以判断哪些记忆需要重新向量化。

当前测试库使用：

embeddingModel = BAAI/bge-m3
embeddingDim = 1024

查看统计：

http://127.0.0.1:8765/memory/stats

stats 中会显示：

byEmbeddingModel
byEmbeddingDim

例如：

byEmbeddingModel:
BAAI/bge-m3: 24

byEmbeddingDim:
1024: 24

如果以后换 embedding 模型，不建议混用旧向量。应先备份 memory.db，再用新模型重新向量化。


新增：Embedding 设置 UI 改进

前端向量化端点设置中已增加：

1. API Key 默认隐藏。
2. “显示/隐藏”按钮。
3. “测试向量化”按钮。
4. 测试成功时会显示 embedding 维度，例如：

✅ 向量化测试成功，维度：1024

这可以用于确认 endpoint、key、model 是否可用。


新增：编辑记忆后 embedding 持久化修复

现在在前端点击记忆条目的“改内容”并确认后：

1. 前端会重新生成 embedding。
2. embedding 会同步写回 SQLite memory.db。
3. 同时写入 embeddingModel、embeddingDim、embeddingUpdatedAt。
4. 关闭并重新打开长期记忆面板后，Vector✓ 状态仍会保留。

判断是否真正写回 SQLite：

打开：

http://127.0.0.1:8765/memory/stats

查看：

withEmbedding
withoutEmbedding
byEmbeddingModel
byEmbeddingDim

如果 withEmbedding 增加，说明不是前端临时显示，而是已经真正写入 SQLite。

新增：前端记忆列表显示 tags

长期记忆/变量记忆列表中，每条记忆现在会在内容下方轻量显示 tags。

显示规则：
- 最多显示前 3 个标签。
- 如果标签超过 3 个，会显示 +N。
- tags 只作为普通前端可读信息显示，方便检查记忆总结质量。
- 不显示 embeddingModel、embeddingDim、_searchScore、_vectorScore 等调试信息，避免普通界面过于复杂。

示例：

#承诺 #称呼 #亲密关系

如果某条记忆有 6 个标签，则显示：

#承诺 #称呼 #亲密关系 +3

新增：前端记忆详情按钮

长期记忆/变量记忆列表中，每条记忆增加“详情”按钮。点击后可查看 ID、分类、重要度、情绪权重、tags、source、context、embeddingModel、embeddingDim、embeddingUpdatedAt、createdAt、updatedAt、memoryTime 等 metadata。普通列表仍保持简洁。


新增：前端记忆列表筛选条

长期记忆/变量记忆列表中已增加轻量筛选条。

支持筛选：
1. 分类：全部，以及当前系统中的所有记忆分类。
2. 向量状态：全部 / Vector✓ / BM25。
3. 最低重要度：全部 / ≥1 / ≥2 / ≥3 / ≥4 / ≥5 / ≥6 / ≥7 / ≥8 / ≥9 / 10。

筛选在前端本地已加载的记忆列表中进行，不会修改 SQLite 数据。
如果当前筛选条件下没有结果，会显示“当前筛选条件下没有记忆”。
点击“重置”可恢复全部记忆显示。

新增：前端记忆搜索框与筛选条

长期记忆/变量记忆列表已增加本地搜索框，可搜索 content、tags、category、source、context。搜索框支持中文输入，输入后按 Enter 或点击“搜索”执行筛选。筛选条件可与分类、向量状态、最低重要度叠加使用。点击“重置”恢复全部记忆显示。

新增：记忆 UI 安全与体验优化

1. 修复搜索/筛选后上方工具栏按钮失效的问题。
   现在搜索、分类筛选、向量状态筛选、重要度筛选只会隐藏/显示已有记忆行，不再重绘整个长期记忆面板，因此不会导致“添加记忆、添加核心、提取记忆、批量、导入、导出、设置”等按钮失效。

2. “详情”按钮已从浏览器 alert 改为自定义弹窗。
   弹窗支持滚动、复制详情、点击关闭按钮关闭、点击遮罩关闭，手机端显示更友好。

3. 批量删除增加强确认。
   点击批量删除后，除第一层确认外，还必须输入 DELETE 才会真正删除。
   如果取消或输入错误，不会删除记忆，也不会再误显示“已删除 X 条记忆”。