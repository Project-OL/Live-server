# Staging deploy (ol-stag)

Same flow as this repo's `production.yml`: GitHub Actions packs a tarball, SCPs it to `/tmp`, then runs `.github/deploy/ec2-unpack-live-server.sh` via `ssh … 'bash -s'`.

Do not use OIDC / S3 / SSM for staging. Secrets are already configured on Environment **staging**.

| | |
|---|---|
| App dir | `/home/ec2-user/live-server` |
| PM2 | `ol-live` |
| URL | https://live-staging.offoolive.com |

`.env` stays on the instance (not in the artifact).

## GitHub

**Settings → Environments → `staging`**

| Secret | Value |
|---|---|
| `STAGING_EC2_HOST` | `3.110.118.179` |
| `STAGING_EC2_USER` | `ec2-user` |
| `STAGING_EC2_SSH_PRIVATE_KEY` | PEM for `ssh ol-stag` |

Deploy one app at a time on ol-stag (`npm ci` saturates the t3.micro).
