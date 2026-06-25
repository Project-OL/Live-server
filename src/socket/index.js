import { Server } from "socket.io";
import { setupVideoCallSockets } from "../modules/videoCall/socket.js";

let io;

export const initSocket = (server) => {
    io = new Server(server, {
        cors: {
            origin: "*",
            credentials: true,
        },
    });

    setupVideoCallSockets(io);

    io.on("connection", (socket) => {
        console.log("connected", socket.id);

        socket.on("disconnect", () => {
            console.log("disconnected");
        });
    });
};

export const getIO = () => io;