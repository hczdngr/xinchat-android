import { request } from '@umijs/max';

export type ApiEnvelope<T> = {
  success: boolean;
  data: T;
  message?: string;
  errorMessage?: string;
};

export type PagedResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  [key: string]: unknown;
};

export type AdminPrincipal = {
  source?: string;
  id: number;
  username: string;
  displayName: string;
  role: string;
  lastLoginAt?: string;
};

export type AdminLoginPayload = {
  username: string;
  password: string;
};

export type AdminLoginResult = {
  token: string;
  tokenExpiresAt?: string;
  admin: AdminPrincipal;
};

export type UsersSummary = {
  total: number;
  active: number;
  blocked: number;
  deleted: number;
  online: number;
  tokens: number;
};

export type UserStatus = 'active' | 'blocked' | 'deleted';

export type UserSummaryItem = {
  uid: number;
  username: string;
  nickname: string;
  signature: string;
  avatar?: string;
  domain: string;
  online: boolean;
  blocked: boolean;
  deletedAt?: string;
  status: UserStatus;
  tokenCount: number;
  friendsCount: number;
  createdAt?: string;
  lastLoginAt?: string;
};

export type UserDetail = UserSummaryItem & {
  gender?: string;
  birthday?: string;
  country?: string;
  province?: string;
  region?: string;
  friendRequests?: {
    incoming: number;
    outgoing: number;
  };
  aiProfileUpdatedAt?: string;
  assistantProfile?: {
    translateStyle: string;
    explanationLevel: string;
    replyStyle: string;
  };
  aiProfile?: {
    updatedAt?: string;
    profileSummary?: string;
    personalityTraits?: string[];
    preferences?: string[];
    riskSignals?: string[];
    depressionTendency?: {
      level?: string;
      score?: number | null;
      reason?: string;
      riskSignals?: string[];
    };
    raw?: Record<string, unknown>;
  };
  depressionRating?: {
    level?: string;
    score?: number | null;
    reason?: string;
    riskSignals?: string[];
  };
  recoPersona?: {
    uid: number;
    updatedAt?: string;
    interactions?: {
      total: number;
      positive: number;
      negative: number;
    };
    personalizedTags?: string[];
    topTags?: Array<{
      name: string;
      weight: number;
      polarity: 'positive' | 'negative';
    }>;
    targetTypeWeights?: {
      private: number;
      group: number;
    };
    hourWeights?: Record<string, number>;
    metadata?: Record<string, unknown>;
  } | null;
};

export type UserBatchAction =
  | 'activate'
  | 'block'
  | 'soft-delete'
  | 'restore'
  | 'revoke-sessions';

export type ProductStatus = 'active' | 'inactive' | 'draft' | 'archived';

export type ProductItem = {
  id: number;
  name: string;
  sku: string;
  category: string;
  description?: string;
  status: ProductStatus;
  tags?: string[];
  price: number;
  cost: number;
  stock: number;
  sales: number;
  createdAt?: string;
  updatedAt?: string;
};

export type ProductsSummary = {
  total: number;
  active: number;
  inactive: number;
  draft: number;
  archived: number;
  lowStock: number;
  totalStock: number;
  totalSales: number;
  inventoryValue: number;
  grossRevenue: number;
  lowStockThreshold: number;
};

export type MessageReviewStatus = 'unreviewed' | 'approved' | 'flagged' | 'blocked' | 'deleted';
export type RiskLevel = 'low' | 'medium' | 'high';

export type MessageReviewRecord = {
  messageId: string;
  status: Exclude<MessageReviewStatus, 'unreviewed'>;
  riskLevel: RiskLevel;
  reason?: string;
  tags?: string[];
  reviewer?: string;
  reviewedAt?: string;
  history?: Array<{
    status: Exclude<MessageReviewStatus, 'unreviewed'>;
    riskLevel: RiskLevel;
    reason?: string;
    tags?: string[];
    reviewer?: string;
    reviewedAt?: string;
  }>;
};

export type MessageItem = {
  id: string;
  type: string;
  senderUid: number;
  targetUid: number;
  targetType: string;
  data: Record<string, unknown>;
  createdAt: string;
  createdAtMs: number;
  preview: string;
  reviewStatus?: MessageReviewStatus;
  riskLevel?: RiskLevel;
  review?: MessageReviewRecord;
  inspection?: {
    textSample?: string;
    autoRiskLevel?: RiskLevel;
    hitRules?: Array<{
      id: string;
      label: string;
      risk: RiskLevel;
      tags?: string[];
    }>;
  };
};

