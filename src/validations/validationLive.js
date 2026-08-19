import Joi from 'joi';

export const createLiveSchema = Joi.object({
    title: Joi.string().trim().required(),
    heading: Joi.string().trim().required(),
    isCameraOn: Joi.boolean().optional().allow(null, '')
}).unknown(true);

export const sendMessageSchema = Joi.object({
    message: Joi.string().trim().min(1).max(500).required(),
    replyToMessageId: Joi.string().optional().allow(null, ''),
    replyToUserId: Joi.string().optional().allow(null, ''),
    replyToUsername: Joi.string().optional().allow(null, ''),
    replyToText: Joi.string().optional().allow(null, '')
});