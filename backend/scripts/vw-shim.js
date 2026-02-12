#!/usr/bin/env node
/**
 * VW bridge shim.
 * - Keeps existing "node vw-shim.js <vw args>" contract.
 * - Delegates to real Vowpal Wabbit CLI binary.
 * - Auto-bootstraps model when legacy placeholder model is encountered.
 */

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const __filename = fileURLToPath(import.meta.url);

const readArgValue = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0) return '';
  return String(args[index + 1] || '').trim();
};

const normalizePath = (value) => path.resolve(String(value || '').trim());
const isJsEntry = (value) => /\.(mjs|cjs|js)$/i.test(String(value || '').trim());
const modelPath = readArgValue('-i');
const explicitBinary = String(process.env.VW_REAL_BINARY_PATH || process.env.VW_NATIVE_BINARY_PATH || '').trim();
const envBinary = String(process.env.VW_BINARY_PATH || '').trim();
const shimPath = normalizePath(__filename);

const isSelfPath = (value) => {
  if (!value) return false;
  try {
    return normalizePath(value) === shimPath;
  } catch {
    return false;
  }
};

const resolveBinaryCandidate = () => {
  if (explicitBinary && !isJsEntry(explicitBinary) && !isSelfPath(explicitBinary)) {
    return explicitBinary;
  }
  if (envBinary && !isJsEntry(envBinary) && !isSelfPath(envBinary)) {
    return envBinary;
  }
  return process.platform === 'win32' ? 'vw.exe' : 'vw';
};

const readStdin = async () => {
  if (process.stdin.isTTY) return '';
  return await new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += String(chunk || '');
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
};

const runVw = async ({ binary, vwArgs, input = '' }) =>
  await new Promise((resolve) => {
    const child = spawn(binary, vwArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (error) => {
      resolve({
        ok: false,
        code: -1,
        signal: 'spawn_error',
        stdout,
        stderr: String(error?.message || 'vw_spawn_error'),
      });
    });
    child.on('close', (code, signal) => {
      resolve({
        ok: Number(code) === 0,
        code: Number.isFinite(Number(code)) ? Number(code) : 1,
        signal: signal || '',
        stdout,
        stderr,
      });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });

const shouldTryBootstrap = (stderrText = '', currentModelPath = '') => {
  if (!currentModelPath) return false;
  const text = String(stderrText || '').toLowerCase();
  return (
    text.includes('bad model') ||
    text.includes('invalid model') ||
    text.includes('not a valid model') ||
    text.includes('can\'t open') ||
    text.includes('cannot open') ||
    text.includes('failed to open')
  );
};

const bootstrapModel = async ({ binary, targetModelPath }) => {
  if (!targetModelPath) {
    return { ok: false, reason: 'missing_model_path' };
  }
  await fs.mkdir(path.dirname(targetModelPath), { recursive: true }).catch(() => undefined);
  const bootstrapArgs = ['--quiet', '--passes', '1', '-f', targetModelPath];
  const bootstrapInput = '0 |u uid_hash:0.001000 hour:0.500000 |a bootstrap:1.000000\n';
  return await runVw({
    binary,
    vwArgs: bootstrapArgs,
    input: bootstrapInput,
  });
};

const main = async () => {
  const binary = resolveBinaryCandidate();
  const input = await readStdin();
  let result = await runVw({
    binary,
    vwArgs: args,
    input,
  });
  if (!result.ok && shouldTryBootstrap(result.stderr, modelPath)) {
    const bootstrap = await bootstrapModel({ binary, targetModelPath: modelPath });
    if (bootstrap.ok) {
      result = await runVw({
        binary,
        vwArgs: args,
        input,
      });
    } else {
      result = {
        ...result,
        stderr: `${result.stderr}\n[vw-shim] bootstrap failed: ${String(bootstrap?.stderr || bootstrap?.reason || 'unknown')}`.trim(),
      };
    }
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (!result.ok && result.code === -1) {
    console.error(
      `\n[vw-shim] real VW binary not found. Set VW_REAL_BINARY_PATH to your vowpal_wabbit binary path, e.g. C:\\vw\\vw.exe`
    );
    process.exit(127);
  }
  process.exit(result.ok ? 0 : Math.max(1, Number(result.code) || 1));
};

main().catch((error) => {
  console.error(`[vw-shim] fatal: ${String(error?.message || error)}`);
  process.exit(2);
});
