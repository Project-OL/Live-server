import pkg from "@prisma/client";

const { Prisma } = pkg;

export function formatPrismaError(error) {
    if (error instanceof Prisma.PrismaClientValidationError) {
        const match = error.message.match(/Argument `(\w+)`:\s*Invalid value provided\.\s*(.*?)(?=\n|$)/);
        if (match) {
            return `Invalid value for '${match[1]}': ${match[2]}`;
        }
        return error.message.split('\n')[0];
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') return `Duplicate value for ${error.meta?.target}`;
        if (error.code === 'P2025') return 'Record not found';
        return error.message;
    }

    if (error instanceof Prisma.PrismaClientInitializationError) {
        return 'Database connection failed';
    }

    return error.message;
}