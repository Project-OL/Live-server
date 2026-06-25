await redis.lPush(
    "queue:service-b",
    JSON.stringify({
        requestId,
        userId,
        serviceId,
    })
);