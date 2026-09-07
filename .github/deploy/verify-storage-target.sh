#!/usr/bin/env bash
# Assert that the object storage a host is configured for matches what this
# environment is supposed to use, and print the resolved config into the deploy log.
#
# Piped over ssh/SSM the same way ec2-unpack-ol-node.sh is:
#   sudo APP_DIR=... EXPECT_STORAGE=r2 bash -s < .github/deploy/verify-storage-target.sh
#
# Why this exists
# ---------------
# Which object store the app talks to is decided at runtime by $APP_DIR/.env, never
# by the code:
#
#   S3_ENDPOINT_URL unset -> AWS S3        (prodv2, staging)
#   S3_ENDPOINT_URL set   -> Cloudflare R2 (GCP production)
#
# That separation is what makes it safe to run one codebase on every branch. The
# failure it cannot prevent on its own is a *host* whose .env does not match its
# environment: a GCP box missing S3_ENDPOINT_URL boots happily and writes user
# uploads into the AWS bucket, and nothing surfaces the mistake until objects are
# missing. This turns that silent mismatch into a failed deploy, before the new
# build is unpacked or pm2 is restarted.
#
# Exit codes: 0 = matches expectation, 1 = mismatch or unreadable env.

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/ol/apps/live-server}"
EXPECT_STORAGE="${EXPECT_STORAGE:-}"
ENV_FILE="$APP_DIR/.env"

if [ -z "$EXPECT_STORAGE" ]; then
  echo "::error::EXPECT_STORAGE not set (expected 'r2' or 'aws-s3')"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "::error::$ENV_FILE not found - cannot verify the storage target"
  exit 1
fi

# Read one key from the env file. Values may be quoted and may carry CRLF.
read_var() {
  grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null \
    | tail -1 \
    | cut -d= -f2- \
    | tr -d '\r' \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" \
    | xargs 2>/dev/null || true
}

S3_ENDPOINT_URL="$(read_var S3_ENDPOINT_URL)"
S3_BUCKET="$(read_var S3_BUCKET)"
S3_REGION="$(read_var S3_REGION)"
S3_PUBLIC_BASE_URL="$(read_var S3_PUBLIC_BASE_URL)"
S3_FORCE_PATH_STYLE="$(read_var S3_FORCE_PATH_STYLE)"
AWS_S3_BUCKET="$(read_var AWS_S3_BUCKET)"
AWS_REGION="$(read_var AWS_REGION)"
CLOUDFRONT_DOMAIN="$(read_var CLOUDFRONT_DOMAIN)"
NODE_ENV="$(read_var NODE_ENV)"

# Mirror the resolution order in src/modules/videoCall/aws.service.js and storage.service.ts exactly.
if [ -n "$S3_ENDPOINT_URL" ]; then
  ACTUAL="r2"
  RESOLVED_BUCKET="${S3_BUCKET:-$AWS_S3_BUCKET}"
  RESOLVED_REGION="${S3_REGION:-$AWS_REGION}"
  RESOLVED_PUBLIC="${S3_PUBLIC_BASE_URL:-$CLOUDFRONT_DOMAIN}"
else
  ACTUAL="aws-s3"
  RESOLVED_BUCKET="$AWS_S3_BUCKET"
  RESOLVED_REGION="$AWS_REGION"
  RESOLVED_PUBLIC="${CLOUDFRONT_DOMAIN:-<bucket-hosted AWS URL>}"
fi

echo "Object storage resolved from $ENV_FILE"
echo "  provider        : $ACTUAL"
echo "  expected        : $EXPECT_STORAGE"
echo "  bucket          : ${RESOLVED_BUCKET:-<unset>}"
echo "  region          : ${RESOLVED_REGION:-<unset>}"
echo "  endpoint        : ${S3_ENDPOINT_URL:-<none - AWS default>}"
echo "  path style      : ${S3_FORCE_PATH_STYLE:-false}"
echo "  public base URL : ${RESOLVED_PUBLIC:-<unset>}"
echo "  NODE_ENV        : ${NODE_ENV:-<unset>}"

FAILED=0

if [ "$ACTUAL" != "$EXPECT_STORAGE" ]; then
  echo "::error::Storage mismatch - this environment expects '$EXPECT_STORAGE' but $ENV_FILE resolves to '$ACTUAL'."
  if [ "$EXPECT_STORAGE" = "r2" ]; then
    echo "::error::S3_ENDPOINT_URL is unset, so uploads would go to the AWS S3 bucket instead of R2."
  else
    echo "::error::S3_ENDPOINT_URL is set, so uploads would go to R2 instead of the AWS S3 bucket."
  fi
  FAILED=1
fi

if [ -z "${RESOLVED_BUCKET}" ]; then
  echo "::error::No bucket resolved (neither S3_BUCKET nor AWS_S3_BUCKET is set) - uploads would fail with S3_NOT_CONFIGURED."
  FAILED=1
fi

# env.ts fails startup on this, but failing here names the problem before pm2 restarts.
if [ "$ACTUAL" = "r2" ] && [ -z "$RESOLVED_PUBLIC" ]; then
  echo "::error::S3_ENDPOINT_URL is set without S3_PUBLIC_BASE_URL or CLOUDFRONT_DOMAIN - the app will refuse to boot."
  FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
  echo "Deploy stopped before unpacking. Fix $ENV_FILE on this host and re-run."
  exit 1
fi

echo "Storage target matches this environment."