export type MessagesSummary = {
  generatedAt: string;
  messages: {
    total: number;
    inWindow: number;
    windowHours: number;
    sinceAt: string;
    byType: Record<string, number>;
    byTargetType: Record<string, number>;
  };
  reviews?: {
    totalReviewed: number;
    byStatus: Record<string, number>;
    byRisk: Record<string, number>;
  };
};

export type RiskOverview = {
  generatedAt: string;
  counts: {
    decisions: number;
    appeals: number;
    ignored: number;
    byLevel: Record<string, number>;
    byChannel: Record<string, number>;
    byTag: Record<string, number>;
  };
  recentDecisions: Array<Record<string, unknown>>;
  recentAppeals: Array<Record<string, unknown>>;
};

export type SocialOverview = {
  generatedAt: string;
  totals: {
    users: number;
    groups: number;
    mutualFriendEdges: number;
    oneWayFriendEdges: number;
    isolatedUsers: number;
    noSocialUsers: number;
    usersWithGroup: number;
    groupMemberships: number;
  };
  metrics: {
    avgFriendCount: number;
    medianFriendCount: number;
    avgGroupSize: number;
    connectedComponents: number;
    largestComponentSize: number;
  };
  topUsers: Array<{
    uid: number;
    username: string;
    nickname: string;
    friendCount: number;
  }>;
  topGroups: Array<{
    id: number;
    name: string;
    memberCount: number;
  }>;
  componentSizes: number[];
};

export type SocialTreeNode = {
  id: string;
  type: 'user' | 'group';
  level: number;
  label: string;
  uid?: number;
  gid?: number;
  friendCount?: number;
  memberCount?: number;
  online?: boolean;
};

export type SocialTreeEdge = {
  id: string;
  type: 'friend' | 'group_member';
  from: string;
  to: string;
};

export type SocialTree = {
  generatedAt: string;
  rootUid: number;
  depth: number;
  includeGroups: boolean;
  summary: {
    nodes: number;
    edges: number;
    userNodes: number;
    groupNodes: number;
    levelSummary: Record<string, number>;
    truncated: boolean;
  };
  nodes: SocialTreeNode[];
  edges: SocialTreeEdge[];
};

export type AdminMetricsSnapshot = {
  now: string;
  startedAt: string;
  uptimeMs: number;
  process: {
    pid: number;
    node: string;
    platform: string;
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
  };
  ws: {
    activeSockets: number;
    activeUsers: number;
    cleanupRuns: number;
    prunedConnections: number;
  };
  metrics: {
    counters: Array<{
      name: string;
      labels?: Record<string, string>;
      value: number;
      updatedAt?: string;
    }>;
    gauges: Array<{
      name: string;
      labels?: Record<string, string>;
      value: number;
      updatedAt?: string;
    }>;
  };
};

export type BottlenecksSnapshot = {
  generatedAt: string;
  slowEndpoints: Array<{ key: string; avgMs: number; p95Ms?: number }>;
  errorEndpoints: Array<{ key: string; errors: number }>;
  memory?: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    heapUsageRatio: number;
  };
  ws?: {
    backpressureDisconnects: number;
    messageErrors: number;
  };
  recommendations: string[];
};

export type FeatureFlagsSnapshot = {
  generatedAt: string;
  flags: Record<string, boolean>;
  runtime?: {
    path?: string;
    updatedAt?: string;
    updatedBy?: string;
    overrides?: Record<string, boolean>;
  };
  definitions: Array<{
    name: string;
    env: string;
    defaultValue: boolean;
    envEnabled?: boolean;
    override?: boolean | null;
    enabled: boolean;
    source?: string;
  }>;
};

export type RecoAdminOverview = {
  generatedAt: string;
  flags: {
    recoVw: boolean;
    recoVwShadow: boolean;
    recoVwOnline: boolean;
  };
  config: Record<string, unknown>;
  configStore?: Record<string, unknown>;
  vwStatus?: Record<string, unknown>;
  counts: {
    decisions: number;
    feedbacks: number;
    users: number;
    byMode: Record<string, number>;
    byProvider: Record<string, number>;
  };
  online: {
    impressions: number;
    feedbackTotal: number;
    byAction: Record<string, number>;
    ctr: number;
    replyRate: number;
    reportRate: number;
  };
  offline: {
    samples: number;
    avgReward: number;
    ips: number;
    dr: number;
  };
  runtime?: Record<string, unknown>;
  store?: Record<string, unknown>;
  recentDecisions: Array<Record<string, unknown>>;
  recentFeedbacks: Array<Record<string, unknown>>;
  userProfiles: Array<Record<string, unknown>>;
};

