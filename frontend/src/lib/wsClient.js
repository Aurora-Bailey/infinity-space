import { writable } from 'svelte/store';

const DEFAULT_WS_URL =
	typeof window !== 'undefined'
		? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
		: 'ws://localhost:4000/ws';

const WS_URL = import.meta.env.VITE_WS_ENDPOINT ?? DEFAULT_WS_URL;

const connectionState = writable({
	connected: false,
	connecting: false,
	attempts: 0,
	lastError: null
});

const statusHandlers = new Set();
const snapshotHandlers = new Set();

let socket;
let reconnectAttempts = 0;
let reconnectTimer;

const pending = new Map();
const queue = [];

const getRequestId = () => {
	if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID();
	}
	return Math.random().toString(36).slice(2);
};

const MAX_RECONNECT_DELAY = 1000 * 10;

const setConnectionState = (patch) => {
	connectionState.update((current) => ({ ...current, ...patch }));
};

const flushQueue = () => {
	while (queue.length && socket?.readyState === WebSocket.OPEN) {
		socket.send(queue.shift());
	}
};

const rejectAllPending = (reason) => {
	for (const [id, entry] of pending.entries()) {
		clearTimeout(entry.timeout);
		entry.reject(reason);
		pending.delete(id);
	}
};

const handleMessage = (event) => {
	let message;
	try {
		message = JSON.parse(event.data);
	} catch (error) {
		console.error('WS parse error', error);
		return;
	}

	switch (message.type) {
		case 'ready':
			setConnectionState({ connected: true, connecting: false, lastError: null });
			break;
		case 'status':
			statusHandlers.forEach((handler) => handler(message));
			break;
		case 'snapshot':
			snapshotHandlers.forEach((handler) => handler(message.operations ?? []));
			break;
		case 'error': {
			const entry = pending.get(message.requestId);
			if (entry) {
				clearTimeout(entry.timeout);
				entry.reject(new Error(message.error?.message ?? 'Request failed'));
				pending.delete(message.requestId);
			}
			break;
		}
		default: {
			if (message.requestId && pending.has(message.requestId)) {
				const entry = pending.get(message.requestId);
				clearTimeout(entry.timeout);
				entry.resolve(message);
				pending.delete(message.requestId);
			} else if (message.type !== 'pong') {
				// Forward any other messages as status updates so the UI can observe them.
				statusHandlers.forEach((handler) => handler(message));
			}
			break;
		}
	}
};

const scheduleReconnect = () => {
	if (typeof window === 'undefined') return;
	if (reconnectTimer) return;

	reconnectAttempts += 1;
	const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
	setConnectionState({ connected: false, connecting: true, attempts: reconnectAttempts });
	reconnectTimer = window.setTimeout(() => {
		reconnectTimer = undefined;
		connect();
	}, delay);
};

export const connect = () => {
	if (typeof window === 'undefined') return;
	if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
		return;
	}

	try {
		socket = new WebSocket(WS_URL);
	} catch (error) {
		console.error('Failed to open websocket', error);
		setConnectionState({ lastError: error instanceof Error ? error.message : String(error) });
		scheduleReconnect();
		return;
	}

	setConnectionState({ connecting: true, lastError: null });

	socket.onopen = () => {
		reconnectAttempts = 0;
		setConnectionState({ connected: true, connecting: false, attempts: 0, lastError: null });
		flushQueue();
	};

	socket.onmessage = handleMessage;

	socket.onerror = (event) => {
		console.error('WebSocket error', event);
		setConnectionState({ lastError: 'WebSocket error' });
	};

	socket.onclose = () => {
		setConnectionState({ connected: false, connecting: false });
		rejectAllPending(new Error('WebSocket disconnected'));
		scheduleReconnect();
	};
};

const enqueue = (message) => {
	const encoded = JSON.stringify(message);
	if (socket?.readyState === WebSocket.OPEN) {
		socket.send(encoded);
	} else {
		queue.push(encoded);
	}
};

export const sendRequest = (type, payload = {}, { timeout = 120000 } = {}) =>
	new Promise((resolve, reject) => {
		if (typeof window === 'undefined') {
			reject(new Error('WebSocket unavailable in this environment'));
			return;
		}

	const requestId = getRequestId();
		const message = { type, requestId, payload };

		const timeoutId = window.setTimeout(() => {
			if (pending.has(requestId)) {
				pending.delete(requestId);
				reject(new Error(`Request timed out: ${type}`));
			}
		}, timeout);

		pending.set(requestId, {
			resolve,
			reject,
			timeout: timeoutId
		});

		enqueue(message);
	});

export const subscribeStatus = (handler) => {
	statusHandlers.add(handler);
	return () => statusHandlers.delete(handler);
};

export const subscribeSnapshot = (handler) => {
	snapshotHandlers.add(handler);
	return () => snapshotHandlers.delete(handler);
};

export const wsConnection = {
	subscribe: connectionState.subscribe
};

if (typeof window !== 'undefined') {
	connect();
}
