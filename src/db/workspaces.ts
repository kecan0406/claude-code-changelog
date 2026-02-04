import { getRedis, KeyPrefix, buildKey } from "./redis.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";
import type {
  Workspace,
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
} from "../types/database.js";
import type { Language } from "../types/index.js";

// Redis storage format for workspace
interface WorkspaceData {
  id: string;
  teamId: string;
  teamName: string;
  botToken: string; // encrypted
  channelId: string;
  language: Language;
  isActive: boolean;
  installedAt: string; // ISO string
  updatedAt: string; // ISO string
}

function dataToWorkspace(data: WorkspaceData): Workspace {
  return {
    id: data.id,
    teamId: data.teamId,
    teamName: data.teamName,
    botToken: decrypt(data.botToken),
    channelId: data.channelId,
    language: data.language,
    isActive: data.isActive,
    installedAt: new Date(data.installedAt),
    updatedAt: new Date(data.updatedAt),
  };
}

function workspaceKey(teamId: string): string {
  return buildKey(KeyPrefix.WORKSPACE, teamId);
}

function generateId(): string {
  return crypto.randomUUID();
}

export async function getActiveWorkspaces(): Promise<Workspace[]> {
  try {
    const redis = getRedis();
    const teamIds = await redis.smembers(KeyPrefix.WORKSPACES_ACTIVE);

    if (teamIds.length === 0) {
      return [];
    }

    const keys = teamIds.map((id) => workspaceKey(id));
    const results = await redis.mget<(WorkspaceData | null)[]>(...keys);

    const workspaces = results
      .filter((data): data is WorkspaceData => data !== null && data.isActive)
      .map(dataToWorkspace);

    // Sort by installedAt ASC
    return workspaces.sort(
      (a, b) => a.installedAt.getTime() - b.installedAt.getTime(),
    );
  } catch (error) {
    logger.error("Failed to get active workspaces", error);
    throw error;
  }
}

export async function getWorkspaceByTeamId(
  teamId: string,
): Promise<Workspace | null> {
  try {
    const redis = getRedis();
    const data = await redis.get<WorkspaceData>(workspaceKey(teamId));
    return data ? dataToWorkspace(data) : null;
  } catch (error) {
    logger.error(`Failed to get workspace for team ${teamId}`, error);
    throw error;
  }
}

export async function getWorkspaceById(id: string): Promise<Workspace | null> {
  // Since we use teamId as the key, we need to scan active workspaces
  try {
    const redis = getRedis();
    const teamIds = await redis.smembers(KeyPrefix.WORKSPACES_ACTIVE);

    for (const teamId of teamIds) {
      const data = await redis.get<WorkspaceData>(workspaceKey(teamId));
      if (data && data.id === id) {
        return dataToWorkspace(data);
      }
    }
    return null;
  } catch (error) {
    logger.error(`Failed to get workspace ${id}`, error);
    throw error;
  }
}

export async function createWorkspace(
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  const redis = getRedis();
  const key = workspaceKey(input.teamId);
  const now = new Date().toISOString();

  try {
    // Check if workspace exists (upsert behavior)
    const existing = await redis.get<WorkspaceData>(key);

    const data: WorkspaceData = {
      id: existing?.id || generateId(),
      teamId: input.teamId,
      teamName: input.teamName,
      botToken: encrypt(input.botToken),
      channelId: input.channelId,
      language: input.language || "en",
      isActive: true,
      installedAt: existing?.installedAt || now,
      updatedAt: now,
    };

    // Use pipeline for atomic execution of set + sadd
    const pipeline = redis.pipeline();
    pipeline.set(key, data);
    pipeline.sadd(KeyPrefix.WORKSPACES_ACTIVE, input.teamId);
    await pipeline.exec();

    logger.info(`Workspace created/updated for team ${input.teamId}`);
    return dataToWorkspace(data);
  } catch (error) {
    logger.error(`Failed to create workspace for team ${input.teamId}`, error);
    throw error;
  }
}

export async function updateWorkspace(
  teamId: string,
  input: UpdateWorkspaceInput,
): Promise<Workspace | null> {
  const redis = getRedis();
  const key = workspaceKey(teamId);

  try {
    const existing = await redis.get<WorkspaceData>(key);

    if (!existing) {
      return null;
    }

    const updated: WorkspaceData = {
      ...existing,
      teamName: input.teamName ?? existing.teamName,
      botToken:
        input.botToken !== undefined
          ? encrypt(input.botToken)
          : existing.botToken,
      channelId: input.channelId ?? existing.channelId,
      language: input.language ?? existing.language,
      isActive: input.isActive ?? existing.isActive,
      updatedAt: new Date().toISOString(),
    };

    // Use pipeline for atomic execution
    const pipeline = redis.pipeline();
    pipeline.set(key, updated);

    // Update active set membership
    if (input.isActive === true) {
      pipeline.sadd(KeyPrefix.WORKSPACES_ACTIVE, teamId);
    } else if (input.isActive === false) {
      pipeline.srem(KeyPrefix.WORKSPACES_ACTIVE, teamId);
    }

    await pipeline.exec();

    logger.info(`Workspace updated for team ${teamId}`);
    return dataToWorkspace(updated);
  } catch (error) {
    logger.error(`Failed to update workspace for team ${teamId}`, error);
    throw error;
  }
}

export async function deactivateWorkspace(teamId: string): Promise<boolean> {
  const redis = getRedis();
  const key = workspaceKey(teamId);

  try {
    const existing = await redis.get<WorkspaceData>(key);

    if (!existing) {
      return false;
    }

    const updated: WorkspaceData = {
      ...existing,
      isActive: false,
      updatedAt: new Date().toISOString(),
    };

    // Use pipeline for atomic execution
    const pipeline = redis.pipeline();
    pipeline.set(key, updated);
    pipeline.srem(KeyPrefix.WORKSPACES_ACTIVE, teamId);
    await pipeline.exec();

    logger.info(`Workspace deactivated for team ${teamId}`);
    return true;
  } catch (error) {
    logger.error(`Failed to deactivate workspace for team ${teamId}`, error);
    throw error;
  }
}

export async function getWorkspacesByLanguage(
  language: Language,
): Promise<Workspace[]> {
  try {
    const workspaces = await getActiveWorkspaces();
    return workspaces.filter((w) => w.language === language);
  } catch (error) {
    logger.error(`Failed to get workspaces for language ${language}`, error);
    throw error;
  }
}

export async function countActiveWorkspaces(): Promise<number> {
  try {
    const redis = getRedis();
    return await redis.scard(KeyPrefix.WORKSPACES_ACTIVE);
  } catch (error) {
    logger.error("Failed to count active workspaces", error);
    throw error;
  }
}
