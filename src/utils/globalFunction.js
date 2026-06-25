import * as CONSTANTS from './constants.js';
import pkg from "@prisma/client";

const { Prisma } = pkg;
import { formatPrismaError } from './prismaErrorFormat.js';

/* =========================================================
   RANDOM NUMBER GENERATOR
========================================================= */
const randomIntFromInterval = (min = 0, max = 100) => {
    return Math.floor(Math.random() * (max - min + 1) + min);
};

/* =========================================================
   DB RESPONSE WRAPPER
========================================================= */
const resultDb = (statusCode = 200, data = null) => ({
    statusCode,
    data,
});

/* =========================================================
   API SUCCESS RESPONSE
========================================================= */
const apiSuccessRes = (
    req,
    res,
    message = CONSTANTS.DATA_NULL,
    data = CONSTANTS.DATA_NULL,
    code = CONSTANTS.ERROR_CODE_ZERO,
    error = CONSTANTS.ERROR_FALSE,
    token,
    currentDate
) => {
    return res.status(200).json({
        success: true,
        message,
        code,
        error,
        data,
        token,
        currentDate
    });
};

/* =========================================================
   API ERROR RESPONSE
========================================================= */
const apiErrorRes = (
    req,
    res,
    message = CONSTANTS.DATA_NULL,
    data = CONSTANTS.DATA_NULL,
    code = CONSTANTS.ERROR_CODE_ONE,
    error = CONSTANTS.ERROR_TRUE,
    httpStatus = 400
) => {
    let finalMessage = message;

    if (
        message instanceof Prisma.PrismaClientValidationError ||
        message instanceof Prisma.PrismaClientKnownRequestError ||
        message instanceof Prisma.PrismaClientInitializationError
    ) {
        finalMessage = formatPrismaError(message);
    }

    return res.status(httpStatus).json({
        success: false,
        message: finalMessage,
        code,
        error,
        data,
    });
};

/* =========================================================
   VALID ID CHECK (PostgreSQL Safe)
   Supports: SERIAL IDs + UUIDs
========================================================= */
const isValidId = (id) => {
    if (!id) return false;

    // Numeric ID
    if (!isNaN(id)) return true;

    // UUID Regex
    const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    return uuidRegex.test(id);
};


/* =========================================================
   REMOVE DUPLICATE OBJECTS FROM ARRAY
========================================================= */
const uniqueArrayOfObj = (array = [], key = 'id') => {
    return [...new Map(array.map((item) => [item[key], item])).values()];
};

/* =========================================================
   ASYNC TRY/CATCH HELPER
========================================================= */
const tryCatch = async (promise) => {
    try {
        const result = await promise;
        return [null, result];
    } catch (error) {
        return [error, null];
    }
};

export {
    resultDb,
    apiSuccessRes,
    apiErrorRes,
    randomIntFromInterval,
    isValidId,
    uniqueArrayOfObj,
    tryCatch
};
