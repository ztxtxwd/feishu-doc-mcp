# Feishu Doc MCP

A Model Context Protocol (MCP) server for accessing Feishu (Lark) Open Platform documentation. This server enables AI assistants like Claude to search and read Feishu API documentation directly.

## Features

- Search Feishu API documentation by category
- Read detailed documentation content
- Support for multiple API categories including:
  - Server API (Messaging, Calendar, Contacts, etc.)
  - Client API (Web apps, Mini programs, etc.)
  - Development Guides (Bots, Web apps, etc.)
  - And many more...

## Installation

### Using npx (Recommended)

You can run this MCP server directly using npx without installation:

```bash
npx feishu-doc-mcp
```

### Global Installation

```bash
npm install -g feishu-doc-mcp
```

Then run:

```bash
feishu-doc-mcp
```

## Usage with Claude Desktop

Add this to your Claude Desktop configuration file:

**MacOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows**: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "feishu-doc": {
      "command": "npx",
      "args": ["feishu-doc-mcp"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "feishu-doc": {
      "command": "feishu-doc-mcp"
    }
  }
}
```

## Available Tools

### search_feishu_doc

Search Feishu API documentation by category. Returns a list of documents under the specified category.

**Parameters:**
- `category`: Document category in format "Level1_Level2" (e.g., "服务端API_即时通讯", "开发指南_开发机器人")

### read_feishu_doc

Read detailed content of a Feishu API document. The content is saved to a temporary file for easy access.

**Parameters:**
- `path`: Document path (obtained from search_feishu_doc results)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development mode
npm run dev

# Start the server
npm start
```

## Publishing

This project uses GitHub Actions for automatic publishing to npm. To publish a new version:

1. Update the version in `package.json`
2. Commit your changes
3. Create and push a tag:
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```
4. GitHub Actions will automatically build and publish to npm

## Requirements

- Node.js >= 18

## License

MIT

## Author

ztxtxwd

