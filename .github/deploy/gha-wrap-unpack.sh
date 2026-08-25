#!/usr/bin/env bash
# Run an unpack script under nohup-friendly conditions and always write an exit file.
# Used by GitHub Actions so a dropped SSH session does not kill npm ci.
set +e
export PATH="/usr/bin:/usr/local/bin:${PATH:-/usr/bin}"
script="${UNPACK_SCRIPT:?UNPACK_SCRIPT not set}"
bash "$script"
ec=$?
echo "$ec" > "${UNPACK_EXIT:-/tmp/gha-unpack.exit}"
exit 0
