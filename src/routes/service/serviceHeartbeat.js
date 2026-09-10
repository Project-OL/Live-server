// Heartbeat Protection System disabled as requested.

/**
 * Record a stream heartbeat ping from Host (Disabled).
 */
export const recordStreamHeartbeat = async () => {
    return null;
};

/**
 * Fetch recorded heartbeat metadata for a stream (Disabled).
 */
export const getStreamHeartbeat = async () => {
    return null;
};

/**
 * Start background monitor (Disabled - no-op).
 */
export const startStreamHeartbeatMonitor = () => {
    console.log("[Heartbeat Protection] Background monitor is completely DISABLED.");
};

/**
 * Stop background monitor (Disabled - no-op).
 */
export const stopStreamHeartbeatMonitor = () => {};

