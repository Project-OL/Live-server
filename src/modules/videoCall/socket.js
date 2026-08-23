import { getBannedWords, censorTextWithFuzzyMatch } from "../../utils/censor.js";

export const userSockets = new Map();
let ioInstance = null;

export const setupVideoCallSockets = (io) => {
    ioInstance = io;
    io.on("connection", (socket) => {
        const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;
        if (userId) {
            userSockets.set(userId, socket.id);
        }

        socket.on("SEND_MESSAGE", async ({ receiverId, text, wealthLevel }) => {
            if (!userId || !receiverId) return;
            
            const bannedWords = await getBannedWords();
            const filteredText = censorTextWithFuzzyMatch(text, bannedWords);

            emitToUser(receiverId, "RECEIVE_MESSAGE", {
                senderId: userId,
                text: filteredText,
                wealthLevel: wealthLevel || 0,
                timestamp: new Date().toISOString()
            });
        });

        socket.on("disconnect", () => {
            if (userId) {
                userSockets.delete(userId);
            }
        });
    });
};

export const emitToUser = (userId, eventName, data) => {
    if (!ioInstance) return;
    const socketId = userSockets.get(userId);
    if (socketId) {
        ioInstance.to(socketId).emit(eventName, data);
    }
    if (userId) {
        ioInstance.to(`user:${userId}`).emit(eventName, data);
    }
};
