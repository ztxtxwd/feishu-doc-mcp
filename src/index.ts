#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { z } from "zod";


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

  // 按二级标题拆分文档内容
  private splitByH2(content: string, baseFilePath: string): string[] {
    const savedFiles: string[] = [];
    const lines = content.split("\n");

    // 找到所有二级标题的位置
    const h2Indices: { index: number; title: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("## ")) {
        const title = line.substring(3).trim();
        h2Indices.push({ index: i, title });
      }
    }

    // 如果没有二级标题或只有一个，不拆分
    if (h2Indices.length <= 1) {
      return savedFiles;
    }

    // 获取一级标题（如果有）
    let h1Title = "";
    for (const line of lines) {
      if (line.startsWith("# ") && !line.startsWith("## ")) {
        h1Title = line;
        break;
      }
    }

    // 创建拆分文件的目录
    const baseDir = path.dirname(baseFilePath);
    const baseName = path.basename(baseFilePath, ".md");
    const splitDir = path.join(baseDir, baseName);
    if (!fs.existsSync(splitDir)) {
      fs.mkdirSync(splitDir, { recursive: true });
    }

    // 拆分每个二级标题的内容
    for (let i = 0; i < h2Indices.length; i++) {
      const { index: startIdx, title } = h2Indices[i];
      const endIdx = i < h2Indices.length - 1 ? h2Indices[i + 1].index : lines.length;

      // 提取该二级标题下的内容
      const sectionLines = lines.slice(startIdx, endIdx);

      // 构建文件内容：一级标题 + 二级标题内容
      let sectionContent = "";
      if (h1Title) {
        sectionContent = h1Title + "\n\n";
      }
      sectionContent += sectionLines.join("\n").trim();

      // 清理标题中的特殊字符作为文件名
      const cleanTitle = title
        .replace(/[<>:"/\\|?*]/g, "_")  // 替换文件名非法字符
        .replace(/\s+/g, "_")            // 空格替换为下划线
        .substring(0, 50);               // 限制长度

      // 生成文件名：标题.md
      let fileName = `${cleanTitle}.md`;
      let filePath = path.join(splitDir, fileName);

      fs.writeFileSync(filePath, sectionContent, "utf-8");

      // 检查文件大小，大文件重命名加提示
      const LARGE_FILE_THRESHOLD = 50 * 1024;
      const stats = fs.statSync(filePath);
      if (stats.size > LARGE_FILE_THRESHOLD) {
        const newFileName = `[大文件勿直接读取]${cleanTitle}.md`;
        const newFilePath = path.join(splitDir, newFileName);
        fs.renameSync(filePath, newFilePath);
        filePath = newFilePath;
      }

      savedFiles.push(filePath);
    }

    return savedFiles;
  }

  // 清理 Markdown 内容：去除 md-* 标签和多余空行
  private cleanMarkdownContent(content: string): string {
    let cleaned = content;

    // 去除 :::html 和 ::: 块
    cleaned = cleaned.replace(/:::html\n?/g, "");
    cleaned = cleaned.replace(/:::\n?/g, "");

    // 去除所有 <md-*> 标签（开标签和闭标签，包含属性）
    cleaned = cleaned.replace(/<md-[a-z0-9-]+[^>]*>/g, "");
    cleaned = cleaned.replace(/<\/md-[a-z0-9-]+>/g, "");

    // 去除其他常见 HTML 标签
    cleaned = cleaned.replace(/<div[^>]*>/g, "");
    cleaned = cleaned.replace(/<\/div>/g, "");
    cleaned = cleaned.replace(/<tr>/g, "");
    cleaned = cleaned.replace(/<\/tr>/g, "");
    cleaned = cleaned.replace(/<font[^>]*>/g, "");
    cleaned = cleaned.replace(/<\/font>/g, "");

    // 去除多余空行：将连续多个空行减少到最多一个
    const lines = cleaned.split("\n");
    const result: string[] = [];
    let prevEmpty = false;

    for (const line of lines) {
      const stripped = line.trim();
      if (stripped === "") {
        if (!prevEmpty) {
          result.push("");
        }
        prevEmpty = true;
      } else {
        result.push(stripped);
        prevEmpty = false;
      }
    }

    return result.join("\n");
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

      // 主要内容
      if (detail.content) {
        content += detail.content;
      } else if (detail.body) {
        content += typeof detail.body === "string" ? detail.body : JSON.stringify(detail.body, null, 2);
      } else {
        // 返回原始数据结构供分析
        content += "```json\n" + JSON.stringify(detail, null, 2) + "\n```";
      }

      const finalContent = this.cleanMarkdownContent(content || "文档内容为空");

      // 保存到临时文件
      this.ensureTempDir();
      const tempFilePath = this.getTempFilePath(docPath);
      fs.writeFileSync(tempFilePath, finalContent, "utf-8");

      // 按二级标题拆分文档
      const splitFiles = this.splitByH2(finalContent, tempFilePath);

      // 如果成功拆分，删除完整文档文件
      if (splitFiles.length > 0) {
        fs.unlinkSync(tempFilePath);
      }

      // 确定请求示例保存目录（优先使用拆分目录）
      const baseName = path.basename(tempFilePath, ".md");
      const examplesDir = splitFiles.length > 0
        ? path.dirname(splitFiles[0])
        : TEMP_DOC_DIR;

      // 如果存在 schema 字段，提取各语言的请求示例并分别保存
      const savedExampleFiles: string[] = [];
      const schema = detail.schema as Record<string, unknown> | undefined;
      const apiSchema = schema?.apiSchema as Record<string, unknown> | undefined;
      const requestBody = apiSchema?.requestBody as Record<string, unknown> | undefined;
      const contentObj = requestBody?.content as Record<string, unknown> | undefined;
      const jsonContent = contentObj?.["application/json"] as Record<string, unknown> | undefined;
      const examples = jsonContent?.examples as Record<string, { value?: unknown }> | undefined;

      if (examples) {
        // 过滤掉不需要的语言示例
        const excludedLangs = ["curl", "c#-restsharp", "php-guzzle"];

        for (const [lang, exampleData] of Object.entries(examples)) {
          if (excludedLangs.includes(lang)) continue;
          if (exampleData && typeof exampleData === "object" && "value" in exampleData) {
            const exampleContent = exampleData.value as string;
            const exampleFileName = `${baseName}-${lang}-请求示例`;
            const exampleFilePath = path.join(examplesDir, exampleFileName);
            fs.writeFileSync(exampleFilePath, exampleContent, "utf-8");
            savedExampleFiles.push(exampleFilePath);
          }
        }
      }

      // 构建返回消息
      let message = "";

      // 添加标题和描述
      if (detail.name) {
        message += `# ${detail.name}\n\n`;
      }
      if (detail.description) {
        message += `${detail.description}\n\n`;
      }

      if (splitFiles.length > 0) {
        // 文档已拆分
        const splitDir = path.dirname(splitFiles[0]);
        const fileNames = splitFiles.map((f) => `  - ${path.basename(f)}`).join("\n");
        message += `文档已按二级标题拆分为 ${splitFiles.length} 个文件:\n目录: ${splitDir}\n${fileNames}`;
      } else {
        // 未拆分，保存完整文档
        const stats = fs.statSync(tempFilePath);
        const fileSizeBytes = stats.size;
        const fileSizeKB = (fileSizeBytes / 1024).toFixed(2);

        const LARGE_FILE_THRESHOLD = 50 * 1024;
        const isLargeFile = fileSizeBytes > LARGE_FILE_THRESHOLD;

        message += `文档已保存到: ${tempFilePath}\n文件大小: ${fileSizeKB} KB (${fileSizeBytes} bytes)`;

        if (isLargeFile) {
          message += `\n\n⚠️ 警告: 该文档较大，直接读取可能占用大量 context window。建议使用 Read 工具的 offset 和 limit 参数分段读取，或使用 Grep 工具搜索特定内容。`;
        }
      }

      if (savedExampleFiles.length > 0) {
        message += `\n\n请求示例文件已保存:\n${savedExampleFiles.map((f) => `  - ${f}`).join("\n")}`;
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

  // 清理临时目录
  private cleanupTempDir() {
    if (fs.existsSync(TEMP_DOC_DIR)) {
      fs.rmSync(TEMP_DOC_DIR, { recursive: true, force: true });
      console.error(`[Cleanup] Removed temp directory: ${TEMP_DOC_DIR}`);
    }
  }

  async run() {
    // 启动时清理临时目录
    this.cleanupTempDir();

    // 先初始化并注册工具
    await this.initializeAndRegisterTools();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Feishu Doc MCP Server running on stdio");
  }
}

const server = new FeishuDocServer();
server.run();
