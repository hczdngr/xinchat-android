const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEVICE = (process.env.ADB_DEVICE || process.env.ANDROID_SERIAL || '').trim();
const APK_PATH = path.join(
  ROOT,
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk'
);

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      ...options,
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });

async function main() {
  if (DEVICE.includes(':')) {
    await run('adb', ['connect', DEVICE]);
  }
  const installArgs = DEVICE ? ['-s', DEVICE, 'install', '-r', APK_PATH] : ['install', '-r', APK_PATH];
  await run('adb', installArgs);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
