import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.LIVEKIT_API_KEY || "devkey";
const apiSecret = process.env.LIVEKIT_API_SECRET || "secret";
const livekitHost = process.env.LIVEKIT_URL || "http://localhost:7880";

export const roomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);

export const generateLivekitToken = async (roomName, participantName, isHost) => {
    const at = new AccessToken(apiKey, apiSecret, {
        identity: participantName,
    });
    
    at.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
    });

    return await at.toJwt();
};

export const closeLivekitRoom = async (roomName) => {
    try {
        await roomService.deleteRoom(roomName);
    } catch (error) {
        console.error(`[LiveKit] Failed to close room ${roomName}:`, error.message);
    }
};
