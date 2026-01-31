import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WATCH_DIRS = ['src', 'public'].map((dir) => path.join(ROOT, dir));
const WATCH_FILES = ['index.html', 'vite.config.js', 'package.json'].map((file) =>
  path.join(ROOT, file)
);
const DEBOUNCE_MS = 400;

let running = false;
let pending = false;
let timer = null;
const watchers = [];

const runCommand = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });

const syncAndroid = async () => {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    await runCommand('npm', ['run', 'build']);
    await runCommand('npx', ['cap', 'sync', 'android']);
  } catch (error) {
    console.error('[cap-watch] sync failed:', error?.message || error);
  } finally {
    running = false;
    if (pending) {
      pending = false;
      await syncAndroid();
    }
  }
};

const scheduleSync = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncAndroid();
  }, DEBOUNCE_MS);
};

const startWatching = () => {
  WATCH_DIRS.forEach((dir) => {
    watchers.push(
      watch(dir, { recursive: true }, () => {
        scheduleSync();
      })
    );
  });
  WATCH_FILES.forEach((file) => {
    watchers.push(
      watch(file, () => {
        scheduleSync();
      })
    );
  });
};

const stopWatching = () => {
  watchers.forEach((w) => w.close());
  watchers.length = 0;
};

process.on('SIGINT', () => {
  stopWatching();
  process.exit(0);
});

console.log('[cap-watch] initial build + copy...');
await syncAndroid();
console.log('[cap-watch] watching for changes...');
startWatching();
