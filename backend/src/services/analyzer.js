import { GetObjectCommand } from '@aws-sdk/client-s3';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import OpenAI from 'openai';

import { config } from '../config.js';
import { s3Client } from '../s3.js';
import { dynamo } from '../dynamo.js';
import { neonLog, shorten } from '../logger.js';

const SCHEMA_VERSION = 1;
const UNKNOWN_VALUE = 'UNKNOWN';

const openai = new OpenAI({
	apiKey: config.openaiApiKey
});

const streamToBuffer = async (body) => {
	if (!body) return Buffer.alloc(0);
	if (Buffer.isBuffer(body)) return body;
	if (body instanceof Uint8Array) return Buffer.from(body);
	if (typeof body.arrayBuffer === 'function') {
		const arrayBuffer = await body.arrayBuffer();
		return Buffer.from(arrayBuffer);
	}

	return new Promise((resolve, reject) => {
		const chunks = [];
		body.on('data', (chunk) => chunks.push(chunk));
		body.once('end', () => resolve(Buffer.concat(chunks)));
		body.once('error', reject);
	});
};

const defaultPrompt =
	`You are analyzing a trading card style toy package. ` +
	`Return the following fields (use UNKNOWN if you cannot determine them): car_name (vehicle on the card), series (collection name such as "J-IMPORTS"), batch_code (packaging batch like "JBB55-N9COL G1"), and subset_number (e.g. "4/10"). ` +
	`Also return any supporting text snippets you used in detected_text.`;

const analysisSchema = {
	type: 'object',
	required: ['detected_text', 'car_name', 'series', 'batch_code', 'subset_number'],
	additionalProperties: true,
	properties: {
		detected_text: {
			type: 'array',
			items: { type: 'string' }
		},
		car_name: { type: 'string' },
		series: { type: 'string' },
		batch_code: { type: 'string' },
		subset_number: { type: 'string' }
	}
};

const parseNumber = (value) => {
	if (value === undefined || value === null || value === '') return undefined;
	const num = Number(value);
	return Number.isFinite(num) ? num : undefined;
};

const deepMerge = (target, source) => {
	if (!source) return target;
	const output = Array.isArray(target) ? [...target] : { ...target };
	for (const [key, value] of Object.entries(source)) {
		if (Array.isArray(value)) {
			output[key] = value;
		} else if (value && typeof value === 'object') {
			output[key] = deepMerge(output[key] ?? {}, value);
		} else {
			output[key] = value;
		}
	}
	return output;
};

const createEmptyRecord = (id) => ({
	id,
	item: {
		line: '',
		series: '',
		model: '',
		description: ''
	},
	packaging: {
		global_assortment_number: '',
		subset_number: '',
		guarantee_badge: '',
		card_front_logo: ''
	},
	codes: {
		upc: '',
		assortment: '',
		internal_code: '',
		batch_code: '',
		country_of_origin: '',
		region: ''
	},
	branding: {
		brand: '',
		websites: []
	},
	compliance: {
		age_warning: '',
		standards: [],
		recycling: '',
		warranty: '',
		warnings: []
	},
	vehicle: {
		make: '',
		base_model: '',
		condition: ''
	},
	visual: {
		body_color_primary: {
			norm: '',
			raw: '',
			confidence: 0,
			source: ''
		},
		body_color_secondary: [],
		graphics: {
			style: '',
			text_elements: [],
			locations: []
		},
		wheels: {
			style: '',
			rim_color: '',
			tire_color: '',
			notes: ''
		}
	},
	inventory: {
		location: '',
		status: '',
		owner: ''
	},
	ocr: {
		raw_text: [],
		entities: []
	},
	media: [],
	scan: {
		scan_id: id,
		request_id: '',
		scanned_at: ''
	},
	extra: {
		raw_front: {},
		raw_back: {},
		raw_other: {}
	},
	meta: {
		schema_version: SCHEMA_VERSION,
		created_at: '',
		updated_at: ''
	}
});

const ensurePlaceholder = (record, path) => {
	let cursor = record;
	for (let i = 0; i < path.length - 1; i += 1) {
		const segment = path[i];
		if (!cursor || typeof cursor !== 'object') return;
		cursor = cursor[segment];
	}
	const last = path[path.length - 1];
	if (cursor && typeof cursor[last] === 'string' && cursor[last].trim() === '') {
		cursor[last] = UNKNOWN_VALUE;
	}
};

