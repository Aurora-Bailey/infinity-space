import 'dotenv/config';

const required = (value, name) => {
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
};

const parseOrigins = (value) => {
	if (!value) return [];
	return value
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
};

const resolveDynamoTable = () => {
	const table = process.env.DYNAMO_TABLE_NAME ?? process.env.DYNAMODB_TABLE;
	return required(table, 'DYNAMO_TABLE_NAME (or DYNAMODB_TABLE)');
};

export const config = {
	port: Number(process.env.PORT ?? 4000),
	awsRegion: required(process.env.AWS_REGION, 'AWS_REGION'),
	bucket: required(process.env.S3_BUCKET_NAME, 'S3_BUCKET_NAME'),
	keyPrefix: process.env.S3_KEY_PREFIX ?? '',
	presignTtl: Number(process.env.S3_PRESIGN_TTL ?? 60),
	allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
	maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 5_000_000),
	openaiApiKey: required(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY'),
	openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
	dynamoTable: resolveDynamoTable()
};
