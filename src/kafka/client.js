import { Kafka } from "kafkajs";

export const kafka = new Kafka({
    clientId: "live-app",
    brokers: [process.env.KAFKA_BROKER],
});

export const producer = kafka.producer();

export const consumer = kafka.consumer({
    groupId: "live-group",
});

export const connectKafka = async () => {
    try {
        await producer.connect();
        await consumer.connect();

        console.log("✅ Kafka Connected");
    } catch (error) {
        console.error("❌ Kafka Error", error);
        process.exit(1);
    }
};