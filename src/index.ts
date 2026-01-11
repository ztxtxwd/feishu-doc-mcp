#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import TurndownService from "turndown";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { z } from "zod";

// 初始化 Turndown 用于将 HTML 转为 Markdown
const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

// API 端点
const DIRECTORY_LIST_URL = "https://open.feishu.cn/api/tools/docment/directory_list";
const URI_MAPPING_URL = "https://open.feishu.cn/document_portal/v1/document_portal/v1/document/uri/mapping";
const DOC_DETAIL_URL = "https://open.feishu.cn/document_portal/v1/document/get_detail";

// 临时目录路径
const TEMP_DOC_DIR = path.join(os.tmpdir(), "feishu-doc-mcp");

// 文档树节点接口
interface DocTreeNode {
  fullPath: string;
  id: string;
  name: string;
  type: "DirectoryType" | "DocumentType";
  parentId: string;
  items: DocTreeNode[];
}

// API 响应接口
interface DirectoryListResponse {
  code: number;
  data: {
    items: DocTreeNode[];
  };
}

interface UriMappingResponse {
  code: number;
  msg: string;
  data: {
    uriMap: Record<string, string>;
  };
}

// 目录分类映射（枚举值 -> 节点）
interface CategoryMapping {
  enumValue: string;      // 如 "服务端 API_API调用指南"
  level1Name: string;     // 一级目录名
  level2Name: string;     // 二级目录名
  node: DocTreeNode;      // 对应的节点
}

class FeishuDocServer {
  private server: McpServer;
  private docTree: DocTreeNode[] = [];
  private uriMap: Record<string, string> = {};
  private categoryMappings: CategoryMapping[] = [];
  private categoryEnumValues: string[] = [];
  private initialized = false;

  constructor() {
    this.server = new McpServer(
      {
        name: "feishu-doc-mcp",
        version: "1.0.0",
      }
    );

    this.setupErrorHandling();
  }

