import { promises as fileSystem } from 'node:fs';
import nodePath from 'node:path';

import { getConnection, projectsDb as projectStore, sessionsDb as sessionStore } from '@/modules/database/index.js';
import { AppError as ApplicationError, normalizeProjectPath } from '@/shared/utils.js';

function unknownProject(projectId: string): ApplicationError {
  return new ApplicationError(`Unknown projectId: ${projectId}`, {
    code: 'PROJECT_NOT_FOUND',
    statusCode: 404,
  });
}

function uniqueSessionFilePaths(rows: Array<{ jsonl_path: string | null }>): string[] {
  const paths = new Set<string>();
  rows.forEach(({ jsonl_path: jsonlPath }) => {
    const filename = jsonlPath?.trim();
    if (!filename) return;
    paths.add(nodePath.isAbsolute(filename) ? nodePath.normalize(filename) : nodePath.resolve(filename));
  });
  return Array.from(paths);
}

async function discardSessionFile(filename: string): Promise<void> {
  // Already-gone files are the desired end state; anything else is only worth a warning.
  await fileSystem.unlink(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return;
    console.warn(`[project-delete] Failed to remove ${filename}:`, error.message);
  });
}

/**
 * A project force-delete removes every session row, and managed bindings and
 * provisions cascade with them. That must never overtake a live or uncertain
 * owner: the same closure proof required for a single session applies to the
 * whole project, checked under the writer lock that performs the deletion.
 */
function assertManagedOwnersClosed(projectPath: string): void {
  const db = getConnection();
  const unsafe = db.prepare(`SELECT s.session_id FROM sessions s WHERE s.project_path = ? AND (
      EXISTS (SELECT 1 FROM herdr_managed_bindings b WHERE b.app_session_id = s.session_id AND b.lifecycle <> 'closed')
      OR EXISTS (SELECT 1 FROM herdr_managed_provisions p WHERE p.app_session_id = s.session_id AND NOT EXISTS (
        SELECT 1 FROM herdr_managed_bindings b WHERE b.app_session_id = p.app_session_id
        AND b.owner_generation = p.owner_generation AND b.lifecycle = 'closed')))
    LIMIT 1`).get(normalizeProjectPath(projectPath)) as { session_id: string } | undefined;
  if (unsafe) {
    throw new ApplicationError('Managed session owner must be confirmed closed before deletion.', {
      code: 'MANAGED_SESSION_NOT_CLOSED', statusCode: 409,
    });
  }
}

export async function deleteOrArchiveProject(projectId: string, force: boolean): Promise<void> {
  const project = projectStore.getProjectById(projectId);
  if (!project) throw unknownProject(projectId);

  if (!force) return void projectStore.updateProjectIsArchivedById(projectId, true);

  // Admission and the row cascade are one writer transaction: no reservation,
  // claim or closure can interleave between the fence and the deletion. Only
  // the transcripts of rows that transaction removed are discarded afterwards,
  // so an owner admitted later in the same project keeps its own history and
  // a refused deletion removes nothing.
  const transcripts = getConnection().transaction(() => {
    assertManagedOwnersClosed(project.project_path);
    const sessions = sessionStore.getSessionsByProjectPathIncludingArchived(project.project_path);
    sessionStore.deleteSessionsByProjectPath(project.project_path);
    projectStore.deleteProjectById(projectId);
    return uniqueSessionFilePaths(sessions);
  }).immediate();
  for (const filename of transcripts) await discardSessionFile(filename);
}

export function restoreArchivedProject(projectId: string): void {
  const project = projectStore.getProjectById(projectId);
  if (!project) throw unknownProject(projectId);
  projectStore.updateProjectIsArchivedById(projectId, false);
}