export type Phase5Overview = {
  generatedAt: string;
  featureEnabled: {
    recoVw: boolean;
    recoVwShadow: boolean;
    recoVwOnline: boolean;
  };
  requestVolume: {
    recoDecision: number;
    recoFeedback: number;
    recoAdmin: number;
    chatOverview: number;
  };
  responses: {
    recoDecision: { total: number; byStatus: Record<string, number> };
    recoFeedback: { total: number; byStatus: Record<string, number> };
    recoAdmin: { total: number; byStatus: Record<string, number> };
    chatOverview: { total: number; byStatus: Record<string, number> };
  };
  reco: RecoAdminOverview;
};

export type EventSummary = {
  generatedAt: string;
  logger: Record<string, unknown>;
};

export type Phase1Overview = {
  generatedAt: string;
  featureEnabled: {
    replyAssistant: boolean;
    translatePersonalization: boolean;
  };
  users: {
    total: number;
    customizedUsers: number;
    defaultUsers: number;
    byReplyStyle: Record<string, number>;
    byTranslateStyle: Record<string, number>;
    byExplanationLevel: Record<string, number>;
  };
  requestVolume: {
    replySuggest: number;
    chatSend: number;
    translate: number;
    translateProfileWrite: number;
  };
  responses: {
    replySuggest: {
      total: number;
      byStatus: Record<string, number>;
    };
    translate: {
      total: number;
      byStatus: Record<string, number>;
    };
    translateProfile: {
      total: number;
      byStatus: Record<string, number>;
    };
  };
  topTags: Array<{
    name: string;
    count: number;
  }>;
  samples: Array<{
    uid: number;
    username: string;
    nickname: string;
    profile: {
      translateStyle: string;
      explanationLevel: string;
      replyStyle: string;
    };
  }>;
};

export type Phase4Overview = {
  generatedAt: string;
  featureEnabled: {
    summaryCenter: boolean;
  };
  requestVolume: {
    summaryRead: number;
    summaryRefresh: number;
    summaryArchive: number;
    chatOverview: number;
  };
  responses: {
    summaryRead: { total: number; byStatus: Record<string, number> };
    summaryRefresh: { total: number; byStatus: Record<string, number> };
    summaryArchive: { total: number; byStatus: Record<string, number> };
    chatOverview: { total: number; byStatus: Record<string, number> };
  };
  summary: {
    generatedAt: string;
    featureEnabled: boolean;
    totals: {
      users: number;
      usersWithLatest: number;
      unreadLatest: number;
      historyRecords: number;
    };
    runtime: {
      running: boolean;
      lastRunAtMs: number;
      lastRunAt: string;
      lastDurationMs: number;
      lastReason: string;
      lastError: string;
      lastSkippedReason: string;
      totalRuns: number;
      totalGenerated: number;
      totalErrors: number;
      totalPushes: number;
      totalPushErrors: number;
      totalSlowQueries?: number;
      totalSlowUsers?: number;
      totalSlowBatches?: number;
      slowQueries?: Array<{
        scope: string;
        uid: number;
        rows: number;
        tookMs: number;
        at: string;
      }>;
      slowUsers?: Array<{
        uid: number;
        source: string;
        mode: string;
        scannedRows: number;
        tookMs: number;
        at: string;
      }>;
      slowBatches?: Array<{
        reason: string;
        tookMs: number;
        generated: number;
        candidates: number;
        at: string;
      }>;
      autoIntervalMs: number;
      autoMaxUsers: number;
      fullRebuildIntervalMs?: number;
      cachedUsers?: number;
      slowThresholds?: {
        queryMs: number;
        userGenerateMs: number;
        batchMs: number;
      };
      storeLoaded: boolean;
    };
    topUsers: Array<{
      uid: number;
      unreadTotal: number;
      unreadConversations: number;
      todoCount: number;
      latestGeneratedAt: string;
      generatedTotal: number;
      manualRefreshTotal: number;
      archivedTotal: number;
      lastError: string;
    }>;
  };
};

