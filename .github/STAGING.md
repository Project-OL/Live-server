# Staging deploy (ol-stag)

Same as `production.yml`: pack artifact, SCP to `/tmp`, `ssh 'bash -s' < ec2-unpack-live-server.sh`.

Staging only differs in paths: `APP_USER=ec2-user` `APP_DIR=/home/ec2-user/live-server`.

Secrets on Environment `staging`: `STAGING_EC2_HOST`, `STAGING_EC2_USER`, `STAGING_EC2_SSH_PRIVATE_KEY`.
