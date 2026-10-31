#!/usr/bin/env bash
# Deploy the agent-docs React UI (chrome only) to S3 + CloudFront.
# Usage:
#   S3_BUCKET=agentdocs-ui-prod \
#   CLOUDFRONT_DISTRIBUTION_ID=E1234567890ABC \
#   VITE_API_URL=https://api.example.com \
#   ./deploy.sh
# Optional: AWS_PROFILE, AWS_REGION (default: us-east-1 for CloudFront calls is not
# required; S3 sync uses the bucket's region automatically).
set -euo pipefail

: "${S3_BUCKET:?Set S3_BUCKET}"
: "${CLOUDFRONT_DISTRIBUTION_ID:?Set CLOUDFRONT_DISTRIBUTION_ID}"
: "${VITE_API_URL:?Set VITE_API_URL (the API public URL)}"

if [ -n "${AWS_PROFILE:-}" ]; then
  export AWS_PROFILE
fi

echo "==> Building UI (VITE_API_URL is baked in at build time)"
npm ci
VITE_API_URL="$VITE_API_URL" npm run build

echo "==> Syncing hashed assets (long cache, immutable)"
aws s3 sync dist/ "s3://$S3_BUCKET" --delete \
  --exclude "index.html" \
  --cache-control "public, max-age=31536000, immutable"

echo "==> Syncing index.html last (no cache, so it never points at a missing asset)"
aws s3 sync dist/ "s3://$S3_BUCKET" \
  --exclude "*" --include "index.html" \
  --cache-control "no-cache, no-store, must-revalidate"

echo "==> Invalidating CloudFront (only index.html needs it; assets are hashed)"
aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/index.html"

echo "==> Done. Verify with: curl -I https://<your-cloudfront-domain>/"
