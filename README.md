# Feishu Doc MCP

一个用于访问飞书开放平台文档的 Model Context Protocol (MCP) 服务器。该服务器使 Claude 等 AI 助手能够直接搜索和阅读飞书 API 文档。

## 为什么选择 Feishu Doc MCP

### 零配置，无需 API Key

直接对接飞书官方公开的文档接口，无需申请任何 Token 或 API Key，开箱即用。

### 动态同步，永不过时

分类列表从飞书 API 实时获取，自动适应官方文档结构变化，无硬编码维护负担。当飞书新增或调整 API 分类时，本工具自动同步。

### 覆盖完整，4800+ 文档

支持飞书开放平台全部文档体系，包括服务端 API、客户端 API、开发指南、开发教程等 100+ 个分类，涵盖即时通讯、日历、通讯录、云文档、审批、人事等全部能力。

### 内容智能处理

- 大文件自动提示分段读取，保护 context window
- 临时文件智能命名（可读前缀 + Hash），避免冲突

### 高性能设计

- 启动时并行加载文档索引和 URI 映射
- 内存缓存 4800+ 文档映射，查询 O(1) 时间复杂度
- 支持长期运行，无需反复初始化

## 功能特性

- 按分类搜索飞书 API 文档
- 读取详细的文档内容
- 支持多种 API 分类：
  - 服务端 API（消息、日历、通讯录等）
  - 客户端 API（网页应用、小程序等）
  - 开发指南（机器人、网页应用等）
  - 更多...

## 安装

### 使用 npx（推荐）

无需安装，直接使用 npx 运行：

```bash
npx feishu-doc-mcp@latest
```

> 使用 `@latest` 确保每次运行时获取最新版本。

### 全局安装

```bash
npm install -g feishu-doc-mcp
```

然后运行：

```bash
feishu-doc-mcp
```

## 在 Claude Desktop 中使用

将以下配置添加到 Claude Desktop 配置文件：

**MacOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows**: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "feishu-doc": {
      "command": "npx",
      "args": ["feishu-doc-mcp@latest"]
    }
  }
}
```

如果是全局安装：

```json
{
  "mcpServers": {
    "feishu-doc": {
      "command": "feishu-doc-mcp"
    }
  }
}
```

## 可用工具

### search_feishu_doc

按分类搜索飞书 API 文档，返回该分类下的文档列表。

**参数：**
- `category`: 文档分类，格式为「一级目录_二级目录」（例如：「服务端 API_即时通讯」、「开发指南_开发机器人」）

### read_feishu_doc

读取飞书 API 文档的详细内容。内容会保存到临时文件以便访问。

**参数：**
- `path`: 文档路径（从 search_feishu_doc 结果中获取）

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 开发模式运行
npm run dev

# 启动服务器
npm start
```

## 发布

本项目使用 GitHub Actions 自动发布到 npm。发布新版本：

1. 更新 `package.json` 中的版本号
2. 提交更改
3. 创建并推送 tag：
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```
4. GitHub Actions 会自动构建并发布到 npm

## 环境要求

- Node.js >= 18

## 许可证

MIT

## 作者

ztxtxwd
