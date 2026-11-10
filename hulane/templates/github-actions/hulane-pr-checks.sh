#!/usr/bin/env bash
set -euo pipefail

checks_run=0

if [[ -x .github/hulane-ci.sh ]]; then
  .github/hulane-ci.sh
  checks_run=1
elif [[ -x scripts/ci.sh ]]; then
  scripts/ci.sh
  checks_run=1
fi

if [[ -f package-lock.json ]]; then
  npm ci
  npm test
  npm run lint --if-present
  npm run build --if-present
  checks_run=1
elif [[ -f package.json ]]; then
  npm install --ignore-scripts
  npm test
  npm run lint --if-present
  npm run build --if-present
  checks_run=1
fi

if [[ -f go.mod ]]; then
  go test ./...
  checks_run=1
fi

if [[ -f Cargo.toml ]]; then
  cargo fmt --all -- --check
  cargo test --locked
  checks_run=1
fi

if [[ -f pyproject.toml || -f pytest.ini || -d tests ]]; then
  if [[ -f requirements-dev.txt ]]; then
    python -m pip install -r requirements-dev.txt
  elif [[ -f requirements.txt ]]; then
    python -m pip install -r requirements.txt
  fi
  python -m pytest
  checks_run=1
fi

if [[ -f Dockerfile ]]; then
  if [[ -n "${GITHUB_ACTIONS:-}" ]] && docker buildx version >/dev/null 2>&1; then
    docker buildx build --load \
      --tag "hulane-pr-check:${GITHUB_SHA:-local}" \
      --cache-from type=gha \
      --cache-to type=gha,mode=max \
      .
  else
    docker build --tag "hulane-pr-check:${GITHUB_SHA:-local}" .
  fi
  checks_run=1
fi

# Optional spec-layer soft gate: only runs when the repository carries an
# openspec/ directory and the openspec CLI is installed; otherwise skip.
if [[ -d openspec ]] && command -v openspec >/dev/null 2>&1; then
  openspec validate --specs
fi

if [[ "${checks_run}" -eq 0 ]]; then
  echo "No supported test/build entrypoint was found." >&2
  echo "Add executable .github/hulane-ci.sh or scripts/ci.sh." >&2
  exit 2
fi

