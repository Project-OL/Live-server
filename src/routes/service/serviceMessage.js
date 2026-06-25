import prisma from '../../config/prisma.js';
import crypto from 'crypto';

export const sendMessageService = async ({
    streamId,
    senderId,
    message
}) => {

    return prisma.liveMessage.create({
        data: {
            streamId,
            senderId,
            message
        }
    });
};

export const getMessagesService = async ({
    streamId
}) => {

    return prisma.liveMessage.findMany({
        where: {
            streamId
        },
        orderBy: {
            createdAt: 'asc'
        },
        take: 100
    });
};

export const joinStreamService = async ({
    streamId,
    userId
}) => {

    return prisma.streamViewer.create({
        data: {
            streamId,
            userId
        }
    });
};

export const leaveStreamService = async ({
    streamId,
    userId
}) => {

    return prisma.streamViewer.deleteMany({
        where: {
            streamId,
            userId
        }
    });
};

export const getViewerCountService = async ({
    streamId
}) => {

    return prisma.streamViewer.count({
        where: {
            streamId
        }
    });
};