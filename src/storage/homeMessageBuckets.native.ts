import { open, type QueryResult, type QuickSQLiteConnection } from 'react-native-quick-sqlite';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { storage } from '../storage';

export type HomeMessageBuckets = Record<number, any[]>;

export type HomeMessageBucketQueryOptions = {
  limit?: number;
  beforeCreatedAtMs?: number;
  afterCreatedAtMs?: number;
  order?: 'asc' | 'desc';
};

const HOME_MESSAGE_BUCKET_INDEX_KEY = 'xinchat.homeMessages.bucket.index';
const HOME_MESSAGE_BUCKET_PREFIX = 'xinchat.homeMessages.bucket.';
const SQLITE_MIGRATION_FLAG_KEY = 'xinchat.homeMessages.sqlite.migrated.v1';
const SQLITE_DB_NAME = 'xinchat_home_cache.db';
const SQLITE_DB_LOCATION = 'default';
const SQLITE_TABLE_MESSAGES = 'home_message_entries';
const SQLITE_TABLE_BUCKETS = 'home_message_buckets';

const MAX_MESSAGE_ID_LENGTH = 220;
const MAX_QUERY_LIMIT = 2000;

type SqlExecutor = {
  execute: (query: string, params?: any[]) => QueryResult;
};

let dbConnection: QuickSQLiteConnection | null = null;
let dbInitInFlight: Promise<QuickSQLiteConnection | null> | null = null;
let migrationInFlight: Promise<void> | null = null;
let sqliteUnavailableLogged = false;
let sqliteRuntimeErrorLogged = false;
let cachedIndex: number[] | null = null;

const lastSavedBucketRefs = new Map<number, any[]>();

let legacyCachedIndex: number[] | null = null;
const legacyLastSavedBucketRefs = new Map<number, any[]>();

const toUid = (value: any): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 0;
  return parsed;
};

const normalizeIndex = (value: any): number[] => {
  if (!Array.isArray(value)) return [];
  const uniq = new Set<number>();
  value.forEach((item) => {
    const uid = toUid(item);
    if (uid > 0) uniq.add(uid);
  });
  return Array.from(uniq.values()).sort((a, b) => a - b);
};

const isSameIndex = (a: number[], b: number[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const normalizeTimestampMs = (value: any): number => {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.floor(direct);
  }
  const text = String(value || '').trim();
  if (!text) return 0;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
};

const getMessageCreatedAtMs = (message: any, fallbackIndex: number): number => {
  const createdAtMs =
    normalizeTimestampMs(message?.createdAtMs) ||
    normalizeTimestampMs(message?.createdAt) ||
    Date.now() + fallbackIndex;
  return createdAtMs;
};

const trimMessageId = (value: string): string => {
  const safe = String(value || '').trim();
  if (!safe) return '';
  if (safe.length <= MAX_MESSAGE_ID_LENGTH) return safe;
  return safe.slice(0, MAX_MESSAGE_ID_LENGTH);
};

const simpleHash = (value: string): string => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 2147483647;
  }
  return hash.toString(36);
};

const getMessageId = (message: any, fallbackIndex: number): string => {
  const raw = message?.id;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const direct = trimMessageId(String(raw));
    if (direct) return direct;
  }
  const createdAtMs = getMessageCreatedAtMs(message, fallbackIndex);
  const fingerprint = simpleHash(JSON.stringify(message || {}));
  return trimMessageId(`auto:${createdAtMs}:${fallbackIndex}:${fingerprint}`);
};

const sanitizeBuckets = (input: any): HomeMessageBuckets => {
  const source = input && typeof input === 'object' ? input : {};
  const next: HomeMessageBuckets = {};
  Object.entries(source).forEach(([rawUid, rawList]) => {
    const uid = toUid(rawUid);
    if (!uid || !Array.isArray(rawList)) return;
    next[uid] = rawList;
  });
  return next;
};

const sanitizeBucketList = (input: any): any[] => (Array.isArray(input) ? input : []);

const parseQueryLimit = (raw: any): number => {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_QUERY_LIMIT);
};

const parseRows = (result: QueryResult | null | undefined): any[] => {
  if (!result?.rows) return [];
  const rows = result.rows;
  if (Array.isArray(rows._array)) {
    return rows._array;
  }
  const total = Number(rows.length) || 0;
  const list: any[] = [];
  for (let i = 0; i < total; i += 1) {
    list.push(rows.item(i));
  }
  return list;
};

