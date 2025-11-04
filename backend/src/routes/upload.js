import { Router } from 'express';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { s3Client } from '../s3.js';
import { buildKey, uploadRequestSchema, uploadCompleteSchema } from '../validators.js';
import { analyzeAndStore } from '../services/analyzer.js';
import { neonLog, shorten } from '../logger.js';

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
			neonLog('S3', 'success', `presign key=${shorten(key, 40)}`);
			return res.json({
				url,
				fields,
				finalUrl,
				expiresIn: ttl,
				key
			});
		} catch (error) {
			if (error instanceof Error && 'message' in error) {
				const key =
					typeof req.body?.fileName === 'string' ? buildKey({ fileName: req.body.fileName }) : '';
				neonLog('S3', 'fail', `presign key=${shorten(key, 40)} err=${shorten(error.message, 40)}`);
			} else {
				neonLog('S3', 'fail', 'presign key=unknown err=unknown');
			}
			if (error.name === 'ZodError') {
				return res.status(400).json({ message: 'Invalid request body', issues: error.issues });
			}
			return next(error);
		}
});

	router.post('/complete', async (req, res, next) => {
		try {
			const payload = uploadCompleteSchema.parse(req.body ?? {});
			const result = await analyzeAndStore(payload);
			neonLog('AI', 'success', `complete scan=${shorten(payload.scan, 32)} key=${shorten(payload.key, 32)}`);
			return res.json(result);
		} catch (error) {
			if (error.name === 'ZodError') {
				return res.status(400).json({ message: 'Invalid request body', issues: error.issues });
			}
			if (error.status === 404 || error.$metadata?.httpStatusCode === 404) {
				return res.status(404).json({ message: 'Object not found in S3' });
			}
			if (error instanceof Error && 'message' in error) {
				const scan = req.body?.scan ?? 'unknown';
				const key = req.body?.key ?? 'unknown';
				neonLog(
					'AI',
					'fail',
					`complete scan=${shorten(scan, 32)} err=${shorten(error.message, 28)}`
				);
			} else {
				neonLog('AI', 'fail', 'complete scan=unknown key=unknown');
			}
			return next(error);
		}
	});

export default router;
