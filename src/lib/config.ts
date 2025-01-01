export const config = {
  OPENAI_API_KEY: process.env.EXTENSION_PUBLIC_OPENAI_API_KEY || '',
  WEBSOCKET_URL: process.env.EXTENSION_PUBLIC_WEBSOCKET_URL || '',
  GMAIL_CLIENT_ID: process.env.EXTENSION_PUBLIC_GMAIL_CLIENT_ID || '',
  REDIRECT_URI: process.env.EXTENSION_PUBLIC_REDIRECT_URI || '',
  TOKEN_EXCHANGE_URL: process.env.EXTENSION_PUBLIC_TOKEN_EXCHANGE_URL || '',
  REFRESH_URL: process.env.EXTENSION_PUBLIC_REFRESH_URL || '',
};