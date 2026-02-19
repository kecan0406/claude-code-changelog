export interface TagInfo {
  name: string;
  commitSha: string;
  date: string;
}

export type Language = "en" | "ko";

export interface ChangeSummary {
  version: string;
  summary: string;
  cliChanges: string[];
}

export interface SlackMessage {
  version: string;
  summary: ChangeSummary;
  cliCompareUrl: string;
}
