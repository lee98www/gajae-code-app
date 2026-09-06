import {
  closeConnection as disconnect,
  getConnection as connection,
  getDatabasePath as databasePath,
} from '@/modules/database/connection.js';
import { initializeDatabase as initialize } from '@/modules/database/init-db.js';
import { apiKeysDb as apiKeys } from '@/modules/database/repositories/api-keys.js';
import { appConfigDb as appConfig } from '@/modules/database/repositories/app-config.js';
import { credentialsDb as credentials } from '@/modules/database/repositories/credentials.js';
import {
  gjcTerminalNotificationDispatchesDb as terminalNotificationDispatches,
} from '@/modules/database/repositories/gjc-terminal-notification-dispatches.js';
import { herdrManagedDb as managedHerdr } from '@/modules/database/repositories/herdr-managed.db.js';
import { githubTokensDb as githubTokens } from '@/modules/database/repositories/github-tokens.js';
import {
  notificationChannelEndpointsDb as notificationChannelEndpoints,
} from '@/modules/database/repositories/notification-channel-endpoints.js';
import {
  notificationPreferencesDb as notificationPreferences,
} from '@/modules/database/repositories/notification-preferences.js';
import {
  defaultProjectPermissions as projectPermissionsDefault,
  projectPermissionsDb as projectPermissions,
} from '@/modules/database/repositories/project-permissions.db.js';
import {
  isManagedWorktreePath as managedWorktreePath,
  projectsDb as projects,
} from '@/modules/database/repositories/projects.db.js';
import { scanStateDb as scanState } from '@/modules/database/repositories/scan-state.db.js';
import { sessionsDb as sessions } from '@/modules/database/repositories/sessions.db.js';
import { userDb as users } from '@/modules/database/repositories/users.js';

export {
  apiKeys as apiKeysDb,
  appConfig as appConfigDb,
  connection as getConnection,
  credentials as credentialsDb,
  databasePath as getDatabasePath,
  disconnect as closeConnection,
  githubTokens as githubTokensDb,
  managedHerdr as herdrManagedDb,
  initialize as initializeDatabase,
  managedWorktreePath as isManagedWorktreePath,
  notificationChannelEndpoints as notificationChannelEndpointsDb,
  notificationPreferences as notificationPreferencesDb,
  projectPermissions as projectPermissionsDb,
  projectPermissionsDefault as defaultProjectPermissions,
  projects as projectsDb,
  scanState as scanStateDb,
  sessions as sessionsDb,
  terminalNotificationDispatches as gjcTerminalNotificationDispatchesDb,
  users as userDb,
};

// Managed host ownership and App projection are database contracts shared by
// provider allocation, websocket routing and the Herdr orchestration module.
export { herdrManagedProvisionDb } from './repositories/herdr-managed-provision.db.js';
export type { ProvisionRecord } from './repositories/herdr-managed-provision.db.js';
export { herdrManagedSnapshotsDb, createHerdrManagedSnapshotsDb } from './repositories/herdr-managed-snapshots.db.js';
export type { ManagedRequestIdentity, ManagedSdkRequest, ManagedDecision, ManagedPendingRequest } from './repositories/herdr-managed.db.js';
