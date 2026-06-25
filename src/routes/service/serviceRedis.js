import { client } from "../../config/redis.js";

export const getKey = async (key) => {
    return await client.get(key);
};

export const setKey = async (key, value) => {
    await client.set(key, JSON.stringify(value), {
        EX: 600,
    });
};

export const removeKey = async (key) => {
    await client.del(key);
};