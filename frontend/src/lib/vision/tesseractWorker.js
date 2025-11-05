import { createWorker } from 'tesseract.js';

let workerPromise = null;

const initWorker = async () => {
	const worker = await createWorker();

	await worker.setParameters({
		tessedit_pageseg_mode: '7', // PSM 7 (single text line)
		tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',
		preserve_interword_spaces: '1'
	});

	return worker;
};

export const getVisionWorker = async () => {
	if (!workerPromise) {
		workerPromise = initWorker().catch((error) => {
			workerPromise = null;
			throw error;
		});
	}

	return workerPromise;
};

export const recognizeCanvas = async (input) => {
	const worker = await getVisionWorker();
	let payload = input;
	if (typeof input === 'string' && input.startsWith('data:')) {
		const response = await fetch(input);
		payload = await response.blob();
	}
	const { data } = await worker.recognize(payload);
	return {
		text: data?.text ?? '',
		confidence: data?.confidence ?? 0
	};
};

export const terminateVisionWorker = async () => {
	if (!workerPromise) return;

	const worker = await workerPromise.catch(() => null);
	if (worker) {
		await worker.terminate();
	}

	workerPromise = null;
};
