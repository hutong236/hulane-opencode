# WB-003 Web shell

Six real routes: `/projects`, `/requirements`, `/workflows`, `/runs`, `/integration`, `/settings`.
The UI displays only real API health. HTTP failures offer retry; missing modules remain disabled. Settings only persist local theme.

From `workbench/`: `npm ci`, `npx playwright install chromium`, `npm run dev`, `npm run test:e2e`.
Chromium E2E validates navigation/refresh, HTTP 500 recovery, mobile drawer and theme persistence.
