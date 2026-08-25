# Staging deploy (ol-stag)

Uses the same GitHub → S3 → SSM path as ol-node `production.yml` (no SSH port 22).

Instance `i-04b31dbda6ed0edc4` must have an IAM instance profile with SSM + S3 read on `ol-production-deploy-artifacts-465457334877`. See ol-node `.github/STAGING.md`.
