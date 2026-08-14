import { Server } from "socket.io";
import { setupVideoCallSockets } from "../modules/videoCall/socket.js";
import { setupLiveSockets } from "../routes/service/socket-live-service.js";

let io;

export const initSocket = (server) => {
    io = new Server(server, {
        cors: {
            origin: "*",
            credentials: true,
        },
    });

    setupVideoCallSockets(io);
    setupLiveSockets(io);

    io.on("connection", (socket) => {
        console.log("connected", socket.id);

        socket.on("disconnect", () => {
            console.log("disconnected");
        });
    });
};

export const getIO = () => io;