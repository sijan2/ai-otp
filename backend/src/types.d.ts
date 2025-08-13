interface Env {
  // Durable Object namespace bindings
  WEBSOCKET_HUB: DurableObjectNamespace;
  // MY_DURABLE_OBJECT: DurableObjectNamespace; // Assuming this might be unused or defined elsewhere if needed
  TOKEN_STORE_DO: DurableObjectNamespace;

  // Removed KV namespace binding for token storage
  // TOKEN_STORE: KVNamespace;

  // Environment variables
  PUBSUB_TOPIC_NAME: string;
  GOOGLE_REDIRECT_URI: string;
  GOOGLE_PUBSUB_JWT_AUDIENCE: string;
  WEBSOCKET_JWT_SECRET: string;

  // Chrome Extension configuration
  CHROME_EXTENSION_ID: string; // Used to validate redirectUrl origin for OAuth flow

  // Secrets (defined via wrangler secret put)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;

  // AI Configuration
  AI_PROVIDER: 'openai' | 'gemini';  // Which AI provider to use
  OPENAI_API_KEY?: string;           // OpenAI API Key (if using OpenAI)
  OPENAI_MODEL_NAME?: string;        // Optional: OpenAI model name override
  OPENAI_ENDPOINT?: string;          // Optional: OpenAI endpoint override
  GOOGLE_API_KEY?: string;           // Gemini API Key (if using Gemini)
  GEMINI_MODEL_NAME?: string;        // Optional: Gemini model name override
  GEMINI_ENDPOINT?: string;          // Optional: Gemini endpoint override

  // Vars for Pub/Sub JWT validation
  // GOOGLE_PUBSUB_JWT_AUDIENCE is already defined
  PUBSUB_SERVICE_ACCOUNT_EMAIL?: string; // Optional: Email of the SA used for the push subscription for an extra check
}

interface TokenData {
  encryptedRefreshToken: string;
  accessToken: string;
  expiry: number; // Unix timestamp in seconds
  historyId?: string;
  googleUserId: string;
  email: string;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

interface GoogleIdTokenPayload {
  iss: string;
  azp: string;
  aud: string;
  sub: string; // This is the Google User ID
  email: string;
  email_verified: boolean;
  at_hash: string;
  name: string;
  picture: string;
  given_name: string;
  family_name: string;
  locale: string;
  iat: number;
  exp: number;
}

interface PubSubMessage {
  message: {
    attributes: Record<string, string>;
    data: string; // Base64 encoded JSON
    messageId: string;
    publishTime: string;
  };
  subscription: string;
}

interface GmailNotification {
  emailAddress: string;
  historyId: string;
}
