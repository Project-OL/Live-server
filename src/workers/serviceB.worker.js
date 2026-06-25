while (true) {
    const result = await redis.brPop(
        "queue:service-b",
        0
    );

    const payload = JSON.parse(result.element);

    console.log("Request Received", payload);

    await prisma.serviceRequest.update({
        where: {
            id: payload.requestId,
        },
        data: {
            provider: "SERVICE_B",
            status: "completed",
        },
    });
}