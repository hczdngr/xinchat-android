export type ObjectDetectItem = {
  name?: string;
  confidence?: number;
  attributes?: string;
  position?: string;
};

export type ObjectDetectPayload = {
  summary?: string;
  scene?: string;
  objects?: ObjectDetectItem[];
  model?: string;
};

const toText = (value: unknown, max = 400) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

const normalizeConfidenceValue = (raw: number) => {
  if (!Number.isFinite(raw)) return 0;
  let next = raw;
  // Model may return 0-100 even when asked for 0-1.
  if (next > 1 && next <= 100) {
    next /= 100;
  }
  if (next < 0) return 0;
  if (next > 1) return 1;
  return next;
};

const toConfidence = (value: unknown) => {
  if (typeof value === 'number') {
    return normalizeConfidenceValue(value);
  }
  const text = String(value ?? '').trim();
  if (!text) return 0;

  const normalized = text.replace(/％/g, '%').replace(/,/g, '.');
  const hasPercent = normalized.includes('%');
  const matched = normalized.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i);
  if (!matched) return 0;

  const parsed = Number(matched[0]);
  if (!Number.isFinite(parsed)) return 0;
  const raw = hasPercent ? parsed / 100 : parsed;
  return normalizeConfidenceValue(raw);
};

const extractBalancedObject = (text: string) => {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth <= 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return '';
};

const parseJsonLikeObject = (value: unknown): Record<string, unknown> | null => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const noFence = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const tryParse = (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const direct = tryParse(noFence);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  if (typeof direct === 'string') {
    const nested = tryParse(direct);
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }

  const balanced = extractBalancedObject(noFence);
  if (balanced) {
    const parsed = tryParse(balanced);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return null;
};

const normalizeObjects = (value: unknown): ObjectDetectItem[] => {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => ({
      name: toText((item as any)?.name || (item as any)?.label, 80),
      confidence: toConfidence((item as any)?.confidence),
      attributes: toText((item as any)?.attributes || (item as any)?.description, 220),
      position: toText((item as any)?.position, 120),
    }))
    .filter((item) => item.name)
    .slice(0, 8);
};

export const normalizeObjectDetectPayload = (value: unknown): ObjectDetectPayload => {
  const base =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : parseJsonLikeObject(value) || {};

  let summary = toText(base.summary, 400);
  let scene = toText(base.scene, 120);
  let objects = normalizeObjects(base.objects);
  const model = toText(base.model, 80);

  if ((summary.startsWith('{') || summary.startsWith('```')) && (!scene || objects.length === 0)) {
    const nested = parseJsonLikeObject(summary);
    if (nested) {
      summary = toText((nested as any).summary || summary, 400);
      scene = scene || toText((nested as any).scene, 120);
      if (objects.length === 0) {
        objects = normalizeObjects((nested as any).objects);
      }
    }
  }

  return {
    summary,
    scene,
    objects,
    model,
  };
};

