import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cors from 'cors';

import { config } from './config.js';
import { initializeWebSocket } from './ws.js';

const app = express();

app.use(helmet());
app.use(
	cors({
		origin: (origin, callback) => {
			if (!origin || !config.allowedOrigins.length || config.allowedOrigins.includes(origin)) {
				return callback(null, true);
			}
			return callback(new Error('Not allowed by CORS'));
		},
		credentials: true
	})
);
app.use(express.json({ limit: '6mb' }));
app.use(
	morgan('dev', {
		skip: () => process.env.NODE_ENV === 'test'
	})
);

app.get('/health', (req, res) => {
	res.json({ ok: true, uptime: process.uptime() });
});

app.use((req, res) => {
	res.status(404).json({ message: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
	console.error(err);
	const status = err.status ?? 500;
	res.status(status).json({
		message: err.message ?? 'Internal server error'
	});
});

const server = app.listen(config.port, () => {
	console.log(`Backend listening on port ${config.port}`);
});

initializeWebSocket(server);

const shutdown = () => {
	server.close(() => {
		process.exit(0);
	});
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
