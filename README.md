# Project Name

This Project was presented in [Vandy Hacks](https://devpost.com/software/quickotp) and won the Best Use of Workshop Tech

# AI-Based OTP Autofill Chrome Extension

This Chrome extension automates OTP filling and verification link handling using AI and Google Pub/Sub. It detects new otp/verifications related email, extracts OTPs or verification links, and open verification links in new tabs automatically.

# Please Watch this Demo Preview:

https://github.com/user-attachments/assets//95db5123-dced-4cb1-bc14-5a7cc19efc42

### How It Works:

1. **Google Authentication**: The extension authenticates your Google account and monitors a custom label (e.g., "OTP") in Gmail for relevant emails.

2. **Real-Time Email Monitoring**: Google Pub/Sub tracks changes in the labeled emails and sends a push notification to a webhook(backend server) when a new email arrives and push the email data(historyid) to websocket.

3. **Instant Notifications via WebSockets**: Chrome extension establish connection with websocket and recieves email history id instantly.

   ### ---> client side

4. **Email Retrieval & AI Processing**: The extension pulls the new email content, then sends it to an AI model (Gemini/OpenAI) to extract OTPs or verification links.

5. **Popup & Autofill**: The extracted OTP or link is displayed in a popup. OTPs are automatically filled, and verification links can be opened in a new tab.

6. **Client-Side Privacy**: Google auth tokens are handled entirely in the browser, ensuring they are not shared with the backend.
