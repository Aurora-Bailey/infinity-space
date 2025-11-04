import { Router } from 'express';
import { analyzeRequestSchema } from '../validators.js';
import { analyzeAndStore } from '../services/analyzer.js';

const router = Router();

router.post('/', async (req, res, next) => {
	try {
		const request = analyzeRequestSchema.parse(req.body ?? {});
		const result = await analyzeAndStore(request);
		return res.json(result);
	} catch (error) {
		if (error.name === 'ZodError') {
			return res.status(400).json({ message: 'Invalid request body', issues: error.issues });
		}
		if (error.status === 404 || error.$metadata?.httpStatusCode === 404) {
			return res.status(404).json({ message: 'Object not found in S3' });
		}
		return next(error);
	}
});

export default router;
