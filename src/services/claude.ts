import Anthropic from "@anthropic-ai/sdk";
import type { ChangelogDiff, ChangeSummary, Language } from "../types/index.js";
import { logger } from "../utils/logger.js";

const CLAUDE_CONFIG = {
  MODEL: "claude-haiku-4-5",
  MAX_TOKENS: 2048,
} as const;

type ParsedSummary = Omit<ChangeSummary, "version">;

interface ToolDescriptions {
  description: string;
  summary: string;
  promptChanges: string;
  cliChanges: string;
  flagAdded: string;
  flagRemoved: string;
  flagModified: string;
}

const TOOL_DESCRIPTIONS: Record<Language, ToolDescriptions> = {
  en: {
    description: "Submit Claude Code changelog summary",
    summary: "2-3 sentence summary of overall changes",
    promptChanges: "List of prompt changes (one sentence each)",
    cliChanges: "List of CLI changelog items (one sentence each)",
    flagAdded: "List of newly added feature flags",
    flagRemoved: "List of removed feature flags",
    flagModified: "List of modified feature flags",
  },
  ko: {
    description: "Claude Code 변경 사항 요약을 제출합니다",
    summary: "전체 변경 사항에 대한 2-3문장 요약",
    promptChanges: "프롬프트 변경 사항 목록 (각 항목은 한 문장)",
    cliChanges: "CLI 변경 사항 목록 (한국어로 번역, 기술 용어는 영어 유지)",
    flagAdded: "새로 추가된 feature flag 목록",
    flagRemoved: "제거된 feature flag 목록",
    flagModified: "수정된 feature flag 목록",
  },
};

function createSummaryTool(language: Language): Anthropic.Tool {
  const desc = TOOL_DESCRIPTIONS[language];
  return {
    name: "submit_changelog_summary",
    description: desc.description,
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: desc.summary,
        },
        promptChanges: {
          type: "array",
          items: { type: "string" },
          description: desc.promptChanges,
        },
        cliChanges: {
          type: "array",
          items: { type: "string" },
          description: desc.cliChanges,
        },
        flagChanges: {
          type: "object",
          properties: {
            added: {
              type: "array",
              items: { type: "string" },
              description: desc.flagAdded,
            },
            removed: {
              type: "array",
              items: { type: "string" },
              description: desc.flagRemoved,
            },
            modified: {
              type: "array",
              items: { type: "string" },
              description: desc.flagModified,
            },
          },
          required: ["added", "removed", "modified"],
        },
      },
      required: ["summary", "promptChanges", "cliChanges", "flagChanges"],
    },
  };
}

interface PromptTemplates {
  system: string;
}

const PROMPT_TEMPLATES: Record<Language, PromptTemplates> = {
  en: {
    system: `You are an expert at analyzing Claude Code changes.

Below are the changes from Claude Code {fromVersion} to {toVersion}.
Analyze the changes and provide a summary in English.

## Changed file diff:
{diffContent}

## CLI Changelog (from GitHub releases):
{cliChanges}

## Analysis guidelines:
- Explain technical content in a developer-friendly way
- Leave empty arrays for categories with no changes
- Include CLI changes in the cliChanges field as-is
- Use the submit_changelog_summary tool to submit results`,
  },
  ko: {
    system: `당신은 Claude Code의 변경 사항을 분석하는 전문가입니다.

아래는 Claude Code {fromVersion}에서 {toVersion}으로의 변경 사항입니다.
변경 내용을 분석하여 한국어로 요약해주세요.

## 변경 파일 diff:
{diffContent}

## CLI 변경 사항 (GitHub 릴리즈에서 가져옴, 한국어로 번역 필요):
{cliChanges}

## 분석 지침:
- 기술적인 내용을 개발자가 이해하기 쉽게 설명해주세요
- 변경 사항이 없는 카테고리는 빈 배열로 남겨주세요
- CLI 변경 사항은 한국어로 번역하여 cliChanges 필드에 포함해주세요
- 기술 용어(함수명, 파일명, 설정값 등)는 영어로 유지해주세요
- submit_changelog_summary 도구를 사용하여 결과를 제출해주세요`,
  },
};

function parseStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "string")
      ? (value as string[])
      : null;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (
        Array.isArray(parsed) &&
        parsed.every((item) => typeof item === "string")
      ) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeParsedSummary(
  data: unknown,
  fallbackCliChanges: string[],
): ParsedSummary | null {
  if (typeof data !== "object" || data === null) return null;

  const obj = data as Record<string, unknown>;

  if (typeof obj.summary !== "string") return null;

  const promptChanges = parseStringArray(obj.promptChanges);
  if (!promptChanges) return null;

  // Fallback to original cliChanges if Claude's translation fails or is malformed
  // This ensures notifications are sent even with untranslated CLI content
  const parsedCliChanges = parseStringArray(obj.cliChanges);
  if (!parsedCliChanges) {
    logger.warn(
      "Failed to parse cliChanges from Claude response, using fallback",
    );
  }
  const cliChanges = parsedCliChanges || fallbackCliChanges;

  if (typeof obj.flagChanges !== "object" || obj.flagChanges === null)
    return null;
  const flags = obj.flagChanges as Record<string, unknown>;

  const added = parseStringArray(flags.added);
  const removed = parseStringArray(flags.removed);
  const modified = parseStringArray(flags.modified);

  if (!added || !removed || !modified) return null;

  return {
    summary: obj.summary,
    promptChanges,
    cliChanges,
    flagChanges: { added, removed, modified },
  };
}

export async function generateSummary(
  apiKey: string,
  language: Language,
  diff: ChangelogDiff,
  cliChanges: string[] = [],
): Promise<ChangeSummary> {
  const client = new Anthropic({ apiKey });

  const diffContent = diff.files
    .map((file) => `### ${file.filename}\n\`\`\`diff\n${file.patch}\n\`\`\``)
    .join("\n\n");

  const cliChangesText =
    cliChanges.length > 0
      ? cliChanges.map((c) => `- ${c}`).join("\n")
      : "(No CLI changes)";

  const template = PROMPT_TEMPLATES[language];
  const prompt = template.system
    .replace("{fromVersion}", diff.fromVersion)
    .replace("{toVersion}", diff.toVersion)
    .replace("{diffContent}", diffContent)
    .replace("{cliChanges}", cliChangesText);

  try {
    logger.info(`Generating summary with Claude API (language: ${language})`);

    const response = await client.messages.create({
      model: CLAUDE_CONFIG.MODEL,
      max_tokens: CLAUDE_CONFIG.MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
      tools: [createSummaryTool(language)],
      tool_choice: { type: "tool", name: "submit_changelog_summary" },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (!toolUse) {
      throw new Error("No tool use response from Claude");
    }

    const parsed = normalizeParsedSummary(toolUse.input, cliChanges);
    if (!parsed) {
      logger.error("Invalid tool input structure", { input: toolUse.input });
      throw new Error("Tool input does not match expected structure");
    }

    logger.info("Summary generated successfully");

    return {
      version: diff.toVersion,
      ...parsed,
    };
  } catch (error) {
    logger.error("Failed to generate summary", error);
    throw error;
  }
}
