import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAutomationCredentials } from '../bin/workbench-provider.mjs';

const creds = { WRITE_TOKEN: 'dummy-publish-token', OPENAI_API_KEY: 'dummy-openai', ANTHROPIC_API_KEY: 'dummy-anthropic', DEEPSEEK_API_KEY: 'dummy-deepseek' };

test('DeepSeek Flash and Pro use the DeepSeek API key', () => {
  for (const id of ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro']) {
    assert.deepEqual(validateAutomationCredentials({ ...creds, MODEL: id }), { enabled: true, provider: 'deepseek', model: id });
  }
});
test('DeepSeek selection must not be unlocked by another provider key', () => {
  const result = validateAutomationCredentials({ MODEL: 'deepseek/deepseek-flash', WRITE_TOKEN: 'dummy', OPENAI_API_KEY: 'dummy' });
  assert.equal(result.enabled, false);
  assert.match(result.reason, /WORKBENCH_DEEPSEEK_API_KEY/);
});
test('OpenAI and Anthropic remain supported', () => {
  assert.equal(validateAutomationCredentials({ ...creds, MODEL: 'openai/gpt-example' }).enabled, true);
  assert.equal(validateAutomationCredentials({ ...creds, MODEL: 'anthropic/claude-example' }).enabled, true);
});
test('missing publisher token, invalid model and unknown provider fail closed', () => {
  assert.equal(validateAutomationCredentials({ MODEL: 'deepseek/deepseek-flash', DEEPSEEK_API_KEY: 'dummy' }).enabled, false);
  assert.equal(validateAutomationCredentials({ ...creds, MODEL: 'deepseek-flash' }).enabled, false);
  assert.equal(validateAutomationCredentials({ ...creds, MODEL: 'unknown/model' }).enabled, false);
});
test('validation results never expose provider or publisher secret values', () => {
  const returned = JSON.stringify(validateAutomationCredentials({ ...creds, MODEL: 'deepseek/deepseek-flash' }));
  assert.ok(!returned.includes('dummy-deepseek'));
  assert.ok(!returned.includes('dummy-publish-token'));
});
