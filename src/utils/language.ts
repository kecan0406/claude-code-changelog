import type { ChangeSummary, Language } from "../types/index.js";

// Hangul Unicode ranges:
// AC00-D7AF: Hangul Syllables
// 1100-11FF: Hangul Jamo
// 3130-318F: Hangul Compatibility Jamo
const HANGUL_REGEX = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;

// Require at least 50% of array items to contain Korean characters.
// Allows technical terms in English while ensuring majority Korean content.
// Empty arrays pass validation (filtered earlier by hasSubstantialContent).
const KOREAN_ITEM_THRESHOLD = 0.5;

export function containsKorean(text: string): boolean {
  return HANGUL_REGEX.test(text);
}

function validateArrayKorean(items: string[]): boolean {
  if (items.length === 0) return true;
  const koreanCount = items.filter((item) => containsKorean(item)).length;
  return koreanCount / items.length >= KOREAN_ITEM_THRESHOLD;
}

export function validateSummaryLanguage(
  summary: Pick<ChangeSummary, "summary" | "cliChanges">,
  language: Language,
): boolean {
  if (language === "en") return true;

  if (!containsKorean(summary.summary)) return false;

  if (!validateArrayKorean(summary.cliChanges)) return false;

  return true;
}
