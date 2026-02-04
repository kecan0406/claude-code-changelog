export interface TagInfo {
  name: string;
  commitSha: string;
  date: string;
}

export interface FileDiff {
  filename: string;
  patch: string;
  additions: number;
  deletions: number;
}

export interface ChangelogDiff {
  fromVersion: string;
  toVersion: string;
  files: FileDiff[];
  compareUrl: string;
}

export type Language = "en" | "ko";

export interface ChangeSummary {
  version: string;
  summary: string;
  cliChanges: string[];
  promptChanges: string[];
  flagChanges: {
    added: string[];
    removed: string[];
    modified: string[];
  };
}

export interface SlackMessage {
  version: string;
  summary: ChangeSummary;
  compareUrl: string;
  cliCompareUrl: string;
}
