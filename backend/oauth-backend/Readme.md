## Setup
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
