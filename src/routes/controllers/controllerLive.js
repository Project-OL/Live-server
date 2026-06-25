import express from 'express';

import { createLiveSchema } from '../../validations/validationLive.js';
import {
    createLiveStreamService,
    startLiveStreamService,
    endLiveStreamService,
    getLiveStreamsService,
    getLiveStreamService
} from '../service/serviceLive.js';

const router = express.Router();


const createLiveStream = async (req, res) => {

    try {

        const value = await createLiveSchema.validateAsync(req.body);

        const data = await createLiveStreamService({
            userId: req.user.id,
            title: value.title
        });

        return res.status(201).json({
            success: true,
            data
        });

    } catch (error) {

        return res.status(400).json({
            success: false,
            message: error.message
        });

    }
};

const startLiveStream = async (req, res) => {

    try {

        const data = await startLiveStreamService({
            id: req.params.id
        });

        return res.json({
            success: true,
            data
        });

    } catch (error) {

        return res.status(400).json({
            success: false,
            message: error.message
        });

    }
};

const endLiveStream = async (req, res) => {

    try {

        const data = await endLiveStreamService({
            id: req.params.id
        });

        return res.json({
            success: true,
            data
        });

    } catch (error) {

        return res.status(400).json({
            success: false,
            message: error.message
        });

    }
};

const getLiveStreams = async (req, res) => {

    const data = await getLiveStreamsService();

    return res.json({
        success: true,
        data
    });
};

const getLiveStream = async (req, res) => {

    const data = await getLiveStreamService({
        id: req.params.id
    });

    return res.json({
        success: true,
        data
    });
};



router.post('/create', createLiveStream);
router.post('/start/:id', startLiveStream);
router.post('/end/:id', endLiveStream);
router.get('/list', getLiveStreams);
router.get('/:id', getLiveStream);
// router.post('/:streamId/join', joinStream);
// router.post('/:streamId/leave', leaveStream);
// router.post('/:streamId/message', sendMessage);
// router.get('/:streamId/messages', getMessages);

export default router;