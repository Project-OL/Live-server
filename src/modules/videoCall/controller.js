import { initiateCallSchema, acceptCallSchema, rejectCallSchema, endCallSchema, heartbeatSchema } from "./validation.js";
import * as videoCallService from "./service.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const initiateCall = async (req, res) => {
    try {
        const body = await initiateCallSchema.validateAsync(req.body);
        const session = await videoCallService.initiateCall({
            callerId: req.userId,
            creatorId: body.creatorId
        });
        return res.status(200).json({ success: true, message: "Call initiated", data: session });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

export const acceptCall = async (req, res) => {
    try {
        const body = await acceptCallSchema.validateAsync(req.body);
        const data = await videoCallService.acceptCall(body.sessionId, req.userId);
        return res.status(200).json({ success: true, message: "Call accepted", data });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

export const rejectCall = async (req, res) => {
    try {
        const body = await rejectCallSchema.validateAsync(req.body);
        const data = await videoCallService.rejectCall(body.sessionId, req.userId);
        return res.status(200).json({ success: true, message: "Call rejected", data });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

export const endCall = async (req, res) => {
    try {
        const body = await endCallSchema.validateAsync(req.body);
        const session = await videoCallService.endCall(body.sessionId, req.userId, body.reason);
        return res.status(200).json({ success: true, message: "Call ended", data: session });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

export const getStatus = async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const session = await videoCallService.getCallStatus(sessionId);
        if (!session) throw new Error("Session not found");
        return res.status(200).json({ success: true, data: session });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

export const heartbeat = async (req, res) => {
    try {
        const body = await heartbeatSchema.validateAsync(req.body);
        videoCallService.heartbeatCache.set(body.sessionId, Date.now());
        return res.status(200).json({ success: true, message: "Heartbeat received" });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

export const livekitWebhook = async (req, res) => {
    try {
        const event = req.body;
        if (event && event.event === 'room_finished' && event.room?.name) {
            const session = await prisma.videoCallSession.findUnique({
                where: { livekitRoom: event.room.name }
            });
            if (session && session.status === "ACTIVE") {
                await videoCallService.endCall(session.id, session.callerId, "ROOM_FINISHED_WEBHOOK");
            }
        }
        return res.status(200).send("OK");
    } catch (error) {
        return res.status(400).send("Error");
    }
};