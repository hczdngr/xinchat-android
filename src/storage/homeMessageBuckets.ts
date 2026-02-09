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

let cachedIndex: number[] | null = null;
const lastSavedBucketRefs = new Map<number, any[]>();

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

const getBucketKey = (uid: number) => `${HOME_MESSAGE_BUCKET_PREFIX}${uid}`;

const getStoredIndex = async (): Promise<number[]> => {
  if (cachedIndex) return cachedIndex;
  const raw = await storage.getJson<any>(HOME_MESSAGE_BUCKET_INDEX_KEY);
  cachedIndex = normalizeIndex(raw);
  return cachedIndex;
};

const parseQueryLimit = (raw: any): number => {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, 2000);
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

const getMessageCreatedAtMs = (message: any, fallbackIndex: number): number =>
  normalizeTimestampMs(message?.createdAtMs) ||
  normalizeTimestampMs(message?.createdAt) ||
  Date.now() + fallbackIndex;

const trimMessageId = (value: string): string => {
  const safe = String(value || '').trim();
  if (!safe) return '';
  return safe.length > 220 ? safe.slice(0, 220) : safe;
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
  return trimMessageId(`auto:${createdAtMs}:${fallbackIndex}:${simpleHash(JSON.stringify(message || {}))}`);
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

const queryBucketInMemory = (
  bucket: any[],
  options: HomeMessageBucketQueryOptions = {}
): any[] => {
  const beforeCreatedAtMs = normalizeTimestampMs(options.beforeCreatedAtMs);
  const afterCreatedAtMs = normalizeTimestampMs(options.afterCreatedAtMs);
  const limit = parseQueryLimit(options.limit);
  const order: 'asc' | 'desc' = options.order === 'desc' ? 'desc' : 'asc';

  const sorted = (Array.isArray(bucket) ? bucket : [])
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
  (Array.isArray(current) ? current : []).forEach((item, index) => {
    const messageId = getMessageId(item, index);
    map.set(messageId, {
      item,
      createdAtMs: getMessageCreatedAtMs(item, index),
      seq: index,
    });
  });
  (Array.isArray(incoming) ? incoming : []).forEach((item, index) => {
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

const writeBucketsInternal = async (
  buckets: HomeMessageBuckets,
  { forceWriteAll = false, removeLegacy = false }: { forceWriteAll?: boolean; removeLegacy?: boolean } = {}
) => {
  const prevIndex = await getStoredIndex();
  const nextIndex = normalizeIndex(Object.keys(buckets).map((key) => Number(key)));
  const nextUidSet = new Set(nextIndex);

  const removeOps = prevIndex
    .filter((uid) => !nextUidSet.has(uid))
    .map(async (uid) => {
      await storage.remove(getBucketKey(uid));
      lastSavedBucketRefs.delete(uid);
    });

  const saveOps = nextIndex.map(async (uid) => {
    const bucket = Array.isArray(buckets[uid]) ? buckets[uid] : [];
    if (!forceWriteAll && lastSavedBucketRefs.get(uid) === bucket) {
      return;
    }
    await storage.setJson(getBucketKey(uid), bucket);
    lastSavedBucketRefs.set(uid, bucket);
  });

  await Promise.all([...removeOps, ...saveOps]);

  if (!isSameIndex(prevIndex, nextIndex)) {
    await storage.setJson(HOME_MESSAGE_BUCKET_INDEX_KEY, nextIndex);
  }
  cachedIndex = nextIndex;

  if (removeLegacy) {
    await storage.remove(STORAGE_KEYS.homeMessagesCache);
  }
};

export const loadHomeMessageBuckets = async (): Promise<HomeMessageBuckets> => {
  const index = await getStoredIndex();
  if (index.length > 0) {
    const result: HomeMessageBuckets = {};
    await Promise.all(
      index.map(async (uid) => {
        const bucket = await storage.getJson<any[]>(getBucketKey(uid));
        if (!Array.isArray(bucket)) return;
        result[uid] = bucket;
        lastSavedBucketRefs.set(uid, bucket);
      })
    );
    return result;
  }

  const legacy = await storage.getJson<HomeMessageBuckets>(STORAGE_KEYS.homeMessagesCache);
  const migrated = sanitizeBuckets(legacy);
  const migratedUids = normalizeIndex(Object.keys(migrated).map((key) => Number(key)));
  if (migratedUids.length === 0) {
    return {};
  }
  await writeBucketsInternal(migrated, { forceWriteAll: true, removeLegacy: true });
  return migrated;
};

export const saveHomeMessageBuckets = async (buckets: HomeMessageBuckets): Promise<void> => {
  const sanitized = sanitizeBuckets(buckets);
  await writeBucketsInternal(sanitized, { forceWriteAll: false, removeLegacy: true });
};

export const removeHomeMessageBucket = async (uid: number): Promise<void> => {
  const safeUid = toUid(uid);
  if (!safeUid) return;
  const prevIndex = await getStoredIndex();
  if (!prevIndex.includes(safeUid)) return;
  await storage.remove(getBucketKey(safeUid));
  const nextIndex = prevIndex.filter((item) => item !== safeUid);
  await storage.setJson(HOME_MESSAGE_BUCKET_INDEX_KEY, nextIndex);
  cachedIndex = nextIndex;
  lastSavedBucketRefs.delete(safeUid);
};

export const loadHomeMessageBucket = async (
  uid: number,
  options: HomeMessageBucketQueryOptions = {}
): Promise<any[]> => {
  const safeUid = toUid(uid);
  if (!safeUid) return [];
  const buckets = await loadHomeMessageBuckets();
  const bucket = Array.isArray(buckets[safeUid]) ? buckets[safeUid] : [];
  return queryBucketInMemory(bucket, options);
};

export const upsertHomeMessageBucket = async (
  uid: number,
  messages: any[],
  { replace = false }: { replace?: boolean } = {}
): Promise<void> => {
  const safeUid = toUid(uid);
  if (!safeUid) return;
  const incoming = Array.isArray(messages) ? messages : [];
  const buckets = await loadHomeMessageBuckets();
  const current = Array.isArray(buckets[safeUid]) ? buckets[safeUid] : [];
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
  await saveHomeMessageBuckets(next);
};
