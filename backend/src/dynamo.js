import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { config } from './config.js';

const dynamoClient = new DynamoDBClient({
	region: config.awsRegion
});

export const dynamo = DynamoDBDocumentClient.from(dynamoClient, {
	marshallOptions: {
		removeUndefinedValues: true
	}
});
