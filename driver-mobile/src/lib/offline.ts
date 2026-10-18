import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'farmtotable.driver.access';
const REFRESH_KEY = 'farmtotable.driver.refresh';
const SUBJECT_KEY = 'farmtotable.driver.subject';
const DB_NAME = 'farmtotable-driver.db';

export type QueuedAction = {
  id: string;
  ownerId: string;
  method: 'PATCH' | 'POST';
  path: string;
  payload: Record<string, unknown>;
  createdAt: string;
  state: 'pending' | 'blocked';
  error: string | null;
};

let database: Promise<SQLite.SQLiteDatabase> | undefined;

async function db() {
  database ??= SQLite.openDatabaseAsync(DB_NAME).then(async (connection) => {
    await connection.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS driver_cache (
        cache_key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS driver_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        owner_id TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS driver_outbox_owner_created_idx
        ON driver_outbox(owner_id, created_at);
    `);
    return connection;
  });
  return database;
}

export async function saveCredentials(accessToken: string, refreshToken: string) {
  await SecureStore.setItemAsync(TOKEN_KEY, accessToken);
  await SecureStore.setItemAsync(REFRESH_KEY, refreshToken);
}

export async function saveSubjectId(userId: string) {
  await SecureStore.setItemAsync(SUBJECT_KEY, userId);
}

export async function getSubjectId() {
  return SecureStore.getItemAsync(SUBJECT_KEY);
}

export async function getAccessToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function getRefreshToken() {
  return SecureStore.getItemAsync(REFRESH_KEY);
}

export async function clearCredentials() {
  await Promise.all([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
    SecureStore.deleteItemAsync(SUBJECT_KEY),
  ]);
}

export async function cacheUser(user: { id: string; email: string; full_name: string; roles: string[] }) {
  const connection = await db();
  await connection.runAsync(
    `INSERT INTO driver_cache(cache_key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    `user:${user.id}`,
    JSON.stringify(user),
    new Date().toISOString(),
  );
}

export async function getCachedUser(userId: string) {
  const connection = await db();
  const row = await connection.getFirstAsync<{ value: string }>(
    'SELECT value FROM driver_cache WHERE cache_key = ?',
    `user:${userId}`,
  );
  if (!row) return null;
  try {
    return JSON.parse(row.value) as { id: string; email: string; full_name: string; roles: string[] };
  } catch {
    return null;
  }
}

export async function cacheRoutes(ownerId: string, routes: unknown[]) {
  const connection = await db();
  await connection.runAsync(
    `INSERT INTO driver_cache(cache_key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    `routes:${ownerId}`,
    JSON.stringify(routes),
    new Date().toISOString(),
  );
}

export async function getCachedRoutes(ownerId: string) {
  const connection = await db();
  const row = await connection.getFirstAsync<{ value: string; updated_at: string }>(
    'SELECT value, updated_at FROM driver_cache WHERE cache_key = ?',
    `routes:${ownerId}`,
  );
  if (!row) return null;
  try {
    return { routes: JSON.parse(row.value) as unknown[], updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

export async function enqueueAction(action: Omit<QueuedAction, 'createdAt' | 'state' | 'error'>) {
  const connection = await db();
  await connection.runAsync(
    `INSERT INTO driver_outbox(id, owner_id, method, path, payload, created_at, state)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    action.id,
    action.ownerId,
    action.method,
    action.path,
    JSON.stringify(action.payload),
    new Date().toISOString(),
  );
}

export async function listActions(ownerId: string): Promise<QueuedAction[]> {
  const connection = await db();
  const rows = await connection.getAllAsync<{
    id: string; owner_id: string; method: 'PATCH' | 'POST'; path: string;
    payload: string; created_at: string; state: 'pending' | 'blocked'; error: string | null;
  }>('SELECT * FROM driver_outbox WHERE owner_id = ? ORDER BY created_at, id', ownerId);
  return rows.map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    method: row.method,
    path: row.path,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at,
    state: row.state,
    error: row.error,
  }));
}

export async function setActionBlocked(id: string, error: string) {
  const connection = await db();
  await connection.runAsync("UPDATE driver_outbox SET state = 'blocked', error = ? WHERE id = ?", error, id);
}

export async function retryAction(id: string) {
  const connection = await db();
  await connection.runAsync("UPDATE driver_outbox SET state = 'pending', error = NULL WHERE id = ?", id);
}

export async function removeAction(id: string) {
  const connection = await db();
  await connection.runAsync('DELETE FROM driver_outbox WHERE id = ?', id);
}
