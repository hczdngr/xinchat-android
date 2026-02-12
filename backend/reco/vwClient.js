/**
 * Optional VW CLI bridge.
 * If VW binary/model are unavailable the caller should gracefully fall back.
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { buildVwLine } from './featureBuilder.js';

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parsePredictionFile = async (predictionPath) => {
  const raw = await fsPromises.readFile(predictionPath, 'utf-8');
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const token = line.split(/\s+/)[0];
    const value = Number(token);
    return Number.isFinite(value) ? value : 0;
  });
};

const runVwProcess = async ({ binaryPath, args = [], lines = [], timeoutMs = 1500 }) => {
  const useNodeShim = /\.(mjs|cjs|js)$/i.test(String(binaryPath || '').trim());
  const spawnCommand = useNodeShim ? process.execPath : binaryPath;
  const spawnArgs = useNodeShim ? [binaryPath, ...args] : args;

  return await new Promise((resolve) => {
    const child = spawn(spawnCommand, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderrText = '';
    let stdoutText = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      resolve({
        ok: false,
        code: -1,
        signal: 'SIGKILL',
        stdout: stdoutText,
        stderr: 'vw_timeout',
      });
    }, Math.max(200, Math.floor(timeoutMs)));

    child.stderr.on('data', (chunk) => {
      stderrText += String(chunk || '');
    });
    child.stdout.on('data', (chunk) => {
      stdoutText += String(chunk || '');
    });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        code: -2,
        signal: 'spawn_error',
        stdout: stdoutText,
        stderr: String(error?.message || 'vw_spawn_error'),
      });
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code: Number(code),
        signal: signal || '',
        stdout: stdoutText,
        stderr: stderrText,
      });
    });

    child.stdin.on('error', () => undefined);
    child.stdin.end(lines.join('\n') + '\n');
  });
};

const runVwPrediction = async ({ binaryPath, modelPath, lines, timeoutMs = 1500 }) => {
  const predictionPath = path.join(
    os.tmpdir(),
    `xinchat_vw_pred_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`
  );
  const args = ['--quiet', '-t', '-i', modelPath, '-p', predictionPath];
  const result = await runVwProcess({
    binaryPath,
    args,
    lines,
    timeoutMs,
  });
  return {
    ...result,
    predictionPath,
  };
};

const getVwClientStatus = (config = {}) => {
  const binaryPath = String(config?.vwBinaryPath || '').trim();
  const modelPath = String(config?.vwModelPath || '').trim();
  const binaryExists = binaryPath ? fs.existsSync(binaryPath) : false;
  const modelExists = modelPath ? fs.existsSync(modelPath) : false;
  return {
    binaryPath,
    modelPath,
    binaryExists,
    modelExists,
    ready: binaryExists && modelExists,
  };
};

const scoreCandidatesWithVw = async ({
  sharedFeatures = {},
  candidateFeatures = [],
  timeoutMs = 1500,
  config = {},
} = {}) => {
  const status = getVwClientStatus(config);
  if (!status.ready) {
    return {
      available: false,
      provider: 'vw_cli',
      reason: 'vw_not_ready',
      status,
      scores: [],
    };
  }
  if (!Array.isArray(candidateFeatures) || candidateFeatures.length === 0) {
    return {
      available: false,
      provider: 'vw_cli',
      reason: 'no_candidates',
      status,
      scores: [],
    };
  }

  const lines = candidateFeatures.map((item) =>
    buildVwLine({
      shared: sharedFeatures,
      action: item && typeof item === 'object' ? item : {},
    })
  );

  const result = await runVwPrediction({
    binaryPath: status.binaryPath,
    modelPath: status.modelPath,
    lines,
    timeoutMs: toFiniteNumber(timeoutMs, 1500),
  });

  try {
    const scores = result.ok ? await parsePredictionFile(result.predictionPath) : [];
    const normalizedScores =
      scores.length === candidateFeatures.length ? scores.map((value) => toFiniteNumber(value, 0)) : [];
    return {
      available: result.ok && normalizedScores.length === candidateFeatures.length,
      provider: 'vw_cli',
      reason:
        result.ok && normalizedScores.length === candidateFeatures.length
          ? 'ok'
          : result.ok
            ? 'vw_prediction_count_mismatch'
            : String(result?.stderr || 'vw_failed').slice(0, 240),
      status,
      scores: normalizedScores,
      stderr: String(result?.stderr || '').slice(0, 500),
    };
  } finally {
    if (result.predictionPath) {
      await fsPromises.unlink(result.predictionPath).catch(() => undefined);
    }
  }
};

const trainVwModelWithLine = async ({
  line = '',
  timeoutMs = 1500,
  learningRate = null,
  config = {},
} = {}) => {
  const status = getVwClientStatus(config);
  const sample = String(line || '').trim();
  if (!status.ready) {
    return {
      available: false,
      provider: 'vw_cli',
      reason: 'vw_not_ready',
      status,
    };
  }
  if (!sample) {
    return {
      available: false,
      provider: 'vw_cli',
      reason: 'empty_train_line',
      status,
    };
  }
  const args = ['--quiet', '-i', status.modelPath, '-f', status.modelPath];
  if (Number.isFinite(Number(learningRate))) {
    args.push('-l', String(toFiniteNumber(learningRate, 0.08)));
  }
  const result = await runVwProcess({
    binaryPath: status.binaryPath,
    args,
    lines: [sample],
    timeoutMs: toFiniteNumber(timeoutMs, 1500),
  });
  return {
    available: result.ok,
    provider: 'vw_cli',
    reason: result.ok ? 'ok' : String(result?.stderr || 'vw_train_failed').slice(0, 240),
    status,
    stderr: String(result?.stderr || '').slice(0, 500),
    code: result.code,
  };
};

export { getVwClientStatus, scoreCandidatesWithVw, trainVwModelWithLine };
