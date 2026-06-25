import Joi from 'joi';

export const createLiveSchema = Joi.object({
    title: Joi.string().trim().required()
});