const ensurePlaceholders = (record) => {
	const placeholderPaths = [
		['item', 'line'],
		['item', 'series'],
		['item', 'model'],
		['item', 'description'],
		['packaging', 'global_assortment_number'],
		['packaging', 'subset_number'],
		['packaging', 'guarantee_badge'],
		['packaging', 'card_front_logo'],
		['codes', 'upc'],
		['codes', 'assortment'],
		['codes', 'internal_code'],
		['codes', 'batch_code'],
		['codes', 'country_of_origin'],
		['codes', 'region'],
		['branding', 'brand'],
		['compliance', 'age_warning'],
		['compliance', 'recycling'],
		['compliance', 'warranty'],
		['vehicle', 'make'],
		['vehicle', 'base_model'],
		['vehicle', 'condition'],
		['inventory', 'location'],
		['inventory', 'status'],
		['scan', 'request_id'],
		['scan', 'scanned_at']
	];

	placeholderPaths.forEach((path) => ensurePlaceholder(record, path));
};

export const analyzeAndStore = async (
	{
		key,
		scan,
		prompt,
		camera = 1,
		timestamp,
		contentType = 'image/png',
		extra = {},
		fileName
	},
	{ onStatus } = {}
) => {
	const shortKey = shorten(key, 40);
	const shortScan = shorten(scan, 36);
	const emit = (event, message, data = {}) => {
		if (typeof onStatus === 'function') {
			onStatus(event, message, data);
		}
	};

	emit('analysis.started', 'Analysis queued', { scan, key, fileName });

	let object;
	try {
		emit('analysis.s3.fetch.start', `Fetching ${shorten(key, 48)} from S3`, { scan, key });
		object = await s3Client.send(
			new GetObjectCommand({
				Bucket: config.bucket,
				Key: key
			})
		);
		neonLog('S3', 'success', `get key=${shortKey}`);
		emit('analysis.s3.fetch.success', 'Fetched object from S3', { scan, key });
	} catch (error) {
		neonLog('S3', 'fail', `get key=${shortKey}`);
		emit('analysis.s3.fetch.error', 'Unable to retrieve S3 object', { scan, key, error: error.message ?? String(error) });
		throw error;
	}

	if (!object.Body) {
		neonLog('S3', 'fail', `body key=${shortKey}`);
		const error = new Error('Object body not found');
		error.status = 404;
		emit('analysis.s3.fetch.error', 'S3 object had no body', { scan, key });
		throw error;
	}

	const buffer = await streamToBuffer(object.Body);
	const imageBase64 = buffer.toString('base64');
	const metadata = object.Metadata ?? {};
	const resolvedCamera = camera ?? parseNumber(metadata.camera);
	const resolvedTimestamp = timestamp ?? parseNumber(metadata.timestamp);
	const resolvedContentType = contentType ?? object.ContentType ?? metadata['content-type'] ?? 'image/png';

	const userPrompt = prompt ?? defaultPrompt;

	let response;
	try {
		emit('analysis.ai.request', 'Running OpenAI vision analysis', { scan, key });
		response = await openai.responses.create({
			model: config.openaiModel,
			text: {
				format: {
					type: 'json_schema',
					name: 'image_analysis',
					schema: analysisSchema,
					strict: false
				}
			},
			input: [
				{
					role: 'user',
					content: [
						{
							type: 'input_text',
							text: userPrompt
						},
						{
							type: 'input_image',
							image_url: `data:${resolvedContentType};base64,${imageBase64}`,
							detail: 'auto'
						}
					]
				}
			]
		});
		emit('analysis.ai.success', 'OpenAI analysis complete', {
			scan,
			key,
			responseId: response.id
		});
		neonLog('AI', 'success', `analysis key=${shortKey} id=${shorten(response.id, 18)}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'unknown';
		neonLog('AI', 'fail', `analysis key=${shortKey} err=${shorten(message, 28)}`);
		emit('analysis.ai.error', 'OpenAI analysis failed', { scan, key, error: message });
		throw error;
	}

	const outputText = response.output_text ?? '';
	let parsedAnalysis =
		response.output_parsed ??
		response.output?.flatMap((item) =>
			item?.content
				?.map((content) => {
					if (content?.parsed) return content.parsed;
					if (typeof content?.text === 'string') {
						try {
							return JSON.parse(content.text);
						} catch {
							return null;
						}
					}
					return null;
				})
				.filter(Boolean) ?? []
		)?.[0] ??
		null;

	if (!parsedAnalysis && outputText) {
		try {
			parsedAnalysis = JSON.parse(outputText);
		} catch (error) {
			parsedAnalysis = null;
		}
	}

	const detectedText = Array.isArray(parsedAnalysis?.detected_text)
		? parsedAnalysis.detected_text.map((text) => (typeof text === 'string' ? text : '')).filter(Boolean)
		: [];

	const analysisFields = {
		carName: parsedAnalysis?.car_name?.trim() || '',
		series: parsedAnalysis?.series?.trim() || '',
		batchCode: parsedAnalysis?.batch_code?.trim() || '',
		subsetNumber: parsedAnalysis?.subset_number?.trim() || '',
		detectedText
	};

	let existingRecord = null;
	try {
		const existing = await dynamo.send(
			new GetCommand({
				TableName: config.dynamoTable,
				Key: { id: scan }
			})
		);
		existingRecord = existing.Item ?? null;
	} catch (error) {
		const message = error instanceof Error ? error.message : 'unknown';
		neonLog('DB', 'fail', `fetch scan=${shortScan} err=${shorten(message, 28)}`);
		throw error;
	}

	let record = createEmptyRecord(scan);
	if (existingRecord) {
		record = deepMerge(record, existingRecord);
	}

	const nowIso = new Date().toISOString();
	const additionalText = Array.isArray(parsedAnalysis?.additional_text) ? parsedAnalysis.additional_text : [];
	const textPool = Array.from(
		new Set([...(record.ocr?.raw_text ?? []), ...analysisFields.detectedText, ...additionalText])
	);
	record.ocr.raw_text = textPool;

	const entityMap = new Map((record.ocr.entities ?? []).map((entity) => [entity.text, entity]));
	analysisFields.detectedText.forEach((text) => {
		if (!text || entityMap.has(text)) return;
		entityMap.set(text, {
			category: '',
			text,
			confidence: null,
			side: ''
		});
	});
	record.ocr.entities = Array.from(entityMap.values());

	const findTextMatch = (regex) => {
		for (const text of textPool) {
			if (!text) continue;
			const match = text.match(regex);
			if (match) return match[0];
		}
		return '';
	};

	const findMultipleMatches = (regex) => {
		const matches = new Set();
		textPool.forEach((text) => {
			if (!text) return;
			const found = text.match(regex);
			if (found) {
				found.forEach((entry) => matches.add(entry));
			}
		});
		return Array.from(matches);
	};

	const subsetMatches = findMultipleMatches(/\b(\d{1,2})\/(\d{1,2})\b/g);
	const subsetNumber =
		analysisFields.subsetNumber && analysisFields.subsetNumber !== 'UNKNOWN'
			? analysisFields.subsetNumber
			: subsetMatches.find((match) => {
				const [, denom] = match.split('/');
				return Number(denom) <= 50;
			}) ?? '';

	const batchCode =
		(analysisFields.batchCode && analysisFields.batchCode !== 'UNKNOWN' ? analysisFields.batchCode : '') ||
		findTextMatch(/[A-Z0-9]{2,}-[A-Z0-9]+(?:\s?[A-Z0-9]+)*/);

	const carName =
		analysisFields.carName && analysisFields.carName !== 'UNKNOWN' ? analysisFields.carName : '';

	const series =
		analysisFields.series && analysisFields.series !== 'UNKNOWN'
			? analysisFields.series
			: textPool.find((text) => /[A-Z]-[A-Z]/.test(text) || text.toUpperCase().includes('IMPORTS')) ?? '';

	if (carName && (!record.item.model || record.item.model === UNKNOWN_VALUE)) {
		record.item.model = carName;
	}

	if (series && (!record.item.series || record.item.series === UNKNOWN_VALUE)) {
		record.item.series = series;
	}

	if (batchCode && (!record.codes.batch_code || record.codes.batch_code === UNKNOWN_VALUE)) {
		record.codes.batch_code = batchCode;
	}

	if (subsetNumber && (!record.packaging.subset_number || record.packaging.subset_number === UNKNOWN_VALUE)) {
		record.packaging.subset_number = subsetNumber;
	}

	const sideMap = {
		1: 'front',
		2: 'back'
	};
	const mediaSide = sideMap[resolvedCamera] ?? `cam-${resolvedCamera}`;

	const capturedIso =
		typeof resolvedTimestamp === 'number'
			? new Date(resolvedTimestamp).toISOString()
			: resolvedTimestamp && !Number.isNaN(Number(resolvedTimestamp))
				? new Date(Number(resolvedTimestamp)).toISOString()
				: typeof timestamp === 'number'
					? new Date(timestamp).toISOString()
					: new Date().toISOString();

	const mediaEntry = {
		side: mediaSide,
		file_name: fileName ?? extra?.fileName ?? '',
		s3_key: key,
		content_type: resolvedContentType,
		captured_at: capturedIso,
		source_model: config.openaiModel,
		confidence: 0
	};

	const existingMedia = record.media ?? [];
	if (!existingMedia.some((media) => media.s3_key === key)) {
		record.media = [...existingMedia, mediaEntry];
	}

	record.scan.scan_id = scan;
	if (!record.scan.scanned_at || record.scan.scanned_at === UNKNOWN_VALUE) {
		record.scan.scanned_at = capturedIso;
	}
	if (!record.scan.request_id || record.scan.request_id === UNKNOWN_VALUE) {
		record.scan.request_id =
			metadata['request-id'] ||
			metadata['x-amz-meta-request-id'] ||
			extra?.requestId ||
			UNKNOWN_VALUE;
	}

	record.meta.created_at = record.meta.created_at || nowIso;
	record.meta.updated_at = nowIso;
	record.meta.schema_version = SCHEMA_VERSION;

	const rawTargetKey = resolvedCamera === 2 ? 'raw_back' : resolvedCamera === 1 ? 'raw_front' : 'raw_other';
	if (!record.extra[rawTargetKey] || typeof record.extra[rawTargetKey] !== 'object') {
		record.extra[rawTargetKey] = {};
	}
	record.extra[rawTargetKey] = parsedAnalysis ?? {};
	record.extra.raw_response = {
		id: response.id,
		model: config.openaiModel,
		output: parsedAnalysis,
		raw_text: outputText
	};
	if (extra?.finalUrl) {
		record.extra.finalUrl = extra.finalUrl;
	}

	const obsoleteTopLevelKeys = [
		'analysis',
		'analysisSummary',
		'detectedText',
		'dominantColors',
		'objects',
		'vehicleInsights',
		'warnings',
		'environment',
		'raw',
		'camera',
		'capturedAt',
		'contentType',
		's3Key',
		'scanId',
		'responseId',
		'updatedAt',
		'model',
		'extraMetadata',
		's3Metadata'
	];
	obsoleteTopLevelKeys.forEach((keyName) => {
		if (keyName in record) {
			delete record[keyName];
		}
	});

	ensurePlaceholders(record);

	try {
		emit('analysis.db.write', 'Saving analysis to DynamoDB', { scan, key });
		await dynamo.send(
			new PutCommand({
				TableName: config.dynamoTable,
				Item: record
			})
		);
		emit('analysis.db.success', 'Analysis record saved', { scan, key });
		neonLog('DB', 'success', `put scan=${shortScan} key=${shortKey}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'unknown';
		neonLog('DB', 'fail', `put scan=${shortScan} err=${shorten(message, 28)}`);
		emit('analysis.db.error', 'Failed to save analysis record', { scan, key, error: message });
		throw error;
	}

	emit('analysis.completed', 'Analysis complete', { scan, key });

	return {
		id: scan,
		key,
		scan,
		model: config.openaiModel,
		responseId: response.id,
		record,
		analysis: parsedAnalysis,
		raw: outputText,
		storedAt: nowIso
	};
};
