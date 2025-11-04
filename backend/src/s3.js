import { S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';

export const s3Client = new S3Client({
	region: config.awsRegion,
	apiVersion: '2006-03-01'
});
