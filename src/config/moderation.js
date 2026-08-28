/**
 * Live / video-call nudity monitoring (AWS Rekognition).
 *
 * Set ENABLE_NUDE_MONITORING=true (or "1") to run moderation scans and enforce
 * blocks/bans. When unset or false, moderateImage() returns clean and callers
 * keep the same API response shape without ending streams/calls or applying bans.
 */
export function isNudeMonitoringEnabled() {
  const raw = process.env.ENABLE_NUDE_MONITORING;
  return raw === 'true' || raw === '1';
}

const enabled = isNudeMonitoringEnabled();
if (!enabled) {
  console.warn(
    '[Moderation] ENABLE_NUDE_MONITORING is off — live stream and video-call nudity checks are skipped (no Rekognition, blocks, or stream bans).',
  );
}
