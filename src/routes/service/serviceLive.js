import prisma from '../../config/prisma.js';
import crypto from 'crypto';

export const createLiveStreamService = async ({
    userId,
    title
}) => {

    const streamId = crypto.randomUUID();
    const streamKey = crypto.randomBytes(32).toString('hex');

    return prisma.liveStream.create({
        data: {
            userId,
            title,
            streamId,
            streamKey,
            isLive: false
        }
    });
};

export const startLiveStreamService = async ({
    id
}) => {

    return prisma.liveStream.update({
        where: { id },
        data: {
            isLive: true,
            startedAt: new Date()
        }
    });
};

export const endLiveStreamService = async ({
    id
}) => {

    return prisma.liveStream.update({
        where: { id },
        data: {
            isLive: false,
            endedAt: new Date()
        }
    });
};

export const getLiveStreamsService = async () => {

    return prisma.liveStream.findMany({
        where: {
            isLive: true
        },
        orderBy: {
            startedAt: 'desc'
        }
    });
};

export const getLiveStreamService = async ({
    id
}) => {

    return prisma.liveStream.findUnique({
        where: { id }
    });
};