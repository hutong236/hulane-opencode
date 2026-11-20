#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const PROVIDER_KEYS = Object.freeze({
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
});

export function validateAutomationCredentials(env = {}) {
  const model = (env.MODEL || '').trim();
  const [provider, name, extra] = model.split('/');
  if (!provider || !name || extra || !/^[a-z0-9][a-z0-9-]*$/i.test(provider) || !/^[a-z0-9][a-z0-9.-]*$/i.test(name)) {
    return { enabled: false, reason: 'WORKBENCH_AUTODEV_MODEL must be a provider/model identifier.' };
  }
  const keyName = PROVIDER_KEYS[provider];
  if (!keyName) {
    return { enabled: false, reason: `Unsupported provider "${provider}". Supported: DeepSeek, OpenAI, Anthropic.` };
  }
  if (!env[keyName]) {
    const secret = keyName === 'DEEPSEEK_API_KEY' ? 'WORKBENCH_DEEPSEEK_API_KEY'
      : keyName === 'OPENAI_API_KEY' ? 'WORKBENCH_OPENAI_API_KEY' : 'WORKBENCH_ANTHROPIC_API_KEY';
    return { enabled: false, reason: `Missing ${secret} secret for selected provider ${provider}.` };
  }
  if (!env.WRITE_TOKEN) {
    return { enabled: false, reason: 'Missing WORKBENCH_AUTODEV_TOKEN secret for publishing Draft PRs.' };
  }
  return { enabled: true, provider, model };
}

function main() {
  const status = validateAutomationCredentials(process.env);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `enabled=${status.enabled}\n`);
  }
  const message = status.enabled
    ? `Automation credentials are configured for provider ${status.provider}; model endpoint access is not yet verified.`
    : `BLOCKED: ${status.reason} No provider call or repository write was attempted.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
