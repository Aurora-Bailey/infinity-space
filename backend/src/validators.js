import { z } from 'zod';
import { config } from './config.js';

const timestampSchema = z
	.union([z.number().int().nonnegative(), z.string().min(1)])
	.transform((value) => {
		if (typeof value === 'number') return value;
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) {
			throw new Error('Invalid timestamp');
		}
		return parsed;
	});

export const uploadRequestSchema = z.object({
	fileName: z.string().min(1).regex(/^[\w.\-]+$/, 'fileName must be a safe filename'),
	contentType: z.string().min(1),
	scan: z.string().min(1),
	camera: z.number().int().positive(),
	timestamp: timestampSchema.optional()
});

export const buildKey = ({ fileName }) => {
	const prefix = config.keyPrefix;
	return prefix ? `${prefix.replace(/\/?$/, '/')}${fileName}` : fileName;
};
