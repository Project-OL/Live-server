export const userSockets = new Map();
let ioInstance = null;

export const setupVideoCallSockets = (io) => {
    ioInstance = io;
    io.on("connection", (socket) => {
        // Authenticate socket connection
        const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;
        if (userId) {
            userSockets.set(userId, socket.id);
            console.log(`[VideoCall] User connected: ${userId}`);
        }

        socket.on("disconnect", () => {
            if (userId) {
                userSockets.delete(userId);
                console.log(`[VideoCall] User disconnected: ${userId}`);
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
};
