# Staging deploy (ol-stag)

Push to `staging` builds an artifact on GitHub Actions and SCP/unpacks it to **ol-stag**.

- App dir: `/home/ec2-user/live-server`
- PM2: `ol-live`
- URL: https://live-staging.offoolive.com
- `.env` and `google-credentials.json` stay on the instance

## GitHub configuration (once)

**Settings → Environments → New environment → `staging`**

Secrets (on that environment or repo Actions secrets):

| Name | Value |
|---|---|
| `STAGING_EC2_HOST` | `3.110.118.179` |
| `STAGING_EC2_USER` | `ec2-user` |
| `STAGING_EC2_SSH_PRIVATE_KEY` | Full PEM for `ssh ol-stag` |

Same three secrets must exist on **ol-node**, **Live-server**, and **ol-admin**.

ol-stag security group must allow inbound **TCP 22** from GitHub-hosted runners (or `0.0.0.0/0` if you already open SSH that way).
