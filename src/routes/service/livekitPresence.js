import { RoomServiceClient } from 'livekit-server-sdk';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
const livekitHost = (process.env.LIVEKIT_URL || 'http://localhost:7880')
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:');

export const livekitRoomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);

/**
 * True when LiveKit room has the host identity present (joined).
 * Missing room / API errors => false.
 */
export const livekitHostIsPresent = async (roomName, hostUserId) => {
    if (!roomName || !hostUserId) return false;
    try {
        const participants = await livekitRoomService.listParticipants(roomName);
        return (participants || []).some((p) => p.identity === hostUserId);
    } catch (_err) {
        return false;
    }
};
