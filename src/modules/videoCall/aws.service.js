import { RekognitionClient, DetectModerationLabelsCommand } from "@aws-sdk/client-rekognition";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

dotenv.config();

const client = new RekognitionClient({
    region: process.env.AWS_REGION || "ap-south-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const s3Client = new S3Client({
    region: process.env.AWS_REGION || "ap-south-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

export const uploadFlaggedFrameToS3 = async (buffer, s3Key) => {
    const bucketName = process.env.AWS_S3_BUCKET || "ol-app-storage";
    try {
        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: s3Key,
            Body: buffer,
            ContentType: "image/jpeg",
            CacheControl: "max-age=31536000"
        });
        await s3Client.send(command);
        console.log(`[AWS S3] Uploaded flagged image frame to bucket ${bucketName} at key ${s3Key}`);
        return { success: true, bucket: bucketName, key: s3Key };
    } catch (error) {
        console.error(`[AWS S3] Upload to S3 failed for key ${s3Key}:`, error);
        throw error;
    }
};

export const moderateImage = async (buffer) => {
    try {
        if (process.env.MOCK_MODERATION === "true") {
            return { isViolation: true, label: "Mock Explicit Nudity", confidence: 99.9, action: "BLOCK" };
        }

        const command = new DetectModerationLabelsCommand({
            Image: { Bytes: buffer },
            MinConfidence: 70
        });

        const response = await client.send(command);
        const labels = response.ModerationLabels || [];


        if (labels.length > 0) {
            const labelList = labels.map(l => `${l.Name} (${l.Confidence.toFixed(2)}%)`).join(", ");
            console.log(`[AWS Rekognition] Checked Frame - Moderation Labels found: ${labelList}`);
        } else {
            console.log(`[AWS Rekognition] Checked Frame - Clean (No moderation labels detected)`);
        }

        const blockCategories = ["Explicit Nudity", "Sexual Activity"];

        const violation = labels.find(label =>
            blockCategories.includes(label.Name) || blockCategories.includes(label.ParentName)
        );

        if (violation) {
            const action = violation.Confidence >= 85 ? "BLOCK" : "WARNING";

            return {
                isViolation: true,
                label: violation.Name,
                confidence: violation.Confidence,
                action
            };
        }

        return { isViolation: false };
    } catch (error) {
        console.error("[AWS Rekognition] Moderation error:", error);
        throw error;
    }
};
