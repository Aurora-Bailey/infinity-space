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
	`You are analyzing an image captured at a warehouse intake station. ` +
	`Extract every piece of usable information, including readable text, signage, ` +
	`hazard markers, device states, and user interface alerts. Identify objects, ` +
	`vehicles (type, color, estimated age/condition if inferable), and notable colors. ` +
	`Describe environmental context (lighting, time of day cues, location hints) and highlight ` +
	`anything that could require human attention. Populate optional fields with your best inference ` +
	`or leave them empty if you cannot determine a value.`;

const analysisSchema = {
	type: 'object',
	required: ['detected_text', 'summary'],
	additionalProperties: false,
	properties: {
		detected_text: {
			type: 'array',
			items: {
				type: 'object',
				required: ['text'],
				additionalProperties: false,
				properties: {
					text: { type: 'string' },
					confidence: { type: 'number' },
					category: { type: 'string' },
					location: { type: 'string' }
				}
			}
		},
		summary: {
			type: 'string',
			description: 'High-level description of the image and its purpose'
		},
		observations: {
			type: 'array',
			items: { type: 'string' }
		},
		dominant_colors: {
			type: 'array',
			items: {
				type: 'object',
				required: ['name'],
				additionalProperties: false,
				properties: {
					name: { type: 'string' },
					hex: { type: 'string' },
					usage: { type: 'string' }
				}
			}
		},
		objects: {
			type: 'array',
			items: {
				type: 'object',
				required: ['label'],
				additionalProperties: false,
				properties: {
					label: { type: 'string' },
					confidence: { type: 'number' },
					attributes: {
						type: 'array',
						items: { type: 'string' }
					}
				}
			}
		},
		vehicle_insights: {
			type: 'array',
			items: {
				type: 'object',
				required: ['description'],
				additionalProperties: false,
				properties: {
					description: { type: 'string' },
					type: { type: 'string' },
					color: { type: 'string' },
					estimated_age: { type: 'string' },
					condition: { type: 'string' },
					license_plate: { type: 'string' }
				}
			}
		},
		environment: {
			type: 'object',
			additionalProperties: false,
			properties: {
				location_type: { type: 'string' },
				lighting: { type: 'string' },
				weather: { type: 'string' },
				notes: { type: 'string' }
			}
		},
		warnings: {
			type: 'array',
			items: { type: 'string' }
		}
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

const setIfPresent = (object, path, value) => {
	if (value === undefined || value === null || value === '') return;
	let cursor = object;
	for (let i = 0; i < path.length - 1; i += 1) {
		const segment = path[i];
		if (!cursor[segment] || typeof cursor[segment] !== 'object') {
			cursor[segment] = {};
		}
		cursor = cursor[segment];
	}
	cursor[path[path.length - 1]] = value;
};

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
		['visual', 'body_color_primary', 'norm'],
		['visual', 'body_color_primary', 'raw'],
		['visual', 'graphics', 'style'],
	['inventory', 'location'],
	['inventory', 'status'],
	['inventory', 'owner'],
	['scan', 'request_id'],
	['scan', 'scanned_at']
];

	placeholderPaths.forEach((path) => ensurePlaceholder(record, path));
};

