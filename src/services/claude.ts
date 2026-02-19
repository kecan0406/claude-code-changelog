import Anthropic from "@anthropic-ai/sdk";
import type {
  ChangelogDiff,
  ChangeSummary,
  FileDiff,
  Language,
} from "../types/index.js";
import { logger } from "../utils/logger.js";
import { validateSummaryLanguage } from "../utils/language.js";
import { withRetry } from "../utils/retry.js";

const CLAUDE_CONFIG = {
  MODEL: "claude-haiku-4-5",
  MAX_TOKENS: 2048,
  TIMEOUT_MS: 60_000, // 60 seconds
} as const;

type ParsedSummary = Omit<ChangeSummary, "version">;

// XML attribute escape
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Template variable interpolation (global flag)
function interpolateTemplate(
  template: string,
  vars: {
    fromVersion: string;
    toVersion: string;
    diffContent: string;
    cliChanges: string;
  },
): string {
  return template
    .replace(/{fromVersion}/g, vars.fromVersion)
    .replace(/{toVersion}/g, vars.toVersion)
    .replace(/{diffContent}/g, vars.diffContent)
    .replace(/{cliChanges}/g, vars.cliChanges);
}

// Format diff as XML
function formatDiffAsXml(files: FileDiff[]): string {
  if (files.length === 0) return "<no-changes />";
  return files
    .map(
      (f) =>
        `<file name="${escapeXmlAttribute(f.filename)}">\n${f.patch}\n</file>`,
    )
    .join("\n");
}

// Format CLI changes as XML
function formatCliChangesAsXml(changes: string[]): string {
  if (changes.length === 0) return "<no-changes />";
  return changes.map((c) => `<item>${c}</item>`).join("\n");
}

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
    summary: "1-2 sentence concise summary of the most important changes",
    promptChanges: "List of prompt changes (one sentence each)",
    cliChanges: "List of CLI changelog items (one sentence each)",
    flagAdded: "List of newly added feature flags",
    flagRemoved: "List of removed feature flags",
    flagModified: "List of modified feature flags",
  },
  ko: {
    description:
      "Claude Code 변경 사항 요약을 한국어로 제출합니다. 모든 필드는 반드시 한국어로 작성해야 합니다.",
    summary:
      "가장 중요한 변경 사항에 대한 1-2문장 간결 요약 (반드시 한국어로 작성)",
    promptChanges:
      "프롬프트 변경 사항 목록 (각 항목은 한국어 한 문장, 기술 용어만 영어 허용)",
    cliChanges:
      "CLI 변경 사항 목록 (반드시 한국어로 번역, 기술 용어만 영어 유지)",
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
  user: string;
}