const parseJsonValue = <T = any>(raw: any, fallback: T): T => {
  try {
    if (typeof raw === 'string') return JSON.parse(raw) as T;
  } catch {}
  return fallback;
};

const markSqliteUnavailable = (error: any) => {
  if (sqliteUnavailableLogged) return;
  sqliteUnavailableLogged = true;
  const message = error instanceof Error ? error.message : String(error || '');
  console.warn(
    '[home-message-db] SQLite unavailable, fallback to AsyncStorage buckets:',
    message
  );
};

const markSqliteRuntimeError = (error: any) => {
  if (sqliteRuntimeErrorLogged) return;
  sqliteRuntimeErrorLogged = true;
  const message = error instanceof Error ? error.message : String(error || '');
  console.warn(
    '[home-message-db] SQLite runtime error, fallback to AsyncStorage buckets:',
    message
  );
};

const initSchema = (connection: QuickSQLiteConnection) => {
  connection.executeBatch([
    ['PRAGMA journal_mode = WAL'],
    ['PRAGMA synchronous = NORMAL'],
    [
      `CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE_MESSAGES} (
        chat_uid INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        message_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (chat_uid, message_id)
      )`,
    ],
    [
      `CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE_BUCKETS} (
        chat_uid INTEGER NOT NULL PRIMARY KEY,
        updated_at_ms INTEGER NOT NULL
      )`,
    ],
    [
      `CREATE INDEX IF NOT EXISTS idx_${SQLITE_TABLE_MESSAGES}_chat_created
       ON ${SQLITE_TABLE_MESSAGES} (chat_uid, created_at_ms ASC, message_id ASC)`,
    ],
    [
      `CREATE INDEX IF NOT EXISTS idx_${SQLITE_TABLE_MESSAGES}_updated
       ON ${SQLITE_TABLE_MESSAGES} (updated_at_ms DESC)`,
    ],
  ]);
};

const getDbConnection = async (): Promise<QuickSQLiteConnection | null> => {
  if (dbConnection) return dbConnection;
  if (dbInitInFlight) return dbInitInFlight;

  dbInitInFlight = (async () => {
    try {
      const connection = open({ name: SQLITE_DB_NAME, location: SQLITE_DB_LOCATION });
      initSchema(connection);
      sqliteUnavailableLogged = false;
      sqliteRuntimeErrorLogged = false;
      dbConnection = connection;
      return connection;
    } catch (error) {
      markSqliteUnavailable(error);
      return null;
    } finally {
      dbInitInFlight = null;
    }
  })();

  return dbInitInFlight;
};

const getLegacyBucketKey = (uid: number) => `${HOME_MESSAGE_BUCKET_PREFIX}${uid}`;

const getStoredLegacyIndex = async (): Promise<number[]> => {
  if (legacyCachedIndex) return legacyCachedIndex;
  const raw = await storage.getJson<any>(HOME_MESSAGE_BUCKET_INDEX_KEY);
  legacyCachedIndex = normalizeIndex(raw);
  return legacyCachedIndex;
};

const writeLegacyBucketsInternal = async (
  buckets: HomeMessageBuckets,
  { forceWriteAll = false, removeLegacyAggregate = false }: { forceWriteAll?: boolean; removeLegacyAggregate?: boolean } = {}
) => {
  const prevIndex = await getStoredLegacyIndex();
  const nextIndex = normalizeIndex(Object.keys(buckets).map((key) => Number(key)));
  const nextUidSet = new Set(nextIndex);

  const removeOps = prevIndex
    .filter((uid) => !nextUidSet.has(uid))
    .map(async (uid) => {
      await storage.remove(getLegacyBucketKey(uid));
      legacyLastSavedBucketRefs.delete(uid);
      lastSavedBucketRefs.delete(uid);
    });

  const saveOps = nextIndex.map(async (uid) => {
    const bucket = sanitizeBucketList(buckets[uid]);
    if (!forceWriteAll && legacyLastSavedBucketRefs.get(uid) === bucket) {
      return;
    }
    await storage.setJson(getLegacyBucketKey(uid), bucket);
    legacyLastSavedBucketRefs.set(uid, bucket);
    lastSavedBucketRefs.set(uid, bucket);
  });

  await Promise.all([...removeOps, ...saveOps]);

  if (!isSameIndex(prevIndex, nextIndex)) {
    await storage.setJson(HOME_MESSAGE_BUCKET_INDEX_KEY, nextIndex);
  }
  legacyCachedIndex = nextIndex;
  cachedIndex = nextIndex;

  if (removeLegacyAggregate) {
    await storage.remove(STORAGE_KEYS.homeMessagesCache);
  }
};

