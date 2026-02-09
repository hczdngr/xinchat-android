import { normalizeObjectDetectPayload } from '../src/utils/objectDetectNormalize';

describe('normalizeObjectDetectPayload confidence', () => {
  test('keeps 0-1 values', () => {
    const result = normalizeObjectDetectPayload({
      objects: [{ name: 'cat', confidence: 0.83 }],
    });
    expect(result.objects?.[0]?.confidence).toBeCloseTo(0.83, 6);
  });

  test('normalizes 0-100 numeric values to 0-1', () => {
    const result = normalizeObjectDetectPayload({
      objects: [{ name: 'dog', confidence: 86 }],
    });
    expect(result.objects?.[0]?.confidence).toBeCloseTo(0.86, 6);
  });

  test('parses percent string values', () => {
    const result = normalizeObjectDetectPayload({
      objects: [
        { name: 'tree', confidence: '85%' },
        { name: 'car', confidence: '72.5％' },
      ],
    });
    expect(result.objects?.[0]?.confidence).toBeCloseTo(0.85, 6);
    expect(result.objects?.[1]?.confidence).toBeCloseTo(0.725, 6);
  });

  test('clamps invalid and out-of-range values', () => {
    const result = normalizeObjectDetectPayload({
      objects: [
        { name: 'book', confidence: 'not-a-number' },
        { name: 'phone', confidence: -10 },
        { name: 'cup', confidence: 999 },
      ],
    });
    expect(result.objects?.[0]?.confidence).toBe(0);
    expect(result.objects?.[1]?.confidence).toBe(0);
    expect(result.objects?.[2]?.confidence).toBe(1);
  });
});