const PROMPT_TEMPLATES: Record<Language, PromptTemplates> = {
  en: {
    system: `<role>
You are an expert at analyzing Claude Code changes.
</role>

<instructions>
  <guideline>Explain technical content in a developer-friendly way</guideline>
  <guideline>Keep the summary to 1-2 sentences, focused on the most impactful changes</guideline>
  <guideline>Leave empty arrays for categories with no changes</guideline>
  <guideline>Include CLI changes in the cliChanges field as-is</guideline>
  <guideline>Use the submit_changelog_summary tool to submit results</guideline>
</instructions>

<critical-rule name="prompt-change-criteria">
promptChanges = changes to instructions, rules, or behavioral definitions given to Claude.
EXCLUDE "extraction-time context" that changes every release (version numbers, dates, timestamps, paths, working directories).
Only include changes that would make Claude behave differently.
</critical-rule>`,

    user: `<context>
  <from-version>{fromVersion}</from-version>
  <to-version>{toVersion}</to-version>
</context>

<diff>
{diffContent}
</diff>

<cli-changelog>
{cliChanges}
</cli-changelog>

Analyze the changes from {fromVersion} to {toVersion} and provide a summary in English.`,
  },
  ko: {
    system: `<language>한국어</language>

<role>
당신은 Claude Code의 변경 사항을 분석하는 전문가입니다.
모든 출력은 반드시 한국어로 작성해야 합니다.
</role>

<instructions>
  <guideline>기술적인 내용을 개발자가 이해하기 쉽게 설명해주세요</guideline>
  <guideline>요약은 1-2문장으로, 핵심 변경 사항 위주로 간결하게 작성해주세요</guideline>
  <guideline>변경 사항이 없는 카테고리는 빈 배열로 남겨주세요</guideline>
  <guideline>CLI 변경 사항은 한국어로 번역하여 cliChanges 필드에 포함해주세요</guideline>
  <guideline>기술 용어(함수명, 파일명, 설정값 등)는 영어로 유지해주세요</guideline>
  <guideline>submit_changelog_summary 도구를 사용하여 결과를 제출해주세요</guideline>
</instructions>

<critical-rule name="prompt-change-criteria">
promptChanges = Claude에게 주어지는 지시, 규칙, 동작 정의의 변경.
매 릴리즈마다 바뀌는 "추출 시점 컨텍스트"는 제외 (버전, 날짜, 타임스탬프, 경로, working directory).
Claude의 동작이 달라지는 변경만 포함해주세요.
</critical-rule>

<critical-rule name="output-language">
summary, promptChanges, cliChanges 필드의 모든 텍스트는 반드시 한국어로 작성하세요.
영어로 작성하면 안 됩니다. 기술 용어(함수명, 파일명, 설정값, flag 이름)만 영어를 허용합니다.
</critical-rule>`,

    user: `<context>
  <from-version>{fromVersion}</from-version>
  <to-version>{toVersion}</to-version>
</context>

<diff>
{diffContent}
</diff>

<cli-changelog translation-required="true">
{cliChanges}
</cli-changelog>

<example>
다음은 올바른 한국어 출력 예시입니다:
- summary: "컨텍스트 프로토콜 처리 개선 및 메모리 관리 최적화가 적용되었습니다."
- promptChanges: ["tool_use 응답에서 JSON 파싱 규칙이 강화되었습니다", "코드 생성 시 보안 검증 단계가 추가되었습니다"]
- cliChanges: ["--max-tokens 플래그의 기본값이 4096으로 변경되었습니다", "새로운 --output-format 옵션이 추가되었습니다"]
위의 예시처럼 모든 필드를 반드시 한국어로 작성해주세요.
</example>

{fromVersion}에서 {toVersion}으로의 변경 사항을 분석하여 반드시 한국어로 요약해주세요.`,
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
  const client = new Anthropic({
    apiKey,
    timeout: CLAUDE_CONFIG.TIMEOUT_MS,
  });

  // XML format
  const diffContent = formatDiffAsXml(diff.files);
  const cliChangesText = formatCliChangesAsXml(cliChanges);

  const template = PROMPT_TEMPLATES[language];
  const userMessage = interpolateTemplate(template.user, {
    fromVersion: diff.fromVersion,
    toVersion: diff.toVersion,
    diffContent,
    cliChanges: cliChangesText,
  });

  try {
    logger.info(`Generating summary with Claude API (language: ${language})`);

    const response = await withRetry(
      () =>
        client.messages.create({
          model: CLAUDE_CONFIG.MODEL,
          max_tokens: CLAUDE_CONFIG.MAX_TOKENS,
          system: template.system,
          messages: [{ role: "user", content: userMessage }],
          tools: [createSummaryTool(language)],
          tool_choice: { type: "tool", name: "submit_changelog_summary" },
        }),
      { maxAttempts: 3, baseDelayMs: 2000 },
    );

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

    if (validateSummaryLanguage(parsed, language)) {
      logger.info("Summary generated successfully");
      return { version: diff.toVersion, ...parsed };
    }

    // Language validation failed - retry once with reinforced prompt
    logger.warn(
      `Summary language mismatch for ${language}, retrying with reinforced prompt`,
    );

    const retryResponse = await withRetry(
      () =>
        client.messages.create({
          model: CLAUDE_CONFIG.MODEL,
          max_tokens: CLAUDE_CONFIG.MAX_TOKENS,
          system:
            template.system +
            "\n\n<critical-rule>Previous attempt produced wrong language output. You MUST write ALL content in the requested language.</critical-rule>",
          messages: [{ role: "user", content: userMessage }],
          tools: [createSummaryTool(language)],
          tool_choice: { type: "tool", name: "submit_changelog_summary" },
        }),
      { maxAttempts: 2, baseDelayMs: 2000 },
    );

    const retryToolUse = retryResponse.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (!retryToolUse) {
      throw new Error("No tool use response from Claude on retry");
    }

    const retryParsed = normalizeParsedSummary(retryToolUse.input, cliChanges);
    if (!retryParsed) {
      throw new Error("Invalid tool input structure on retry");
    }

    if (!validateSummaryLanguage(retryParsed, language)) {
      throw new Error(
        `Summary language validation failed for ${language} after retry`,
      );
    }

    logger.info("Summary generated successfully on retry");
    return { version: diff.toVersion, ...retryParsed };
  } catch (error) {
    logger.error("Failed to generate summary", error);
    throw error;
  }
}
