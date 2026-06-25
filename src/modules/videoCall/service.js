import { PrismaClient } from "@prisma/client";
import { emitToUser } from "./socket.js";
import { closeLivekitRoom, generateLivekitToken } from "./livekit.js";

const prisma = new PrismaClient();

// In-memory heartbeat cache: sessionId -> lastPingTimestamp
export const heartbeatCache = new Map();

export const initiateCall = async ({ callerId, creatorId }) => {
    // Phase 4: Validation
    if (callerId === creatorId) throw new Error("You can't call yourself.");

    const creator = await prisma.user.findUnique({ where: { id: creatorId } });
    if (!creator) throw new Error("Receiver not found.");

    const settings = await prisma.videoCallSettings.findUnique({ where: { userId: creatorId } });
    if (!settings) throw new Error("Receiver has not enabled video calls.");

    const callerBusy = await prisma.videoCallSession.findFirst({
        where: { callerId, status: { in: ["RINGING", "ACTIVE"] } }
    });
    if (callerBusy) throw new Error("You are already in an active call.");

    const creatorBusy = await prisma.videoCallSession.findFirst({
        where: { creatorId, status: { in: ["RINGING", "ACTIVE"] } }
    });
    
    if (creatorBusy) {
        // Socket Event: USER_BUSY
        emitToUser(callerId, "USER_BUSY", { creatorId });
        throw new Error("Receiver is currently busy.");
    }

    const livekitRoom = `room_${callerId}_${Date.now()}`;
    
    // Phase 1: DB Entry (Status RINGING)
    const session = await prisma.videoCallSession.create({
        data: {
            callerId,
            creatorId,
            livekitRoom,
            pricePerMin: settings.pricePerMin,
            status: "RINGING"
        }
    });

    // Phase 6: Socket Event CALL_INCOMING
    emitToUser(creatorId, "CALL_INCOMING", {
        sessionId: session.id,
        callerId,
        livekitRoom
    });

    return session;
};

export const acceptCall = async (sessionId, receiverId) => {
    const session = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });
    
    if (!session || session.status !== "RINGING" || session.creatorId !== receiverId) {
        throw new Error("Invalid session or unauthorized.");
    }

    // Phase 10: Update call status to ACTIVE
    const updatedSession = await prisma.videoCallSession.update({
        where: { id: sessionId },
        data: { status: "ACTIVE", startedAt: new Date() }
    });

    // Phase 5: Generate tokens
    const receiverToken = generateLivekitToken(session.livekitRoom, receiverId, true);
    const callerToken = generateLivekitToken(session.livekitRoom, session.callerId, false);

    // Phase 6: Socket Event CALL_ACCEPTED
    emitToUser(session.callerId, "CALL_ACCEPTED", {
        sessionId,
        roomName: session.livekitRoom,
        token: callerToken
    });

    // Phase 8: Start tracking heartbeat
    heartbeatCache.set(sessionId, Date.now());

    return { session: updatedSession, token: receiverToken };
};

export const rejectCall = async (sessionId, receiverId) => {
    const session = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });
    
    if (!session || session.status !== "RINGING" || session.creatorId !== receiverId) {
        throw new Error("Invalid session or unauthorized.");
    }

    await prisma.videoCallSession.update({
        where: { id: sessionId },
        data: { status: "REJECTED", endedAt: new Date(), endReason: "REJECTED_BY_RECEIVER" }
    });

    // Phase 6: Socket Event CALL_REJECTED
    emitToUser(session.callerId, "CALL_REJECTED", { sessionId });
    
    return { success: true };
};

export const endCall = async (sessionId, userId, reason = "USER_ENDED") => {
    const session = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });
    if (!session || !["RINGING", "ACTIVE"].includes(session.status)) return null;

    if (session.callerId !== userId && session.creatorId !== userId) {
        throw new Error("Unauthorized to end this call.");
    }

    const endedAt = new Date();
    let minsCharged = 0;
    let coinsDeducted = 0;

    if (session.status === "ACTIVE") {
        const durationMs = endedAt.getTime() - new Date(session.startedAt).getTime();
        minsCharged = Math.max(1, Math.ceil(durationMs / 60000));
        coinsDeducted = minsCharged * session.pricePerMin;
    }

    // Phase 7: Transition to MISSED if never picked up, otherwise ENDED
    const newStatus = session.status === "RINGING" ? "MISSED" : "ENDED";
    const socketEvent = session.status === "RINGING" ? "CALL_MISSED" : "CALL_ENDED";

    const updatedSession = await prisma.videoCallSession.update({
        where: { id: sessionId },
        data: {
            status: newStatus,
            endedAt,
            endReason: reason,
            minsCharged,
            coinsDeducted
        }
    });

    // Phase 6: Socket Event CALL_ENDED / CALL_MISSED
    const otherUser = session.callerId === userId ? session.creatorId : session.callerId;
    emitToUser(otherUser, socketEvent, { sessionId, reason });

    // Phase 10: Close Room and Cleanup
    await closeLivekitRoom(session.livekitRoom);
    heartbeatCache.delete(sessionId);

    return updatedSession;
};

export const getCallStatus = async (sessionId) => {
    return await prisma.videoCallSession.findUnique({
        where: { id: sessionId },
        select: { id: true, status: true, callerId: true, creatorId: true, startedAt: true }
    });
};

// Phase 8: Auto End Call if Heartbeat is lost
setInterval(async () => {
    const now = Date.now();
    for (const [sessionId, lastPing] of heartbeatCache.entries()) {
        if (now - lastPing > 30000) { // 30 seconds limit
            console.log(`[VideoCall] Heartbeat lost for session ${sessionId}, auto-ending.`);
            heartbeatCache.delete(sessionId);
            
            const session = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });
            if (session && session.status === "ACTIVE") {
                await endCall(sessionId, session.callerId, "HEARTBEAT_LOST");
            }
        }
    }
}, 15000);