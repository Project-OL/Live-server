import Joi from "joi";

export const initiateCallSchema = Joi.object({
    creatorId: Joi.string().required(),
});

export const acceptCallSchema = Joi.object({
    sessionId: Joi.string().required(),
});

export const rejectCallSchema = Joi.object({
    sessionId: Joi.string().required(),
});

export const endCallSchema = Joi.object({
    sessionId: Joi.string().required(),
    reason: Joi.string().optional()
});

export const heartbeatSchema = Joi.object({
    sessionId: Joi.string().required()
});

export const translateTextSchema = Joi.object({
    text: Joi.string().required(),
    country: Joi.string().required()
});