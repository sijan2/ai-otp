# Handling Google OAuth Authorization Code and Access Token Exchange in a Chrome Extension

This project demonstrates how to handle Google OAuth authorization code and access token exchange in a Chrome extension using an external server API running in a Cloudflare Worker.

## Overview

The Cloudflare Worker acts as an intermediary between the Chrome extension and the Google OAuth API. It securely exchanges the authorization code for access and refresh tokens, and provides these tokens back to the extension. This setup ensures that sensitive client secrets are kept secure and not exposed directly in the client-side code.

## Features

- Initial token exchange to get the access token and refresh token from the authorization code returned by the OAuth flow.
- Token refresh to get a new access token when the current access token expires.
- Integration with Cloudflare Worker to handle the token exchange.
- Chrome extension updates to handle the token exchange and store tokens in Chrome storage.
- Optional Firebase integration to sign the user in using the access token.

## Setup

### Cloudflare Worker

1. Set the required environment variables in `wrangler.toml`:

   ```toml
   [vars]
   CLIENT_ID = "your_client_id_here"
   CLIENT_SECRET = "your_client_secret_here"
   REDIRECT_URI = "your_redirect_uri_here"
   ```

2. Deploy the Cloudflare Worker:
   ```sh
   wrangler deploy
   ```