  private setupErrorHandling() {
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  // 初始化并注册工具
  async initializeAndRegisterTools() {
    await this.initialize();
    this.registerTools();
  }

  // 初始化：获取文档树和 URI 映射
  private async initialize() {
    if (this.initialized) return;

    console.error("[Init] Fetching document tree and URI mapping...");

    try {
      // 并行获取文档树和 URI 映射
      const [treeResponse, mappingResponse] = await Promise.all([
        fetch(DIRECTORY_LIST_URL, { signal: AbortSignal.timeout(30000) }),
        fetch(URI_MAPPING_URL, { signal: AbortSignal.timeout(30000) }),
      ]);

      const treeData = (await treeResponse.json()) as DirectoryListResponse;
      const mappingData = (await mappingResponse.json()) as UriMappingResponse;

      if (treeData.code === 0) {
        this.docTree = treeData.data.items;
        console.error(`[Init] Loaded ${this.countNodes(this.docTree)} document nodes`);
      }

      if (mappingData.code === 0) {
        this.uriMap = mappingData.data.uriMap;
        console.error(`[Init] Loaded ${Object.keys(this.uriMap).length} URI mappings`);
      }

      // 构建目录分类映射
      this.buildCategoryMappings();
      console.error(`[Init] Built ${this.categoryMappings.length} category mappings`);

      this.initialized = true;
    } catch (error) {
      console.error("[Init] Failed to initialize:", error);
      throw error;
    }
  }

  // 计算节点总数
  private countNodes(nodes: DocTreeNode[]): number {
    let count = nodes.length;
    for (const node of nodes) {
      if (node.items?.length) {
        count += this.countNodes(node.items);
      }
    }
    return count;
  }

  // 构建目录分类映射（一级目录_二级目录）
  private buildCategoryMappings() {
    this.categoryMappings = [];
    this.categoryEnumValues = [];

    for (const level1Node of this.docTree) {
      // 跳过非目录类型
      if (level1Node.type !== "DirectoryType") continue;

      const level1Name = level1Node.name;

      // 遍历二级目录
      if (level1Node.items?.length) {
        for (const level2Node of level1Node.items) {
          // 只处理目录类型的二级节点
          if (level2Node.type !== "DirectoryType") continue;

          const level2Name = level2Node.name;
          const enumValue = `${level1Name}_${level2Name}`;

          this.categoryMappings.push({
            enumValue,
            level1Name,
            level2Name,
            node: level2Node,
          });

          this.categoryEnumValues.push(enumValue);
        }
      }
    }

    // 排序枚举值
    this.categoryEnumValues.sort();
  }

  private registerTools() {
    // 注册 search_feishu_doc 工具（使用动态枚举）
    this.server.registerTool(
      "search_feishu_doc",
      {
        description:
          "搜索飞书开放平台 API 文档。根据分类浏览文档列表，返回该分类下所有文档的标题和路径。适用于查找特定 API 接口、了解某个功能模块有哪些接口等场景。",
        inputSchema: {
          category: z.enum(this.categoryEnumValues as [string, ...string[]]).describe(
            "文档分类，格式为「一级目录_二级目录」，例如「服务端 API_即时通讯」「开发指南_开发机器人」"
          ),
        },
      },
      async (args) => {
        const category = args.category;
        return await this.handleSearchDoc(category);
      }
    );

    // 注册 read_feishu_doc 工具
    this.server.registerTool(
      "read_feishu_doc",
      {
        description:
          "读取飞书开放平台文档的详细内容。根据文档路径获取完整的 API 说明,并保存到本地临时文件。返回文件路径和文件大小,如果文件较大会包含警告提示。使用 Read 工具读取文件内容,对于大文件建议使用 offset/limit 参数分段读取或使用 Grep 搜索特定内容。",
        inputSchema: {
          path: z.string().describe("文档路径，从 search_feishu_doc 结果中获取"),
        },
      },
      async (args) => {
        const docPath = args.path;
        return await this.handleReadDoc(docPath);
      }
    );
  }

  // 递归收集目录下所有文档
  private collectDocuments(node: DocTreeNode): string[] {
    const results: string[] = [];

    if (node.type === "DocumentType") {
      // 是文档，添加到结果（不再显示位置）
      const pathInfo = this.uriMap[node.fullPath] || node.fullPath;
      results.push(`📄 **${node.name}**\n   路径: \`${pathInfo}\``);
    }

    // 递归处理子节点
    if (node.items?.length) {
      for (const child of node.items) {
        results.push(...this.collectDocuments(child));
      }
    }

    return results;
  }

  // 搜索文档
  private async handleSearchDoc(category: string) {
    // 查找对应的分类（调用者已验证 category 有效）
    const mapping = this.categoryMappings.find((m) => m.enumValue === category)!;

    // 收集该分类下的所有文档
    const documents = this.collectDocuments(mapping.node);

    if (documents.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `分类 "${category}" 下没有文档。`,
          },
        ],
      };
    }

    const output = documents.join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `📁 **${mapping.level1Name} > ${mapping.level2Name}** 下共有 ${documents.length} 个文档：\n\n${output}\n\n使用 \`read_feishu_doc\` 并传入路径可获取文档详细内容。`,
        },
      ],
    };
  }

  // 生成文档的临时文件路径
  private getTempFilePath(docPath: string): string {
    // 使用路径的 hash 作为文件名，避免特殊字符问题
    const hash = crypto.createHash("md5").update(docPath).digest("hex").substring(0, 12);
    // 从路径中提取有意义的名称部分
    const pathParts = docPath.split("/").filter(Boolean);
    const namePart = pathParts.slice(-2).join("_").replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_");
    return path.join(TEMP_DOC_DIR, `${namePart}_${hash}.md`);
  }

  // 确保临时目录存在
  private ensureTempDir() {
    if (!fs.existsSync(TEMP_DOC_DIR)) {
      fs.mkdirSync(TEMP_DOC_DIR, { recursive: true });
    }
  }

  // 读取文档内容
  private async handleReadDoc(docPath: string) {
    try {
      // 确定要请求的路径
      let requestPath = docPath;

      // 如果传入的是 fullPath，尝试转换为 mappedPath
      if (this.uriMap[docPath]) {
        requestPath = this.uriMap[docPath];
      }

      // 请求文档内容
      const url = new URL(DOC_DETAIL_URL);
      url.searchParams.set("fullPath", requestPath);
      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(30000),
      });

      const data = await response.json() as { code: number; msg?: string; data: Record<string, unknown> };

      if (data.code !== 0) {
        throw new Error(`API error: ${data.msg || "Unknown error"}`);
      }

      const detail = data.data;

      // 提取文档内容
      let content = "";

      // 文档标题
      if (detail.title) {
        content += `# ${detail.title}\n\n`;
      }

      // 文档描述
      if (detail.description) {
        content += `${detail.description}\n\n`;
      }

      // 主要内容 - 通常在 content 或 body 字段
      if (detail.content) {
        // 如果是 HTML，转换为 Markdown
        if (typeof detail.content === "string" && detail.content.includes("<")) {
          content += turndownService.turndown(detail.content);
        } else {
          content += detail.content;
        }
      } else if (detail.body) {
        if (typeof detail.body === "string" && detail.body.includes("<")) {
          content += turndownService.turndown(detail.body);
        } else {
          content += JSON.stringify(detail.body, null, 2);
        }
      } else {
        // 返回原始数据结构供分析
        content += "```json\n" + JSON.stringify(detail, null, 2) + "\n```";
      }

      // 如果存在 schema 字段，追加到内容中
      if (detail.schema) {
        content += "\n\n---\n\n## Schema\n\n";
        content += "```json\n" + JSON.stringify(detail.schema, null, 2) + "\n```";
      }

      const finalContent = content || "文档内容为空";

      // 保存到临时文件
      this.ensureTempDir();
      const tempFilePath = this.getTempFilePath(docPath);
      fs.writeFileSync(tempFilePath, finalContent, "utf-8");

      // 获取文件大小
      const stats = fs.statSync(tempFilePath);
      const fileSizeBytes = stats.size;
      const fileSizeKB = (fileSizeBytes / 1024).toFixed(2);

      // 大文件阈值：50KB（约 50000 字符，可能占用大量 context window）
      const LARGE_FILE_THRESHOLD = 50 * 1024;
      const isLargeFile = fileSizeBytes > LARGE_FILE_THRESHOLD;

      let message = `文档已保存到: ${tempFilePath}\n文件大小: ${fileSizeKB} KB (${fileSizeBytes} bytes)`;

      if (isLargeFile) {
        message += `\n\n⚠️ 警告: 该文档较大，直接读取可能占用大量 context window。建议使用 Read 工具的 offset 和 limit 参数分段读取，或使用 Grep 工具搜索特定内容。`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: message,
          },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to fetch document: ${message}`);
    }
  }

  async run() {
    // 先初始化并注册工具
    await this.initializeAndRegisterTools();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Feishu Doc MCP Server running on stdio");
  }
}

const server = new FeishuDocServer();
server.run();
