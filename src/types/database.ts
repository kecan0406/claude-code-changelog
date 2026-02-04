import type { Language } from "./index.js";

export interface Workspace {
  id: string;
  teamId: string;
  teamName: string;
  botToken: string;
  channelId: string;
  language: Language;
  isActive: boolean;
  installedAt: Date;
  updatedAt: Date;
}

export interface CreateWorkspaceInput {
  teamId: string;
  teamName: string;
  botToken: string;
  channelId: string;
  language?: Language;
}

export interface UpdateWorkspaceInput {
  teamName?: string;
  botToken?: string;
  channelId?: string;
  language?: Language;
  isActive?: boolean;
}