const loadLegacyBuckets = async (): Promise<HomeMessageBuckets> => {
  const index = await getStoredLegacyIndex();
  if (index.length > 0) {
    const result: HomeMessageBuckets = {};
    await Promise.all(
      index.map(async (uid) => {
        const bucket = await storage.getJson<any[]>(getLegacyBucketKey(uid));
        if (!Array.isArray(bucket)) return;
        result[uid] = bucket;
        legacyLastSavedBucketRefs.set(uid, bucket);
        lastSavedBucketRefs.set(uid, bucket);
      })
    );
    cachedIndex = index;
    return result;
  }

  const legacy = await storage.getJson<HomeMessageBuckets>(STORAGE_KEYS.homeMessagesCache);
  const migrated = sanitizeBuckets(legacy);
  const migratedUids = normalizeIndex(Object.keys(migrated).map((key) => Number(key)));
  if (migratedUids.length === 0) {
    cachedIndex = [];
    return {};
  }
  await writeLegacyBucketsInternal(migrated, { forceWriteAll: true, removeLegacyAggregate: true });
  return migrated;
};

const clearLegacyStorageAfterSqliteMigration = async (migratedBuckets: HomeMessageBuckets) => {
  const storedLegacyIndex = await getStoredLegacyIndex();
  const migratedIndex = normalizeIndex(Object.keys(migratedBuckets).map((key) => Number(key)));
  const allUids = normalizeIndex([...storedLegacyIndex, ...migratedIndex]);
  await Promise.all([
    ...allUids.map((uid) => storage.remove(getLegacyBucketKey(uid))),
    storage.remove(HOME_MESSAGE_BUCKET_INDEX_KEY),
    storage.remove(STORAGE_KEYS.homeMessagesCache),
  ]);
  legacyCachedIndex = [];
  legacyLastSavedBucketRefs.clear();
};

const getBucketIndexFromSqlite = (connection: QuickSQLiteConnection): number[] => {
  const directRows = parseRows(
    connection.execute(`SELECT chat_uid FROM ${SQLITE_TABLE_BUCKETS} ORDER BY chat_uid ASC`)
  );
  const directIndex = normalizeIndex(directRows.map((row) => Number(row?.chat_uid)));
  if (directIndex.length > 0) {
    return directIndex;
  }
  const fallbackRows = parseRows(
    connection.execute(
      `SELECT DISTINCT chat_uid FROM ${SQLITE_TABLE_MESSAGES} ORDER BY chat_uid ASC`
    )
  );
  return normalizeIndex(fallbackRows.map((row) => Number(row?.chat_uid)));
};

const getStoredIndex = async (connection: QuickSQLiteConnection): Promise<number[]> => {
  if (cachedIndex) return cachedIndex;
  cachedIndex = getBucketIndexFromSqlite(connection);
  return cachedIndex;
};

const prepareBucketRows = (bucket: any[]): Array<{
  messageId: string;
  createdAtMs: number;
  messageJson: string;
  seq: number;
}> => {
  const map = new Map<
    string,
    { messageId: string; createdAtMs: number; messageJson: string; seq: number }
  >();
  sanitizeBucketList(bucket).forEach((item, index) => {
    const messageId = getMessageId(item, index);
    const createdAtMs = getMessageCreatedAtMs(item, index);
    const messageJson = JSON.stringify(item ?? null);
    map.set(messageId, { messageId, createdAtMs, messageJson, seq: index });
  });
  const rows = Array.from(map.values());
  rows.sort((a, b) => a.createdAtMs - b.createdAtMs || a.seq - b.seq);
  return rows;
};

const deleteBucketWithExecutor = (executor: SqlExecutor, uid: number) => {
  executor.execute(`DELETE FROM ${SQLITE_TABLE_MESSAGES} WHERE chat_uid = ?`, [uid]);
  executor.execute(`DELETE FROM ${SQLITE_TABLE_BUCKETS} WHERE chat_uid = ?`, [uid]);
};