export const analyzeAndStore = async ({
	key,
	scan,
	prompt,
	camera,
	timestamp,
	contentType,
	extra
}) => {
	const shortKey = shorten(key, 40);
	const shortScan = shorten(scan, 36);

	let object;
	try {
		object = await s3Client.send(
			new GetObjectCommand({
				Bucket: config.bucket,
				Key: key
			})
		);
		neonLog('S3', 'success', `get key=${shortKey}`);
	} catch (error) {
		neonLog('S3', 'fail', `get key=${shortKey}`);
		throw error;
	}

	if (!object.Body) {
		neonLog('S3', 'fail', `body key=${shortKey}`);
		const error = new Error('Object body not found');
		error.status = 404;
		throw error;
	}

	const buffer = await streamToBuffer(object.Body);
	const imageBase64 = buffer.toString('base64');

	const metadata = object.Metadata ?? {};
	const resolvedCamera = camera ?? parseNumber(metadata.camera);
	const resolvedTimestamp = timestamp ?? parseNumber(metadata.timestamp);
	const resolvedContentType = contentType ?? object.ContentType ?? metadata['content-type'];

	const userPrompt = prompt ?? defaultPrompt;

	let response;
	try {
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
							image_url: `data:${resolvedContentType ?? 'image/png'};base64,${imageBase64}`,
							detail: 'auto'
						}
					]
				}
			]
		});
		neonLog('AI', 'success', `analysis key=${shortKey} id=${shorten(response.id, 18)}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'unknown';
		neonLog('AI', 'fail', `analysis key=${shortKey} err=${shorten(message, 28)}`);
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

	const detectVehicleDetails = (analysis) => {
		const placeholder = {
			name: 'UNKNOWN',
			model_code: 'UNKNOWN',
			series: 'UNKNOWN'
		};

		if (!analysis || typeof analysis !== 'object') return placeholder;

		if (Array.isArray(analysis.vehicle_insights) && analysis.vehicle_insights.length > 0) {
			for (const insight of analysis.vehicle_insights) {
				if (!insight || typeof insight !== 'object') continue;
				if (insight.name || insight.model_code || insight.series) {
					return {
						name: insight.name ?? placeholder.name,
						model_code: insight.model_code ?? placeholder.model_code,
						series: insight.series ?? placeholder.series
					};
				}
				if (insight.description) {
					const description = String(insight.description);
					const parts = description.split(/[,|;-]/).map((p) => p.trim()).filter(Boolean);
					if (parts.length) {
						return {
							name: parts[0] ?? placeholder.name,
							model_code: parts[1] ?? placeholder.model_code,
							series: parts[2] ?? placeholder.series
						};
					}
				}
			}
		}

		return placeholder;
	};

	const extractAttributes = (analysis) => {
		if (!analysis || typeof analysis !== 'object') {
			return {
				summary: null,
				detectedText: [],
				detectedTextEntities: [],
				dominantColors: [],
				objects: [],
				vehicleInsights: [],
				warnings: [],
				environment: null,
				vehicle: detectVehicleDetails(analysis)
			};
		}

		const detectedTextEntities = Array.isArray(analysis.detected_text)
			? analysis.detected_text
					.map((entry) => {
						if (!entry) return null;
						if (typeof entry === 'string') {
							return {
								category: '',
								text: entry,
								confidence: null,
								side: ''
							};
						}
						if (typeof entry === 'object' && 'text' in entry) {
							return {
								category: entry.category ?? '',
								text: entry.text ?? '',
								confidence: entry.confidence ?? null,
								side: entry.location ?? entry.side ?? ''
							};
						}
						return null;
					})
					.filter((entity) => entity && entity.text)
			: [];

		const detectedText = detectedTextEntities.map((entity) => entity.text).filter(Boolean);

		const dominantColors = Array.isArray(analysis.dominant_colors)
			? analysis.dominant_colors
					.map((color) => {
						if (!color || typeof color !== 'object') return null;
						return {
							name: color.name ?? null,
							hex: color.hex ?? null,
							usage: color.usage ?? null,
							confidence: color.confidence ?? null
						};
					})
					.filter(Boolean)
			: [];

		const objects = Array.isArray(analysis.objects)
			? analysis.objects
					.map((obj) => {
						if (!obj || typeof obj !== 'object') return null;
						return {
							label: obj.label ?? null,
							confidence: obj.confidence ?? null,
							attributes: Array.isArray(obj.attributes)
								? obj.attributes.filter((attr) => typeof attr === 'string')
								: []
						};
					})
					.filter(Boolean)
			: [];

		const vehicleInsights = Array.isArray(analysis.vehicle_insights)
			? analysis.vehicle_insights
					.map((vehicle) => {
						if (!vehicle || typeof vehicle !== 'object') return null;
						return {
							description: vehicle.description ?? null,
							type: vehicle.type ?? null,
							color: vehicle.color ?? null,
							estimated_age: vehicle.estimated_age ?? null,
							condition: vehicle.condition ?? null,
							license_plate: vehicle.license_plate ?? null
						};
					})
					.filter(Boolean)
			: [];

		const warnings = Array.isArray(analysis.warnings)
			? analysis.warnings.filter((warning) => typeof warning === 'string')
			: [];

		const environment =
			analysis.environment && typeof analysis.environment === 'object'
				? {
						location_type: analysis.environment.location_type ?? null,
						lighting: analysis.environment.lighting ?? null,
						weather: analysis.environment.weather ?? null,
						notes: analysis.environment.notes ?? null
				  }
				: null;

		return {
			summary: analysis.summary ?? null,
			detectedText,
			detectedTextEntities,
			dominantColors,
			objects,
			vehicleInsights,
			warnings,
			environment,
			vehicle: detectVehicleDetails(analysis)
		};
	};

	const attributes = extractAttributes(parsedAnalysis);

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

	const textPool = Array.from(
		new Set([
			...(record.ocr?.raw_text ?? []),
			...(attributes.detectedText ?? []),
			...(Array.isArray(parsedAnalysis?.additional_text) ? parsedAnalysis.additional_text : [])
		])
	);
	record.ocr.raw_text = textPool;

	const mergedEntities = [...(record.ocr.entities ?? [])];
	(attributes.detectedTextEntities ?? []).forEach((entity) => {
		if (
			!mergedEntities.some(
				(existingEntity) =>
					existingEntity.text === entity.text &&
					existingEntity.category === entity.category &&
					existingEntity.side === entity.side
			)
		) {
			mergedEntities.push({
				category: entity.category ?? '',
				text: entity.text ?? '',
				confidence: entity.confidence ?? null,
				side: entity.side ?? ''
			});
		}
	});
	record.ocr.entities = mergedEntities;

	const findTextMatch = (regex, predicate) => {
		for (const text of textPool) {
			if (!text) continue;
			const match = text.match(regex);
			if (match && (predicate ? predicate(match) : true)) {
				return match[0];
			}
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

	const collectionMatches = findMultipleMatches(/\b(\d{1,3})\/(\d{1,3})\b/g);
	let globalAssortment = '';
	let subsetNumber = '';
	collectionMatches.forEach((match) => {
		const [numerator, denominator] = match.split('/');
		const denom = Number(denominator);
		if (denom >= 100) {
			if (!globalAssortment) globalAssortment = match;
		} else if (!subsetNumber) {
			subsetNumber = match;
		}
	});

	const upcCandidate = findTextMatch(/\b\d{12,13}\b/);
	const assortmentMatches = findMultipleMatches(/\b[A-Z]\d{4}\b/g);
	const batchMatch =
		findTextMatch(/[A-Z0-9]{2,}\-[A-Z0-9]+(?:\s?[A-Z0-9]+)*/) ||
		findTextMatch(/\b[A-Z]{2,}\d{2,}\b/);
	const guaranteeBadge = textPool.find((text) => text.toUpperCase().includes('GUARANTEED')) ?? '';
	const frontLogo = textPool.find((text) => text.toUpperCase().includes('HOT WHEELS')) ?? '';
	const brandMatch = textPool.find((text) => text.toUpperCase().includes('MATTEL')) ?? '';

	if (!record.item.line || record.item.line === UNKNOWN_VALUE) {
		if (frontLogo) record.item.line = 'Hot Wheels';
	}

	setIfPresent(record, ['item', 'description'], attributes.summary);

	const vehicleDetails = attributes.vehicle ?? {
		name: UNKNOWN_VALUE,
		model_code: UNKNOWN_VALUE,
		series: UNKNOWN_VALUE
	};

	if (vehicleDetails.name && vehicleDetails.name !== UNKNOWN_VALUE) {
		const parts = vehicleDetails.name.trim().split(/\s+/);
		if (parts.length > 1) {
			const make = parts.shift();
			const model = parts.join(' ') || make;
			record.vehicle.make = record.vehicle.make && record.vehicle.make !== UNKNOWN_VALUE ? record.vehicle.make : make;
			record.vehicle.base_model =
				record.vehicle.base_model && record.vehicle.base_model !== UNKNOWN_VALUE
					? record.vehicle.base_model
					: model;
			record.item.model =
				record.item.model && record.item.model !== UNKNOWN_VALUE ? record.item.model : vehicleDetails.name;
		} else {
			record.item.model =
				record.item.model && record.item.model !== UNKNOWN_VALUE ? record.item.model : vehicleDetails.name;
		}
	}

	if (vehicleDetails.series && vehicleDetails.series !== UNKNOWN_VALUE) {
		if (!record.item.series || record.item.series === UNKNOWN_VALUE) {
			record.item.series = vehicleDetails.series;
		}
	}

	if (!record.item.series || record.item.series === UNKNOWN_VALUE) {
		const seriesCandidate = textPool.find((text) => /[A-Z]-[A-Z]/.test(text) || text.toUpperCase().includes('IMPORTS'));
		if (seriesCandidate) {
			record.item.series = seriesCandidate;
		}
	}

if (!record.vehicle.condition || record.vehicle.condition === UNKNOWN_VALUE) {
	record.vehicle.condition = 'mint/new in package';
}

if (!record.inventory.status || record.inventory.status === UNKNOWN_VALUE) {
	record.inventory.status = 'pending';
}

	if (globalAssortment) {
		record.packaging.global_assortment_number = globalAssortment;
	}
	if (subsetNumber) {
		record.packaging.subset_number = subsetNumber;
	}
	if (guaranteeBadge) {
		record.packaging.guarantee_badge = guaranteeBadge;
	}
	if (frontLogo) {
		record.packaging.card_front_logo = frontLogo;
	}
	if (upcCandidate) {
		record.codes.upc = upcCandidate;
	}
	if (assortmentMatches.length) {
		record.codes.assortment = assortmentMatches[0];
	}
	if (batchMatch) {
		record.codes.batch_code = batchMatch;
	}
	if (brandMatch) {
		record.branding.brand = 'Mattel';
	}

	const countryMatch = textPool.find((text) =>
		/(malaysia|indonesia|china|thailand|vietnam)/i.test(text)
	);
	if (countryMatch) {
		const normalized = countryMatch.match(/(MALAYSIA|INDONESIA|CHINA|THAILAND|VIETNAM)/i)?.[0] ?? countryMatch;
		record.codes.country_of_origin = normalized.toUpperCase();
	}

	const regionMatch = textPool.find((text) => text.toUpperCase().includes('US ONLY') || text.toUpperCase().includes('WORLDWIDE'));
	if (regionMatch) {
		record.codes.region = regionMatch.toUpperCase();
	}

	const websiteMatches = findMultipleMatches(/\b[A-Z0-9.-]+\.(COM|NET|ORG)\b/g);
	if (websiteMatches.length) {
		const existingWebsites = new Set(record.branding.websites ?? []);
		websiteMatches.forEach((site) => existingWebsites.add(site));
		record.branding.websites = Array.from(existingWebsites);
	}

	const standardMatches = [];
	if (textPool.some((text) => text.toUpperCase().includes('ASTM'))) standardMatches.push('ASTM F963');
	if (textPool.some((text) => text.toUpperCase().includes('CE'))) standardMatches.push('CE');
	if (textPool.some((text) => text.toUpperCase().includes('UKCA'))) standardMatches.push('UKCA');
	if (standardMatches.length) {
		const uniqueStandards = new Set([...(record.compliance.standards ?? []), ...standardMatches]);
		record.compliance.standards = Array.from(uniqueStandards);
	}

	const warningText =
		textPool.find((text) => text.toUpperCase().includes('WARNING')) ??
		(attributes.warnings?.find((warning) => warning.toUpperCase().includes('WARNING')) ?? '');
	if (warningText) {
		record.compliance.age_warning = warningText;
	}

	const warrantyText = textPool.find((text) => text.toUpperCase().includes('WARRANTY')) ?? '';
	if (warrantyText) {
		record.compliance.warranty = warrantyText;
	}

	if (attributes.warnings.length) {
		const warningSet = new Set([...(record.compliance.warnings ?? []), ...attributes.warnings]);
		record.compliance.warnings = Array.from(warningSet);
	} else if (!record.compliance.warnings) {
		record.compliance.warnings = [];
	}

	if (vehicleDetails.model_code && vehicleDetails.model_code !== UNKNOWN_VALUE) {
		record.codes.internal_code = vehicleDetails.model_code;
	}

	if (attributes.dominantColors.length) {
		const primary = attributes.dominantColors[0];
		record.visual.body_color_primary.norm =
			record.visual.body_color_primary.norm && record.visual.body_color_primary.norm !== UNKNOWN_VALUE
				? record.visual.body_color_primary.norm
				: primary.name ?? primary.hex ?? record.visual.body_color_primary.norm;
		record.visual.body_color_primary.raw =
			record.visual.body_color_primary.raw && record.visual.body_color_primary.raw !== UNKNOWN_VALUE
				? record.visual.body_color_primary.raw
				: primary.hex ?? record.visual.body_color_primary.raw;
		record.visual.body_color_primary.confidence = primary.confidence ?? record.visual.body_color_primary.confidence ?? 0;
		record.visual.body_color_primary.source = record.visual.body_color_primary.source || config.openaiModel;

		const secondary = attributes.dominantColors
			.slice(1)
			.map((color) => color.name ?? color.hex)
			.filter(Boolean);
		if (secondary.length) {
			const uniqueSecondary = new Set([...(record.visual.body_color_secondary ?? []), ...secondary]);
			record.visual.body_color_secondary = Array.from(uniqueSecondary);
		}
	}

	if (attributes.objects.length) {
		const labels = attributes.objects.map((obj) => obj.label).filter(Boolean);
		if (labels.length && (!record.visual.graphics.style || record.visual.graphics.style === UNKNOWN_VALUE)) {
			record.visual.graphics.style = labels.join(', ');
		}
	}

	const sideMap = {
		1: 'front',
		2: 'back'
	};
	const mediaSide = sideMap[camera] ?? `cam-${camera}`;

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
		file_name: extra?.fileName ?? '',
		s3_key: key,
		content_type: resolvedContentType ?? '',
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

	const rawTargetKey = camera === 2 ? 'raw_back' : camera === 1 ? 'raw_front' : 'raw_other';
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
	obsoleteTopLevelKeys.forEach((key) => {
		if (key in record) {
			delete record[key];
		}
	});

	ensurePlaceholders(record);

	try {
		await dynamo.send(
			new PutCommand({
				TableName: config.dynamoTable,
				Item: record
			})
		);
		neonLog('DB', 'success', `put scan=${shortScan} key=${shortKey}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'unknown';
		neonLog('DB', 'fail', `put scan=${shortScan} err=${shorten(message, 28)}`);
		throw error;
	}

	return {
		id: scan,
		key,
		scan,
		model: config.openaiModel,
		responseId: response.id,
		record,
		analysis: parsedAnalysis,
		raw: outputText,
		attributes,
		storedAt: nowIso
	};
};
