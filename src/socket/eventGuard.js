import { modeFromEnv, makeWindowLog, takeToken } from "../utils/tokenBucket.js";

/**
 * Per-packet guard for incoming socket events (registered with socket.use for every socket).
 *
 * 1. LIVE-58, always on: the handlers destructure their payload (`async ({ streamId }) => ...`), so
 *    an event with no payload, null, or a string threw inside an async handler, which was an
 *    unhandled rejection that crashed the whole process (every live stream and call dropped). Any
 *    connected client could do it. Such packets are dropped. The app always sends an object.
 *
 * 2. LIVE-48, LIVE_SOCKET_GUARD_MODE (off | log | enforce, default log): field types and sizes for
 *    the events Live-server handles. Log mode only counts what enforce would drop.
 *
 * 3. LIVE-47, LIVE_RATE_LIMIT_MODE (off | log | enforce, default log; shared with REST): token
 *    buckets per socket and event class. Unhandled events (the app emits several the server
 *    ignores) count against the default class too.
 *
 * Enforce drops the packet; if the client passed an ack callback it gets
 * `{ success: false, code: 'RATE_LIMITED' | 'INVALID_PAYLOAD' }` so it isn't left waiting.
 */

// Every event a Live-server handler listens for (socket-live-service.js, videoCall/socket.js).
export const HANDLED_EVENTS = new Set([
    "stream_heartbeat", "join_stream", "leave_stream", "invite_to_sheet", "decline_sheet_invite",
    "accept_sheet_invite", "toggle_mic_permission", "set_chat_permission", "request_to_join_sheet",
    "accept_sheet_request", "reject_sheet_request", "toggle_sheet_mute", "toggle_self_mute",
    "remove_from_sheet", "toggle_camera_state", "leave_sheet", "clear_chat", "send_gift",
    "send_lucky_gift", "SEND_MESSAGE"
]);

// [type, required, max] per field; `id` = non-empty string or finite number up to max chars.
const ID = (required = true) => ["id", required, 100];
const BOOL = ["bool", false];
const INT = (max) => ["int", false, max];
const STR = (required, max) => ["str", required, max];

const SCHEMAS = {
    stream_heartbeat: { streamId: ID() },
    join_stream: { streamId: ID() },
    leave_stream: { streamId: ID() },
    decline_sheet_invite: { streamId: ID() },
    accept_sheet_invite: { streamId: ID() },
    request_to_join_sheet: { streamId: ID() },
    leave_sheet: { streamId: ID() },
    clear_chat: { streamId: ID() },
    invite_to_sheet: { streamId: ID(), targetUserId: ID() },
    accept_sheet_request: { streamId: ID(), targetUserId: ID() },
    reject_sheet_request: { streamId: ID(), targetUserId: ID() },
    remove_from_sheet: { streamId: ID(), targetUserId: ID() },
    toggle_sheet_mute: { streamId: ID(), targetUserId: ID(), muteState: BOOL },
    toggle_self_mute: { streamId: ID(), muteState: BOOL },
    toggle_camera_state: { streamId: ID(), isCameraOn: BOOL },
    toggle_mic_permission: { streamId: ID(), micPermissionRequired: BOOL },
    set_chat_permission: { streamId: ID(), mode: STR(false, 32) },
    send_gift: {
        streamId: ID(), giftId: ID(), receiverId: ID(false), targetUserId: ID(false),
        count: INT(10_000), comboCount: INT(100_000), clientTxId: STR(false, 100)
    },
    send_lucky_gift: {
        streamId: ID(), giftId: ID(), receiverId: ID(false), comboCount: INT(100_000), clientTxId: STR(false, 100)
    },
    SEND_MESSAGE: { receiverId: ID(), text: STR(true, 1000) }
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** First problem with the payload, or null. */
export const payloadProblem = (event, payload) => {
    const schema = SCHEMAS[event];
    if (!schema) return null;
    for (const [field, [type, required, max]] of Object.entries(schema)) {
        const v = payload[field];
        if (v === undefined || v === null || v === "") {
            if (required) return `${field}:missing`;
            continue;
        }
        if (type === "id") {
            const ok = (typeof v === "string" && v.length <= max) || (typeof v === "number" && Number.isFinite(v));
            if (!ok) return `${field}:type`;
        } else if (type === "str") {
            if (typeof v !== "string") return `${field}:type`;
            if (v.length > max) return `${field}:too_long`;
        } else if (type === "bool") {
            if (typeof v !== "boolean") return `${field}:type`;
        } else if (type === "int") {
            if (!Number.isInteger(v) || v < 1 || v > max) return `${field}:range`;
        }
    }
    return null;
};

// [capacity, refill per second] per event class, per socket. Generous: the goal is floods, not users.
const RATE_CLASSES = {
    gift: [40, 10],
    chat: [10, 2],
    heartbeat: [6, 1],
    join: [10, 1],
    default: [60, 20]
};
const classOf = (event) => {
    if (event === "send_gift" || event === "send_lucky_gift") return "gift";
    if (event === "SEND_MESSAGE" || event === "clear_chat") return "chat";
    if (event === "stream_heartbeat") return "heartbeat";
    if (event === "join_stream" || event === "leave_stream") return "join";
    return "default";
};

const report = makeWindowLog("Socket Guard");

const reject = (packet, code) => {
    const ack = packet[packet.length - 1];
    if (typeof ack === "function") {
        try {
            ack({ success: false, code });
        } catch {}
    }
};

/** Build the socket.use middleware for one socket. */
export const socketEventGuard = (socket) => {
    const buckets = {};
    return (packet, next) => {
        const event = String(packet?.[0] ?? "");
        const payload = packet?.[1];
        const userId = socket.data?.authUserId || socket.handshake?.auth?.userId || "anon";
        const handled = HANDLED_EVENTS.has(event);

        // 1. LIVE-58: always on.
        if (handled && !isPlainObject(payload)) {
            report.count(`dropped_not_object:${event}`);
            report.detail(`nobj:${userId}:${event}`, `dropped ${event} from user ${userId}: payload is ${payload === null ? "null" : Array.isArray(payload) ? "an array" : typeof payload}`);
            reject(packet, "INVALID_PAYLOAD");
            return;
        }

        // 3. LIVE-47: rate limit.
        const rateMode = modeFromEnv("LIVE_RATE_LIMIT_MODE");
        if (rateMode !== "off") {
            const cls = classOf(event);
            const [cap, refill] = RATE_CLASSES[cls];
            if (!takeToken((buckets[cls] ||= {}), cap, refill)) {
                report.count(`rate:${cls}`);
                report.detail(`rate:${userId}:${cls}`, `user ${userId} over the ${cls} socket rate (${event}; ${cap} burst, ${refill}/s; mode=${rateMode})`);
                if (rateMode === "enforce") {
                    reject(packet, "RATE_LIMITED");
                    return;
                }
            }
        }

        // 2. LIVE-48: payload fields.
        if (handled) {
            const guardMode = modeFromEnv("LIVE_SOCKET_GUARD_MODE");
            if (guardMode !== "off") {
                const problem = payloadProblem(event, payload);
                if (problem) {
                    report.count(`invalid:${event}:${problem}`);
                    report.detail(`inv:${userId}:${event}:${problem}`, `user ${userId} sent ${event} with ${problem} (mode=${guardMode})`);
                    if (guardMode === "enforce") {
                        reject(packet, "INVALID_PAYLOAD");
                        return;
                    }
                }
            }
        }
        next();
    };
};