export type AdminRelationshipOpsSnapshot = {
  enabled: boolean;
  available: boolean;
  selectedUid: number;
  selector: {
    selectedUid: number;
    users: Array<{
      uid: number;
      username: string;
      nickname: string;
      friendsCount: number;
      groupsCount: number;
    }>;
  };
  generatedAt: string;
  scope: 'all' | 'private' | 'group';
  windowDays: 7 | 30;
  summary: {
    totalCandidates: number;
    totalDeclined: number;
    inactive7d: number;
    privateCount: number;
    groupCount: number;
  };
  items: Array<{
    targetUid: number;
    targetType: 'private' | 'group';
    title: string;
    avatar?: string;
    memberCount?: number;
    score: number;
    lastInteractionAt: string;
    lastInteractionMs: number;
    metrics: {
      recent7d: number;
      prev7d: number;
      recent30d: number;
      prev30d: number;
      decline7d: number;
      decline30d: number;
      declineRate7d: number;
      declineRate30d: number;
      direction7d: 'up' | 'down' | 'flat';
      direction30d: 'up' | 'down' | 'flat';
    };
    recommendation: {
      action: string;
      label: string;
      reason: string;
    };
    tags: string[];
  }>;
};

export const adminLogin = (body: AdminLoginPayload) =>
  request<ApiEnvelope<AdminLoginResult>>('/api/admin/auth/login', {
    method: 'POST',
    data: body,
  });

export const adminMe = () =>
  request<ApiEnvelope<AdminPrincipal>>('/api/admin/auth/me', {
    method: 'GET',
  });

export const adminLogout = () =>
  request<ApiEnvelope<{ revoked?: boolean }>>('/api/admin/auth/logout', {
    method: 'POST',
  });

export const fetchAdminMetrics = () =>
  request<ApiEnvelope<AdminMetricsSnapshot>>('/api/admin/metrics', {
    method: 'GET',
  });

export const fetchBottlenecks = () =>
  request<ApiEnvelope<BottlenecksSnapshot>>('/api/admin/bottlenecks', {
    method: 'GET',
  });

export const fetchFeatureFlags = () =>
  request<ApiEnvelope<FeatureFlagsSnapshot>>('/api/admin/feature-flags', {
    method: 'GET',
  });

export const updateFeatureFlag = (payload: {
  name?: string;
  enabled?: boolean | null;
  clearOverride?: boolean;
  changes?: Record<string, boolean | null>;
}) =>
  request<
    ApiEnvelope<{
      updated?: Array<{ name: string; enabled: boolean; override: boolean | null }>;
      flags: Record<string, boolean>;
      definitions: FeatureFlagsSnapshot['definitions'];
      runtime?: FeatureFlagsSnapshot['runtime'];
    }>
  >('/api/admin/feature-flags/update', {
    method: 'POST',
    data: payload,
  });

export const fetchEventsSummary = () =>
  request<ApiEnvelope<EventSummary>>('/api/admin/events/summary', {
    method: 'GET',
  });

export const fetchPhase1Overview = () =>
  request<ApiEnvelope<Phase1Overview>>('/api/admin/phase1/overview', {
    method: 'GET',
  });

export const fetchPhase4Overview = () =>
  request<ApiEnvelope<Phase4Overview>>('/api/admin/phase4/overview', {
    method: 'GET',
  });

export const fetchPhase5Overview = () =>
  request<ApiEnvelope<Phase5Overview>>('/api/admin/phase5/overview', {
    method: 'GET',
  });

export const fetchRecoOverview = (params?: { limit?: number; windowHours?: number }) =>
  request<ApiEnvelope<RecoAdminOverview>>('/api/admin/reco/overview', {
    method: 'GET',
    params,
  });

export const updateRecoConfig = (payload: Record<string, unknown>) =>
  request<ApiEnvelope<{ config: Record<string, unknown>; vwStatus?: Record<string, unknown> }>>(
    '/api/admin/reco/config',
    {
      method: 'POST',
      data: payload,
    },
  );

export const fetchUsersSummary = () =>
  request<ApiEnvelope<UsersSummary>>('/api/admin/users/summary', {
    method: 'GET',
  });

export const fetchUsers = (params: {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: string;
}) =>
  request<ApiEnvelope<PagedResult<UserSummaryItem>>>('/api/admin/users', {
    method: 'GET',
    params,
  });

export const fetchUserDetail = (uid: number) =>
  request<ApiEnvelope<UserDetail>>('/api/admin/users/detail', {
    method: 'GET',
    params: { uid },
  });

export const updateUser = (payload: Record<string, unknown>) =>
  request<ApiEnvelope<UserSummaryItem>>('/api/admin/users/update', {
    method: 'POST',
    data: payload,
  });

