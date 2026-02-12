import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_DEFINITIONS,
  clearFeatureFlagOverrides,
  getFeatureFlagsSnapshot,
  isFeatureEnabled,
  parseBooleanEnv,
  setFeatureFlagOverride,
} from '../featureFlags.js';

test('parseBooleanEnv parses common variants', () => {
  assert.equal(parseBooleanEnv('true', false), true);
  assert.equal(parseBooleanEnv('1', false), true);
  assert.equal(parseBooleanEnv('ON', false), true);
  assert.equal(parseBooleanEnv('false', true), false);
  assert.equal(parseBooleanEnv('0', true), false);
  assert.equal(parseBooleanEnv('off', true), false);
  assert.equal(parseBooleanEnv('', true), true);
});

test('new feature flags default to disabled when env is empty', async () => {
  const backups = {};
  Object.values(FEATURE_DEFINITIONS).forEach((item) => {
    backups[item.env] = process.env[item.env];
    delete process.env[item.env];
  });

  try {
    await clearFeatureFlagOverrides({ actor: 'test' });
    const snapshot = getFeatureFlagsSnapshot();
    Object.keys(FEATURE_DEFINITIONS).forEach((key) => {
      assert.equal(snapshot[key], false);
      assert.equal(isFeatureEnabled(key), false);
    });
  } finally {
    await clearFeatureFlagOverrides({ actor: 'test_cleanup' });
    Object.values(FEATURE_DEFINITIONS).forEach((item) => {
      if (typeof backups[item.env] === 'undefined') {
        delete process.env[item.env];
      } else {
        process.env[item.env] = backups[item.env];
      }
    });
  }
});

test('runtime override has priority over env and can be cleared', async () => {
  const envName = FEATURE_DEFINITIONS.recoVw.env;
  const backup = process.env[envName];
  process.env[envName] = 'false';
  try {
    await setFeatureFlagOverride('recoVw', true, { actor: 'test_override' });
    assert.equal(isFeatureEnabled('recoVw'), true);
    await setFeatureFlagOverride('recoVw', null, { actor: 'test_override_clear' });
    assert.equal(isFeatureEnabled('recoVw'), false);
  } finally {
    await clearFeatureFlagOverrides({ actor: 'test_cleanup' });
    if (typeof backup === 'undefined') {
      delete process.env[envName];
    } else {
      process.env[envName] = backup;
    }
  }
});
