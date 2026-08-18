import { initiateCallSchema, acceptCallSchema, rejectCallSchema, endCallSchema, heartbeatSchema, translateTextSchema } from "./validation.js";
import * as videoCallService from "./service.js";
import prisma from "../../config/prisma.js";
import jwt from "jsonwebtoken";

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

export const getCallSettings = async (req, res) => {
    try {
        const creatorId = req.params.creatorId;
        if (!creatorId) throw new Error("Creator ID parameter is required");
        const data = await videoCallService.getCallSettingsForCaller({
            callerId: req.userId,
            creatorId
        });
        return res.status(200).json({ success: true, data });
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

export const getTestUsers = async (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
        const users = await prisma.user.findMany({
            take: limit,
            orderBy: { createdAt: 'asc' }
        });

        users.sort((a, b) => {
            if (a.username === "sahil") return -1;
            if (b.username === "sahil") return 1;
            return a.username.localeCompare(b.username);
        });

        // Non-blocking background batch creation for missing video call settings (Zero DB pool lock)
        setImmediate(async () => {
            try {
                const userIds = users.map(u => u.id);
                const existingSettings = await prisma.videoCallSettings.findMany({
                    where: { userId: { in: userIds } },
                    select: { userId: true }
                });
                const existingUserIds = new Set(existingSettings.map(s => s.userId));
                const missingUserIds = userIds.filter(id => !existingUserIds.has(id));
                if (missingUserIds.length > 0) {
                    await prisma.videoCallSettings.createMany({
                        data: missingUserIds.map(id => ({
                            userId: id,
                            pricePerMin: 1800,
                            blockLv5: false,
                            blockLv10: false
                        })),
                        skipDuplicates: true
                    });
                }
            } catch (syncErr) {
                console.error("[getTestUsers Settings Sync Error]:", syncErr.message);
            }
        });

        const secret = process.env.JWT_SECRET || "fallback_secret";

        const mappedUsers = users.map(u => {
            const token = jwt.sign({ userId: u.id, tokenVersion: 0 }, secret, { expiresIn: '1d' });
            return {
                id: u.id,
                publicId: u.publicId != null ? Number(u.publicId) : null,
                name:"User" + "test production deployment",
                token: token
            };
        });

        return res.status(200).json({
            success: true,
            users: mappedUsers
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

export const resetActiveCalls = async (req, res) => {
    try {
        await prisma.videoCallSession.updateMany({
            where: {
                status: { in: ["RINGING", "ACTIVE"] }
            },
            data: {
                status: "ENDED",
                endedAt: new Date(),
                endReason: "TEST_RESET"
            }
        });
        return res.status(200).json({ success: true, message: "All active call sessions have been reset to ENDED." });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

export const verifyFrame = async (req, res) => {
    try {
        const { sessionId, image } = req.body;
        if (!sessionId || !image) {
            return res.status(400).json({ success: false, message: "sessionId and image fields are required." });
        }

        const result = await videoCallService.verifyCallFrame(sessionId, image);
        return res.status(200).json({ success: true, result });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

export const sendGift = async (req, res) => {
    try {
        const { sessionId, giftId, quantity } = req.body;
        if (!sessionId || !giftId) {
            return res.status(400).json({ success: false, message: "sessionId and giftId are required." });
        }

        const giftCount = Math.max(1, parseInt(quantity || 1, 10));
        const result = await videoCallService.sendGift(sessionId, req.userId, giftId, giftCount);
        return res.status(200).json({
            success: true,
            message: "Gift sent successfully",
            data: {
                newBalance: Number(result.newBalance),
                currentLevel: result.currentLevel,
                isLevelUp: result.isLevelUp
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

export const translateText = async (req, res) => {
    try {
        const body = await translateTextSchema.validateAsync(req.body);
        const country = body.country;
        let targetLanguage = "en";

        const mapping = await prisma.countryLanguageMapping.findFirst({
            where: {
                country: {
                    equals: country,
                    mode: "insensitive"
                }
            }
        });
        if (mapping) {
            targetLanguage = mapping.language;
        }

        const result = await videoCallService.translateText(body.text, targetLanguage);
        return res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

export const getGifts = async (req, res) => {
    try {
        const gifts = await prisma.gift.findMany({
            where: { isActive: true },
            orderBy: { coinCost: "asc" }
        });
        return res.status(200).json({ success: true, data: gifts });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};