export const revokeAllUserSessions = (uid: number) =>
  request<ApiEnvelope<{ uid: number; revokedCount: number; user: UserSummaryItem }>>(
    '/api/admin/users/revoke-all',
    {
      method: 'POST',
      data: { uid },
    },
  );

export const softDeleteUser = (uid: number, restore = false) =>
  request<ApiEnvelope<UserSummaryItem>>('/api/admin/users/soft-delete', {
    method: 'POST',
    data: { uid, restore },
  });

export const batchUsersAction = (action: UserBatchAction, uids: number[]) =>
  request<
    ApiEnvelope<{
      action: string;
      requested: number;
      changed: number;
      updated: Array<{ uid: number; changed: boolean; status: UserStatus }>;
      skipped: number[];
    }>
  >('/api/admin/users/batch-action', {
    method: 'POST',
    data: { action, uids },
  });

export const fetchSocialOverview = () =>
  request<ApiEnvelope<SocialOverview>>('/api/admin/social/overview', {
    method: 'GET',
  });

export const fetchSocialTree = (params: {
  uid: number;
  depth?: number;
  includeGroups?: boolean;
}) =>
  request<ApiEnvelope<SocialTree>>('/api/admin/social/tree', {
    method: 'GET',
    params,
  });

export const fetchAdminRelationshipOps = (params: {
  uid?: number;
  scope?: 'all' | 'private' | 'group';
  windowDays?: 7 | 30;
  limit?: number;
  includeStable?: boolean;
}) =>
  request<ApiEnvelope<AdminRelationshipOpsSnapshot>>('/api/admin/ops/relationship', {
    method: 'GET',
    params,
  });

export const fetchMessagesSummary = (windowHours = 24) =>
  request<ApiEnvelope<MessagesSummary>>('/api/admin/messages/summary', {
    method: 'GET',
    params: { windowHours },
  });

export const fetchMessages = (params: {
  page?: number;
  pageSize?: number;
  q?: string;
  type?: string;
  targetType?: string;
  senderUid?: number;
  targetUid?: number;
  reviewStatus?: string;
  riskLevel?: string;
  sort?: 'asc' | 'desc';
}) =>
  request<ApiEnvelope<PagedResult<MessageItem>>>('/api/admin/messages/search', {
    method: 'GET',
    params,
  });

export const fetchMessageDetail = (id: string) =>
  request<ApiEnvelope<MessageItem>>('/api/admin/messages/detail', {
    method: 'GET',
    params: { id },
  });

export const reviewMessage = (payload: {
  id: string;
  status: Exclude<MessageReviewStatus, 'unreviewed'>;
  riskLevel?: RiskLevel;
  reason?: string;
  tags?: string[];
  reviewer?: string;
}) =>
  request<ApiEnvelope<{ review: MessageReviewRecord; message: MessageItem }>>(
    '/api/admin/messages/review',
    {
      method: 'POST',
      data: payload,
    },
  );

export const deleteMessageAsAdmin = (payload: {
  id: string;
  reason?: string;
  reviewer?: string;
  tags?: string[];
}) =>
  request<ApiEnvelope<{ deleted: MessageItem; review: MessageReviewRecord }>>(
    '/api/admin/messages/delete',
    {
      method: 'POST',
      data: payload,
    },
  );

export const fetchRiskOverview = (limit = 120) =>
  request<ApiEnvelope<RiskOverview>>('/api/admin/risk/overview', {
    method: 'GET',
    params: { limit },
  });

export const fetchProductsSummary = (lowStockThreshold = 10) =>
  request<ApiEnvelope<ProductsSummary>>('/api/admin/products/summary', {
    method: 'GET',
    params: { lowStockThreshold },
  });

export const fetchProducts = (params: {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: string;
}) =>
  request<ApiEnvelope<PagedResult<ProductItem>>>('/api/admin/products', {
    method: 'GET',
    params,
  });

export const createProduct = (payload: Record<string, unknown>) =>
  request<ApiEnvelope<ProductItem>>('/api/admin/products/create', {
    method: 'POST',
    data: payload,
  });

export const updateProduct = (payload: Record<string, unknown>) =>
  request<ApiEnvelope<ProductItem>>('/api/admin/products/update', {
    method: 'POST',
    data: payload,
  });

export const deleteProduct = (id: number) =>
  request<ApiEnvelope<ProductItem>>('/api/admin/products/delete', {
    method: 'DELETE',
    data: { id },
  });
