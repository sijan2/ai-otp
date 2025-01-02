// TypeScript definitions
interface Env {
	WEBSOCKET_SERVER_URL: string;
}

interface PubSubMessage {
	message: {
		data: string;
	};
	subscription: string;
}

interface MessageData {
	emailAddress: string;
	historyId: string;
}

interface ProcessedResult {
	status: 'success' | 'error';
	message: string;
	emailAddress?: string;
	historyId?: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		try {
			const payload = (await request.json()) as PubSubMessage;

			if (!payload.message || !payload.message.data) {
				throw new Error('Invalid Pub/Sub message format');
			}
			console.log('Received payload', payload);

			const decodedData = atob(payload.message.data);
			const messageData = JSON.parse(decodedData) as MessageData;
			console.log('Received Pub/Sub message:', messageData);

			const processedResult = await processMessage(messageData, env);
			return new Response(JSON.stringify(processedResult), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error) {
			console.error('Error processing request:', error);
			return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	},
};

async function processMessage(messageData: MessageData, env: Env): Promise<ProcessedResult> {
	try {
		const { emailAddress, historyId } = messageData;
		console.log(`New email received for: ${emailAddress}`);
		console.log(`History ID: ${historyId}`);

		// Convert WSS URL to HTTPS
		const serverUrl = env.WEBSOCKET_SERVER_URL.replace('wss://', 'https://');

		// Send HTTP POST request
		const response = await fetch(serverUrl, {
			method: 'POST',
			body: JSON.stringify({ emailAddress, historyId }),
			headers: {
				'Content-Type': 'application/json',
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to send data: ${response.statusText}`);
		}

		return {
			status: 'success',
			message: 'Processed new email notification',
			emailAddress,
			historyId,
		};
	} catch (error) {
		console.error('Error in processMessage:', error);
		throw {
			status: 'error',
			message: error instanceof Error ? error.message : 'Failed to process message',
		};
	}
}
