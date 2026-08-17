import fs from 'fs';
import path from 'path';
import { EgressClient } from 'livekit-server-sdk';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
const livekitHost = process.env.LIVEKIT_URL || 'http://localhost:7880';

const egressClient = new EgressClient(livekitHost, apiKey, apiSecret);

export const cleanOldHlsSegmentsService = (roomName, maxAgeSeconds = 20) => {
    const dir = `/var/www/hls/streams/${roomName}`;
    if (!fs.existsSync(dir)) return;

    try {
        const files = fs.readdirSync(dir);
        const now = Date.now();
        files.forEach(file => {
            if (file.endsWith('.m4s') || file.endsWith('.ts')) {
                const filePath = path.join(dir, file);
                const stats = fs.statSync(filePath);
                const ageSeconds = (now - stats.mtimeMs) / 1000;
                if (ageSeconds > maxAgeSeconds) {
                    fs.unlinkSync(filePath);
                }
            }
        });
    } catch (err) {
        console.error(`[HLS Cleanup Error] Failed to clean ${roomName}:`, err.message);
    }
};

export const removeHlsStreamDirService = (roomName) => {
    const dir = `/var/www/hls/streams/${roomName}`;
    if (fs.existsSync(dir)) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`[HLS Directory Cleanup] Removed HLS folder for room ${roomName}`);
        } catch (err) {
            console.error(`[HLS Directory Cleanup Error] ${roomName}:`, err.message);
        }
    }
};

export const startLocalHlsEgressService = async (roomName) => {
    try {
        const output = {
            protocol: 4, // HLS_PROTOCOL
            filenamePrefix: `/var/www/hls/streams/${roomName}/segment`,
            playlistName: "live.m3u8",
            livePlaylistName: "live.m3u8",
            segmentDuration: 1 // 1-second ultra LL-HLS chunks
        };
        const egressInfo = await egressClient.startRoomCompositeEgress(roomName, { segments: output });
        console.log(`[LiveKit LL-HLS Egress] Started local LL-HLS egress ${egressInfo.egressId} for room ${roomName}`);

        // 🟢 Auto-cleaner: Runs every 10s to remove .m4s files older than 20 seconds
        const intervalId = setInterval(() => {
            cleanOldHlsSegmentsService(roomName, 20);
        }, 10000);

        // Store interval ID in global map for cleanup
        if (!global.hlsCleanerIntervals) global.hlsCleanerIntervals = new Map();
        global.hlsCleanerIntervals.set(roomName, intervalId);

        return egressInfo.egressId;
    } catch (err) {
        console.error(`[LiveKit LL-HLS Egress Error] Failed to start egress for ${roomName}:`, err.message);
        return null;
    }
};

export const stopLocalHlsEgressService = async (egressId, roomName) => {
    if (roomName && global.hlsCleanerIntervals && global.hlsCleanerIntervals.has(roomName)) {
        clearInterval(global.hlsCleanerIntervals.get(roomName));
        global.hlsCleanerIntervals.delete(roomName);
    }

    if (!egressId) {
        if (roomName) removeHlsStreamDirService(roomName);
        return;
    }

    try {
        await egressClient.stopEgress(egressId);
        console.log(`[LiveKit Egress] Stopped local HLS egress ${egressId}`);
    } catch (err) {
        console.error(`[LiveKit Egress Error] Failed to stop egress ${egressId}:`, err.message);
    } finally {
        if (roomName) removeHlsStreamDirService(roomName);
    }
};