const replaceBucketWithExecutor = (
  executor: SqlExecutor,
  uid: number,
  bucket: any[],
  nowMs: number
) => {
  deleteBucketWithExecutor(executor, uid);
  const rows = prepareBucketRows(bucket);
  rows.forEach((row) => {
    executor.execute(
      `INSERT INTO ${SQLITE_TABLE_MESSAGES} (chat_uid, message_id, created_at_ms, message_json, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      [uid, row.messageId, row.createdAtMs, row.messageJson, nowMs]
    );
  });
  if (rows.length > 0) {
    executor.execute(
      `INSERT INTO ${SQLITE_TABLE_BUCKETS} (chat_uid, updated_at_ms)
       VALUES (?, ?)
       ON CONFLICT(chat_uid)
       DO UPDATE SET updated_at_ms = excluded.updated_at_ms`,
      [uid, nowMs]
    );
  }
};

const upsertBucketWithExecutor = (
  executor: SqlExecutor,
  uid: number,
  bucket: any[],
  nowMs: number
) => {
  const rows = prepareBucketRows(bucket);
  rows.forEach((row) => {
    executor.execute(
      `INSERT INTO ${SQLITE_TABLE_MESSAGES} (chat_uid, message_id, created_at_ms, message_json, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_uid, message_id)
       DO UPDATE SET
         created_at_ms = excluded.created_at_ms,
         message_json = excluded.message_json,
         updated_at_ms = excluded.updated_at_ms`,
      [uid, row.messageId, row.createdAtMs, row.messageJson, nowMs]
    );
  });
  if (rows.length > 0) {
    executor.execute(
      `INSERT INTO ${SQLITE_TABLE_BUCKETS} (chat_uid, updated_at_ms)
       VALUES (?, ?)
       ON CONFLICT(chat_uid)
       DO UPDATE SET updated_at_ms = excluded.updated_at_ms`,
      [uid, nowMs]
    );
  }
};

const queryBucketFromSqlite = (
  connection: QuickSQLiteConnection,
  uid: number,
  options: HomeMessageBucketQueryOptions = {}
): any[] => {
  const beforeCreatedAtMs = normalizeTimestampMs(options.beforeCreatedAtMs);
  const afterCreatedAtMs = normalizeTimestampMs(options.afterCreatedAtMs);
  const limit = parseQueryLimit(options.limit);
  const order = options.order === 'desc' ? 'DESC' : 'ASC';

  const params: any[] = [uid];
  const conditions = ['chat_uid = ?'];
  if (beforeCreatedAtMs > 0) {
    conditions.push('created_at_ms < ?');
    params.push(beforeCreatedAtMs);
  }
  if (afterCreatedAtMs > 0) {
    conditions.push('created_at_ms > ?');
    params.push(afterCreatedAtMs);
  }

  let sql = `SELECT message_json FROM ${SQLITE_TABLE_MESSAGES} WHERE ${conditions.join(' AND ')}`;
  sql += ` ORDER BY created_at_ms ${order}, message_id ${order}`;
  if (limit > 0) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const rows = parseRows(connection.execute(sql, params));
  return rows
    .map((row) => parseJsonValue<any>(row?.message_json, null))
    .filter((item) => item !== null);
};

const queryBucketInMemory = (
  bucket: any[],
  options: HomeMessageBucketQueryOptions = {}
): any[] => {
  const beforeCreatedAtMs = normalizeTimestampMs(options.beforeCreatedAtMs);
  const afterCreatedAtMs = normalizeTimestampMs(options.afterCreatedAtMs);
  const limit = parseQueryLimit(options.limit);
  const order: 'asc' | 'desc' = options.order === 'desc' ? 'desc' : 'asc';

  const sorted = sanitizeBucketList(bucket)
    .map((item, index) => ({
      item,
      createdAtMs: getMessageCreatedAtMs(item, index),
      orderIndex: index,
    }))
    .filter((entry) => {
      if (beforeCreatedAtMs > 0 && entry.createdAtMs >= beforeCreatedAtMs) return false;
      if (afterCreatedAtMs > 0 && entry.createdAtMs <= afterCreatedAtMs) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) {
        return order === 'asc'
          ? a.createdAtMs - b.createdAtMs
          : b.createdAtMs - a.createdAtMs;
      }
      return order === 'asc' ? a.orderIndex - b.orderIndex : b.orderIndex - a.orderIndex;
    });

  const sliced = limit > 0 ? sorted.slice(0, limit) : sorted;
  return sliced.map((entry) => entry.item);
};

const mergeBucketsIncrementally = (current: any[], incoming: any[]): any[] => {
  const map = new Map<string, { item: any; createdAtMs: number; seq: number }>();
  sanitizeBucketList(current).forEach((item, index) => {
    const messageId = getMessageId(item, index);
    map.set(messageId, {
      item,
      createdAtMs: getMessageCreatedAtMs(item, index),
      seq: index,
    });
  });
  sanitizeBucketList(incoming).forEach((item, index) => {
    const messageId = getMessageId(item, current.length + index);
    map.set(messageId, {
      item,
      createdAtMs: getMessageCreatedAtMs(item, current.length + index),
      seq: current.length + index,
    });
  });
  const merged = Array.from(map.values());
  merged.sort((a, b) => a.createdAtMs - b.createdAtMs || a.seq - b.seq);
  return merged.map((entry) => entry.item);
};

const ensureSqliteMigration = async (connection: QuickSQLiteConnection) => {
  if (migrationInFlight) {
    await migrationInFlight;
    return;
  }

  migrationInFlight = (async () => {
    const migrated = String(await storage.getString(SQLITE_MIGRATION_FLAG_KEY)).trim();
    if (migrated === '1') {
      return;
    }

    let hasSqliteRows = false;
    try {
      const countRows = parseRows(
        connection.execute(`SELECT COUNT(1) AS total FROM ${SQLITE_TABLE_MESSAGES}`)
      );
      const total = Number(countRows[0]?.total) || 0;
      hasSqliteRows = total > 0;
    } catch (error) {
      markSqliteRuntimeError(error);
    }

    const legacyBuckets = await loadLegacyBuckets();
    const legacyIndex = normalizeIndex(Object.keys(legacyBuckets).map((key) => Number(key)));

    if (!hasSqliteRows && legacyIndex.length > 0) {
      const nowMs = Date.now();
      await connection.transaction((tx) => {
        legacyIndex.forEach((uid) => {
          replaceBucketWithExecutor(tx, uid, legacyBuckets[uid], nowMs);
        });
      });
      cachedIndex = legacyIndex;
      legacyIndex.forEach((uid) => {
        const bucket = sanitizeBucketList(legacyBuckets[uid]);
        lastSavedBucketRefs.set(uid, bucket);
      });
    } else if (hasSqliteRows) {
      cachedIndex = getBucketIndexFromSqlite(connection);
    } else {
      cachedIndex = [];
    }

    await clearLegacyStorageAfterSqliteMigration(legacyBuckets);
    await storage.setString(SQLITE_MIGRATION_FLAG_KEY, '1');
  })();

  try {
    await migrationInFlight;
  } finally {
    migrationInFlight = null;
  }
};

const runWithSqlite = async <T>(
  onSqlite: (connection: QuickSQLiteConnection) => Promise<T>,
  onFallback: () => Promise<T>
): Promise<T> => {
  const connection = await getDbConnection();
  if (!connection) {
    return onFallback();
  }
  try {
    await ensureSqliteMigration(connection);
    return await onSqlite(connection);
  } catch (error) {
    markSqliteRuntimeError(error);
    return onFallback();
  }
};

export const loadHomeMessageBuckets = async (): Promise<HomeMessageBuckets> =>
  runWithSqlite(
    async (connection) => {
      const rows = parseRows(
        connection.execute(
          `SELECT chat_uid, message_json
           FROM ${SQLITE_TABLE_MESSAGES}
           ORDER BY chat_uid ASC, created_at_ms ASC, message_id ASC`
        )
      );
      const result: HomeMessageBuckets = {};
      rows.forEach((row) => {
        const uid = toUid(row?.chat_uid);
        if (!uid) return;
        const message = parseJsonValue<any>(row?.message_json, null);
        if (message === null) return;
        if (!result[uid]) {
          result[uid] = [];
        }
        result[uid].push(message);
      });
      const nextIndex = normalizeIndex(Object.keys(result).map((key) => Number(key)));
      cachedIndex = nextIndex;
      lastSavedBucketRefs.clear();
      nextIndex.forEach((uid) => {
        lastSavedBucketRefs.set(uid, result[uid]);
      });
      return result;
    },
    async () => loadLegacyBuckets()
  );

export const saveHomeMessageBuckets = async (buckets: HomeMessageBuckets): Promise<void> => {
  const sanitized = sanitizeBuckets(buckets);
  await runWithSqlite(
    async (connection) => {
      const prevIndex = await getStoredIndex(connection);
      const nextIndex = normalizeIndex(Object.keys(sanitized).map((key) => Number(key)));
      const nextUidSet = new Set(nextIndex);
      const removed = prevIndex.filter((uid) => !nextUidSet.has(uid));
      const changed = nextIndex.filter((uid) => lastSavedBucketRefs.get(uid) !== sanitized[uid]);
      if (removed.length === 0 && changed.length === 0 && isSameIndex(prevIndex, nextIndex)) {
        return;
      }
      const nowMs = Date.now();
      await connection.transaction((tx) => {
        removed.forEach((uid) => {
          deleteBucketWithExecutor(tx, uid);
        });
        changed.forEach((uid) => {
          replaceBucketWithExecutor(tx, uid, sanitized[uid], nowMs);
        });
      });
      removed.forEach((uid) => {
        lastSavedBucketRefs.delete(uid);
      });
      changed.forEach((uid) => {
        lastSavedBucketRefs.set(uid, sanitized[uid]);
      });
      cachedIndex = nextIndex;
      await storage.remove(STORAGE_KEYS.homeMessagesCache);
    },
    async () => {
      await writeLegacyBucketsInternal(sanitized, { forceWriteAll: false, removeLegacyAggregate: true });
    }
  );
};

export const removeHomeMessageBucket = async (uid: number): Promise<void> => {
  const safeUid = toUid(uid);
  if (!safeUid) return;

  await runWithSqlite(
    async (connection) => {
      const prevIndex = await getStoredIndex(connection);
      if (!prevIndex.includes(safeUid)) return;
      await connection.transaction((tx) => {
        deleteBucketWithExecutor(tx, safeUid);
      });
      cachedIndex = prevIndex.filter((item) => item !== safeUid);
      lastSavedBucketRefs.delete(safeUid);
      await storage.remove(STORAGE_KEYS.homeMessagesCache);
    },
    async () => {
      const prevIndex = await getStoredLegacyIndex();
      if (!prevIndex.includes(safeUid)) return;
      await storage.remove(getLegacyBucketKey(safeUid));
      const nextIndex = prevIndex.filter((item) => item !== safeUid);
      await storage.setJson(HOME_MESSAGE_BUCKET_INDEX_KEY, nextIndex);
      legacyCachedIndex = nextIndex;
      cachedIndex = nextIndex;
      legacyLastSavedBucketRefs.delete(safeUid);
      lastSavedBucketRefs.delete(safeUid);
    }
  );
};

export const loadHomeMessageBucket = async (
  uid: number,
  options: HomeMessageBucketQueryOptions = {}
): Promise<any[]> => {
  const safeUid = toUid(uid);
  if (!safeUid) return [];
  return runWithSqlite(
    async (connection) => queryBucketFromSqlite(connection, safeUid, options),
    async () => {
      const buckets = await loadLegacyBuckets();
      const bucket = sanitizeBucketList(buckets[safeUid]);
      return queryBucketInMemory(bucket, options);
    }
  );
};

export const upsertHomeMessageBucket = async (
  uid: number,
  messages: any[],
  { replace = false }: { replace?: boolean } = {}
): Promise<void> => {
  const safeUid = toUid(uid);
  if (!safeUid) return;
  const incoming = sanitizeBucketList(messages);

  await runWithSqlite(
    async (connection) => {
      const prevIndex = await getStoredIndex(connection);
      const nowMs = Date.now();
      await connection.transaction((tx) => {
        if (replace) {
          replaceBucketWithExecutor(tx, safeUid, incoming, nowMs);
        } else if (incoming.length > 0) {
          upsertBucketWithExecutor(tx, safeUid, incoming, nowMs);
        }
      });

      if (replace && incoming.length === 0) {
        cachedIndex = prevIndex.filter((item) => item !== safeUid);
        lastSavedBucketRefs.delete(safeUid);
        return;
      }
      const nextIndex = normalizeIndex([...prevIndex, safeUid]);
      cachedIndex = nextIndex;
      if (replace) {
        lastSavedBucketRefs.set(safeUid, incoming);
      } else {
        lastSavedBucketRefs.delete(safeUid);
      }
      await storage.remove(STORAGE_KEYS.homeMessagesCache);
    },
    async () => {
      const buckets = await loadLegacyBuckets();
      const current = sanitizeBucketList(buckets[safeUid]);
      const nextBucket = replace
        ? incoming
        : incoming.length > 0
          ? mergeBucketsIncrementally(current, incoming)
          : current;
      const next: HomeMessageBuckets = { ...buckets };
      if (nextBucket.length > 0) {
        next[safeUid] = nextBucket;
      } else {
        delete next[safeUid];
      }
      await writeLegacyBucketsInternal(next, { forceWriteAll: false, removeLegacyAggregate: true });
    }
  );
};
