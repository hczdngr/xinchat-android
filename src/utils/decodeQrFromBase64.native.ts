import { Buffer } from 'buffer';
import { decode as decodePng } from 'fast-png';
import jpeg from 'jpeg-js';
import jsQR from 'jsqr';

type Pixels = {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
};

type RotationAngle = 0 | 90 | -90 | 180;
type InversionMode = 'dontInvert' | 'attemptBoth';
type QrDecodeMode = 'realtime' | 'album';
type DecodeStep = {
  maxSide: number;
  scales: readonly number[];
  angles: readonly RotationAngle[];
  inversion: InversionMode;
};

const FAST_MAX_SIDE = 900;
const DEEP_MAX_SIDE = 1400;

const REALTIME_STEPS: readonly DecodeStep[] = [
  {
    maxSide: FAST_MAX_SIDE,
    scales: [1, 0.78],
    angles: [0, 90, -90],
    inversion: 'dontInvert',
  },
  {
    maxSide: FAST_MAX_SIDE,
    scales: [1, 0.74, 0.58],
    angles: [0, 90, -90, 180],
    inversion: 'attemptBoth',
  },
];

const ALBUM_STEPS: readonly DecodeStep[] = [
  {
    maxSide: FAST_MAX_SIDE,
    scales: [1, 0.82, 0.66],
    angles: [0, 90, -90],
    inversion: 'attemptBoth',
  },
  {
    maxSide: DEEP_MAX_SIDE,
    scales: [1, 0.88, 0.72, 0.56],
    angles: [0, 90, -90, 180],
    inversion: 'attemptBoth',
  },
];

export function decodeQrFromBase64(
  base64: string,
  mime = '',
  mode: QrDecodeMode = 'album'
): string {
  const trimmed = String(base64 || '').trim();
  if (!trimmed) return '';

  const bytes = Uint8Array.from(Buffer.from(trimmed, 'base64'));
  if (!bytes.length) return '';

  const decoded = decodePixels(bytes, mime);
  if (!decoded) return '';

  const steps = mode === 'realtime' ? REALTIME_STEPS : ALBUM_STEPS;
  return tryDecodeWithPipeline(decoded, steps);
}

function decodePixels(bytes: Uint8Array, mime: string): Pixels | null {
  const lowerMime = mime.toLowerCase();
  const isPng = lowerMime.includes('png') || isPngSignature(bytes);

  if (isPng) {
    try {
      const png = decodePng(bytes);
      const pngData = Uint8ClampedArray.from(png.data as ArrayLike<number>);
      return {
        data: pngData,
        width: png.width,
        height: png.height,
      };
    } catch {
      return null;
    }
  }

  try {
    const jpegData = jpeg.decode(bytes, { useTArray: true });
    return {
      data: jpegData.data,
      width: jpegData.width,
      height: jpegData.height,
    };
  } catch {
    return null;
  }
}

function tryDecodeWithPipeline(source: Pixels, steps: readonly DecodeStep[]): string {
  for (const step of steps) {
    const normalized = normalizeMaxSide(source, step.maxSide);
    for (const scale of step.scales) {
      const resized = scale === 1 ? normalized : resizePixels(normalized, scale);
      for (const angle of step.angles) {
        const oriented = angle === 0 ? resized : rotatePixels(resized, angle);
        const clamped = toClamped(oriented.data);
        const code = jsQR(clamped, oriented.width, oriented.height, {
          inversionAttempts: step.inversion,
        });
        if (code?.data) {
          return String(code.data).trim();
        }
      }
    }
  }
  return '';
}

function normalizeMaxSide(source: Pixels, maxSide: number): Pixels {
  const sourceMax = Math.max(source.width, source.height);
  if (sourceMax <= maxSide) return source;
  const scale = maxSide / sourceMax;
  return resizePixels(source, scale);
}

function resizePixels(source: Pixels, scale: number): Pixels {
  const targetWidth = Math.max(1, Math.round(source.width * scale));
  const targetHeight = Math.max(1, Math.round(source.height * scale));
  const src = source.data;
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4);

  for (let y = 0; y < targetHeight; y += 1) {
    const sy = Math.min(source.height - 1, Math.floor((y * source.height) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor((x * source.width) / targetWidth));
      const srcIndex = (sy * source.width + sx) * 4;
      const dstIndex = (y * targetWidth + x) * 4;
      output[dstIndex] = src[srcIndex];
      output[dstIndex + 1] = src[srcIndex + 1];
      output[dstIndex + 2] = src[srcIndex + 2];
      output[dstIndex + 3] = src[srcIndex + 3];
    }
  }

  return {
    data: output,
    width: targetWidth,
    height: targetHeight,
  };
}

function rotatePixels(source: Pixels, angle: RotationAngle): Pixels {
  if (angle === 0) return source;

  const src = source.data;
  const srcWidth = source.width;
  const srcHeight = source.height;
  const targetWidth = angle === 180 ? srcWidth : srcHeight;
  const targetHeight = angle === 180 ? srcHeight : srcWidth;
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4);

  for (let y = 0; y < srcHeight; y += 1) {
    for (let x = 0; x < srcWidth; x += 1) {
      const srcIndex = (y * srcWidth + x) * 4;
      let dstX = 0;
      let dstY = 0;

      if (angle === 90) {
        dstX = srcHeight - 1 - y;
        dstY = x;
      } else if (angle === -90) {
        dstX = y;
        dstY = srcWidth - 1 - x;
      } else {
        dstX = srcWidth - 1 - x;
        dstY = srcHeight - 1 - y;
      }

      const dstIndex = (dstY * targetWidth + dstX) * 4;
      output[dstIndex] = src[srcIndex];
      output[dstIndex + 1] = src[srcIndex + 1];
      output[dstIndex + 2] = src[srcIndex + 2];
      output[dstIndex + 3] = src[srcIndex + 3];
    }
  }

  return {
    data: output,
    width: targetWidth,
    height: targetHeight,
  };
}

function toClamped(data: Uint8Array | Uint8ClampedArray): Uint8ClampedArray {
  if (data instanceof Uint8ClampedArray) return data;
  return new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
}

function isPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}
