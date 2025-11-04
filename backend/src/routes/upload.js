import { Router } from 'express';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { s3Client } from '../s3.js';
import { buildKey, uploadRequestSchema } from '../validators.js';

const router = Router();

const randomSuffix = () => crypto.randomBytes(4).toString('hex');

router.post('/', async (req, res, next) => {
	try {
		const data = uploadRequestSchema.parse(req.body ?? {});
		const keyBase = buildKey(data);
		const key = keyBase.replace(/\.(png|jpg|jpeg|gif|webp)$/i, (match) => match.toLowerCase());

		const ttl = Math.max(1, Math.min(config.presignTtl, 900)); // S3 max 15 minutes
		const maxSize = config.maxUploadBytes;
		const { url, fields } = await createPresignedPost(s3Client, {
			Bucket: config.bucket,
			Key: key,
			Expires: ttl,
			Conditions: [
				['content-length-range', 0, maxSize],
				['starts-with', '$Content-Type', data.contentType.split('/')[0]],
				['starts-with', '$key', key.replace(/\.[^.]+$/, '')]
			],
			Fields: {
				'Content-Type': data.contentType,
				'x-amz-meta-scan': data.scan,
				'x-amz-meta-camera': String(data.camera),
				'x-amz-meta-timestamp': String(data.timestamp ?? Date.now()),
				'x-amz-meta-request-id': randomSuffix()
			}
		});

		const finalUrl = `https://${config.bucket}.s3.${config.awsRegion}.amazonaws.com/${key}`;
		return res.json({
			url,
			fields,
			finalUrl,
			expiresIn: ttl,
			key
		});
	} catch (error) {
		if (error.name === 'ZodError') {
			return res.status(400).json({ message: 'Invalid request body', issues: error.issues });
		}
		return next(error);
	}
});

export default router;
