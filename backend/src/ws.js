import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

import { config } from './config.js';
import { s3Client } from './s3.js';
import { analyzeAndStore } from './services/analyzer.js';
import { buildKey, uploadRequestSchema, uploadCompleteSchema, analyzeRequestSchema } from './validators.js';
import { neonLog, shorten } from './logger.js';

const operations = new Map();
const MAX_OPERATIONS = 50;
const OPERATION_TTL_MS = 1000 * 60 * 15;

const randomSuffix = () => crypto.randomBytes(4).toString('hex');

const pruneOperations = () => {
	const cutoff = Date.now() - OPERATION_TTL_MS;
	for (const [key, entry] of operations) {
		if (entry.updatedAt < cutoff || operations.size > MAX_OPERATIONS * 2) {
			operations.delete(key);
		}
	}
};

const recordOperationEvent = (scan, eventPayload) => {
	if (!scan) return;
	pruneOperations();
	const entry = operations.get(scan) ?? { scan, events: [], status: 'pending', updatedAt: Date.now() };
	entry.events.push(eventPayload);
	entry.updatedAt = Date.now();
	entry.status = eventPayload.event?.includes('error') ? 'error' : entry.status;
	if (eventPayload.event === 'analysis.completed') {
		entry.status = 'completed';
		entry.result = eventPayload.data ?? null;
	}
	operations.set(scan, entry);
};

const sendJSON = (socket, payload) => {
	if (socket.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify(payload));
	}
};

const sendStatus = (socket, { requestId, scan, fileName, event, message, data = {} }) => {
	const payload = {
		type: 'status',
		requestId,
		scan,
		fileName,
		event,
		message,
		data,
		timestamp: new Date().toISOString()
	};
	if (scan) {
		recordOperationEvent(scan, payload);
	}
	sendJSON(socket, payload);
};

const sendError = (socket, { requestId, error, scan }) => {
	const message = error instanceof Error ? error.message : String(error);
	sendStatus(socket, {
		requestId,
		scan,
		event: 'error',
		message,
		data: {}
	});
	sendJSON(socket, {
		type: 'error',
		requestId,
		error: { message }
	});
};

const buildFinalUrl = (key) =>
	`https://${config.bucket}.s3.${config.awsRegion}.amazonaws.com/${key}`;

export const initializeWebSocket = (server) => {
	const wss = new WebSocketServer({ server, path: '/ws' });

	const heartbeat = (socket) => {
		socket.isAlive = true;
	};

	wss.on('connection', (socket) => {
		socket.isAlive = true;
		neonLog('WS', 'success', 'client connected');

		sendJSON(socket, {
			type: 'ready',
			timestamp: new Date().toISOString()
		});

		// Provide recent operations snapshot for resilience.
		const snapshot = Array.from(operations.values())
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, MAX_OPERATIONS);
		if (snapshot.length) {
			sendJSON(socket, {
				type: 'snapshot',
				operations: snapshot
			});
		}

		socket.on('pong', () => heartbeat(socket));

		socket.on('message', async (raw) => {
			let message;
			try {
				message = JSON.parse(raw.toString());
			} catch (error) {
				sendError(socket, { requestId: undefined, error: 'Invalid JSON payload' });
				return;
			}

			const { type, requestId = crypto.randomUUID(), payload = {} } = message ?? {};

			if (!type) {
				sendError(socket, { requestId, error: 'Message type is required' });
				return;
			}

			if (type === 'ping') {
				sendJSON(socket, { type: 'pong', timestamp: new Date().toISOString() });
				return;
			}

			try {
				switch (type) {
					case 'presign_request': {
						const data = uploadRequestSchema.parse(payload);
						const keyBase = buildKey(data);
						const key = keyBase.replace(/\.(png|jpg|jpeg|gif|webp)$/i, (match) => match.toLowerCase());

						sendStatus(socket, {
							requestId,
							scan: data.scan,
							fileName: data.fileName,
							event: 'presign.started',
							message: `Generating S3 upload for ${shorten(key, 48)}`,
							data: { key }
						});

						const ttl = Math.max(1, Math.min(config.presignTtl, 900));
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

						const responsePayload = {
							url,
							fields,
							finalUrl: buildFinalUrl(key),
							expiresIn: ttl,
							key
						};

						sendStatus(socket, {
							requestId,
							scan: data.scan,
							fileName: data.fileName,
							event: 'presign.ready',
							message: 'Upload URL ready',
							data: { key }
						});

						sendJSON(socket, {
							type: 'presign_response',
							requestId,
							data: responsePayload
						});
						break;
					}
					case 'upload_complete': {
						const data = uploadCompleteSchema.parse(payload);
						sendStatus(socket, {
							requestId,
							scan: data.scan,
							fileName: data.fileName,
							event: 'analysis.queued',
							message: 'Processing upload',
							data: { key: data.key }
						});

						const result = await analyzeAndStore(data, {
							onStatus: (event, statusMessage, extra = {}) => {
								sendStatus(socket, {
									requestId,
									scan: data.scan,
									fileName: data.fileName,
									event,
									message: statusMessage,
									data: { ...extra, key: data.key }
								});
							}
						});

						sendStatus(socket, {
							requestId,
							scan: data.scan,
							fileName: data.fileName,
							event: 'analysis.completed',
							message: 'Upload processed successfully',
							data: { key: data.key }
						});

						sendJSON(socket, {
							type: 'analysis_result',
							requestId,
							data: result
						});
						break;
					}
					case 'analyze_request': {
						const data = analyzeRequestSchema.parse(payload);
						sendStatus(socket, {
							requestId,
							scan: data.scan,
							fileName: data.fileName,
							event: 'analysis.queued',
							message: 'Re-running analysis',
							data: { key: data.key }
						});

						const result = await analyzeAndStore(
							{
								...data,
								camera: data.camera ?? 1,
								contentType: data.contentType ?? 'image/png'
							},
							{
								onStatus: (event, statusMessage, extra = {}) => {
									sendStatus(socket, {
										requestId,
										scan: data.scan,
										fileName: data.fileName,
										event,
										message: statusMessage,
										data: { ...extra, key: data.key }
									});
								}
							}
						);

						sendStatus(socket, {
							requestId,
							scan: data.scan,
							fileName: data.fileName,
							event: 'analysis.completed',
							message: 'Analysis finished',
							data: { key: data.key }
						});

						sendJSON(socket, {
							type: 'analysis_result',
							requestId,
							data: result
						});
						break;
					}
					default:
						sendError(socket, { requestId, error: `Unsupported message type: ${type}` });
				}
			} catch (error) {
				neonLog('WS', 'fail', `message processing error ${error.message ?? error}`);
				sendError(socket, { requestId, error, scan: payload?.scan });
			}
		});

		socket.on('close', () => {
			neonLog('WS', 'success', 'client disconnected');
		});
	});

	const interval = setInterval(() => {
		for (const socket of wss.clients) {
			if (socket.isAlive === false) {
				socket.terminate();
				continue;
			}
			socket.isAlive = false;
			socket.ping();
		}
		pruneOperations();
	}, 30000);

	wss.on('close', () => {
		clearInterval(interval);
	});

	return wss;
};
